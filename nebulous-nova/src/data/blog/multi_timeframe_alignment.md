---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "マルチタイムフレーム整合性ボーナス：H4エントリーにD足トレンド方向の確認を加える"
featured: false
draft: false
tags:
  - FX
  - マルチタイムフレーム
  - テクニカル分析
  - ADX
  - シグナル評価
description: "H4足エントリーシグナルにD足トレンド方向の整合性ボーナス（+0.3〜+0.5）を加算し、上位足と一致する惜しいシグナルを救済する設計と実装。"
---

FXスイングトレードのエントリーはH4足（4時間足）のテクニカル指標411種のスコアリングで判定しているが、H4足だけを見ていると上位足（D足＝日足）のトレンド方向と逆行するエントリーが発生する。本施策では、H4エントリーシグナルが同一通貨ペア・同一日付のD足トレンド方向と一致する場合に、スコアボーナス（+0.3〜+0.5）を加算する。

スコア1.6-1.8の「惜しいシグナル」がD足トレンド方向一致時に閾値1.9を超えてエントリー可能となり、勝率+2〜5%の改善を目指す。

---

## 問題：H4足だけでは見えない逆行エントリー

### シグナルスコアの分布

```
MIN_TOTAL_SCORE = 1.9（エントリー閾値）

  1.5  1.6  1.7  1.8  1.9  2.0  2.1  2.2
  |    |    |    |    |    |    |    |
  ─────[惜しいゾーン]──┤───[エントリー]───
       ↑ D足方向一致なら
         ボーナスで閾値突破
```

バックテストの分析で、スコア1.6-1.8のシグナルの中にD足トレンドと方向が一致しているものが多数存在することが判明。これらは「H4足のスコアは僅かに足りないが、大局的なトレンドは味方している」ケースであり、エントリーの価値がある。

### D足トレンド方向の重要性

```
ケース1: H4買いシグナル + D足上昇トレンド → 順張り（勝率高い）
ケース2: H4買いシグナル + D足下降トレンド → 逆張り（勝率低い）
```

ADX（Average Directional Index）でD足のトレンド強度を判定し、方向一致に応じたボーナスを加算する。

---

## アーキテクチャ設計

### UnifiedAnalyzer/TriggerFileGenerator分離の遵守

本施策は統合分析アーキテクチャの原則を厳守する。ボーナス計算は `unified_analyzer.py`（指標計算のみ）でも `TriggerFileGenerator.py`（条件フィルタのみ）でもなく、`signal_detector` 層で適用する。

```
_calcFXAnalyticsDatas/unified_analyzer.py
  → 411指標計算（D足ADX, +DI, -DIも計算済み）
  → ボーナス計算はしない

_calcFXAnalyticsDatas/*TriggerFileGenerator.py
  → 条件フィルタ（MIN_TOTAL_SCORE判定）
  → ボーナス計算はしない

_fxTradingEngine/core/shared/signal_detector.py
  → mtf_bonus_fn パラメータでボーナス関数を注入 ← ここ
  → スコア + ボーナス ≥ 1.9 でエントリー判定
```

---

## 実装

### コア：MtfConsistencyBonusCalculator

```python
# _fxTradingEngine/core/shared/mtf_consistency_bonus.py

@dataclass(frozen=True)
class MtfConsistencyBonusConfig:
    enabled: bool = False
    adx_threshold: float = 20.0        # D足トレンド判定のADX閾値
    strong_adx_threshold: float = 30.0  # 強トレンド判定のADX閾値
    trend_align_bonus: float = 0.3      # 方向一致ボーナス
    strong_trend_bonus: float = 0.5     # 強トレンド時ボーナス


@dataclass(frozen=True)
class DailyTrend:
    adx: float
    plus_di: float
    minus_di: float
    direction: str  # "bullish" | "bearish" | "neutral"


class MtfConsistencyBonusCalculator:
    def __init__(self, config: MtfConsistencyBonusConfig):
        self._config = config

    def classify_trend(self, adx: float, plus_di: float, minus_di: float) -> DailyTrend:
        """D足のトレンドを分類"""
        if adx < self._config.adx_threshold:
            direction = "neutral"
        elif plus_di > minus_di:
            direction = "bullish"
        else:
            direction = "bearish"

        return DailyTrend(
            adx=adx,
            plus_di=plus_di,
            minus_di=minus_di,
            direction=direction,
        )

    def calculate_bonus(
        self,
        signal_direction: str,  # "buy" | "sell"
        daily_trend: DailyTrend,
    ) -> float:
        """マルチTF整合性ボーナスを計算"""
        if not self._config.enabled:
            return 0.0

        if daily_trend.direction == "neutral":
            return 0.0

        # 方向一致チェック
        is_aligned = (
            (signal_direction == "buy" and daily_trend.direction == "bullish")
            or (signal_direction == "sell" and daily_trend.direction == "bearish")
        )

        if not is_aligned:
            return 0.0

        # 強トレンドなら高ボーナス
        if daily_trend.adx >= self._config.strong_adx_threshold:
            return self._config.strong_trend_bonus  # +0.5

        return self._config.trend_align_bonus  # +0.3
```

### バックテストエンジンでのD足キャッシュ

```python
# _fxTradingEngine/core/shared/backtest_engine.py（追加部分）

class BaseBacktestEngine:
    def _build_daily_trend_cache(
        self,
        pair: str,
        start_date: date,
        end_date: date,
    ) -> dict[date, DailyTrend]:
        """D足データからトレンドキャッシュを構築"""
        daily_df = self._load_daily_data(pair, start_date, end_date)

        cache: dict[date, DailyTrend] = {}
        for _, row in daily_df.iterrows():
            dt = row["DateTime"].date()
            cache[dt] = self._mtf_calculator.classify_trend(
                adx=row["ADX_14"],
                plus_di=row["PLUS_DI_14"],
                minus_di=row["MINUS_DI_14"],
            )

        return cache
```

### シグナル検出器への注入

```python
# _fxTradingEngine/core/shared/signal_detector.py（変更部分）

class SignalDetector:
    def __init__(
        self,
        config: SignalDetectorConfig,
        mtf_bonus_fn: Callable[[str, date], float] | None = None,
    ):
        self._config = config
        self._mtf_bonus_fn = mtf_bonus_fn

    def evaluate_signal(
        self,
        pair: str,
        direction: str,
        base_score: float,
        signal_date: date,
    ) -> float:
        """シグナルを評価（MTFボーナス適用）"""
        bonus = 0.0
        if self._mtf_bonus_fn is not None:
            bonus = self._mtf_bonus_fn(direction, signal_date)

        total_score = base_score + bonus

        if bonus > 0:
            logger.info(
                f"[NEW-32] {pair} {direction}: "
                f"base={base_score:.2f} + mtf_bonus={bonus:.2f} "
                f"= {total_score:.2f}"
            )

        return total_score
```

---

## パラメータ設計

```python
MtfConsistencyBonusConfig(
    enabled=False,              # デフォルト無効（後方互換）
    adx_threshold=20.0,         # D足ADX ≥ 20 でトレンドあり判定
    strong_adx_threshold=30.0,  # D足ADX ≥ 30 で強トレンド判定
    trend_align_bonus=0.3,      # 通常トレンド一致: +0.3
    strong_trend_bonus=0.5,     # 強トレンド一致: +0.5
)
```

### パラメータの根拠

| パラメータ | 値 | 根拠 |
|-----------|-----|------|
| `adx_threshold` | 20.0 | ADXの標準的なトレンド判定閾値。20以上で方向性あり |
| `strong_adx_threshold` | 30.0 | 強トレンドの一般的な基準値 |
| `trend_align_bonus` | 0.3 | スコア1.6→1.9で閾値到達。0.4だと1.5でも通過してしまう |
| `strong_trend_bonus` | 0.5 | 強トレンド時は積極的に取る。スコア1.4→1.9は許容 |

---

## テスト戦略

```
テスト構成（29 unit + 10 integration + 4196 regression）:
├── MtfConsistencyBonusCalculator テスト（15件）
│   ├── classify_trend: ADX閾値境界テスト
│   ├── calculate_bonus: 方向一致/不一致
│   ├── calculate_bonus: neutral（ボーナスなし）
│   ├── calculate_bonus: strong_trend判定
│   └── enabled=false で常に0
├── DailyTrend テスト（6件）
│   ├── frozen dataclass の不変性
│   ├── 各direction値の生成
│   └── 境界値（ADX=20.0）
├── Config テスト（8件）
│   ├── デフォルト値の確認
│   ├── カスタム値のオーバーライド
│   └── 不正値のバリデーション
├── BacktestEngine 統合テスト（10件）
│   ├── D足キャッシュ構築
│   ├── ボーナス適用後のスコア変動
│   ├── enabled=false で既存動作維持
│   └── 通貨ペア別のトレンド判定
└── 回帰テスト
    └── 既存4,196テスト全件PASS
```

---

## 期待効果

| 指標 | Before | After（予測） |
|------|--------|-------------|
| 勝率 | 48% | 50〜53%（+2〜5%） |
| エントリー数 | 100%（基準） | 110〜120%（惜しいシグナルの救済） |
| D足逆行エントリー | 発生 | スコアボーナスなし→閾値未達で除外 |

---

## まとめ

1. H4エントリーシグナルにD足トレンド方向の整合性ボーナス（+0.3〜+0.5）を加算する仕組みを実装した。ADX 20以上でトレンドあり、30以上で強トレンドと判定し、シグナル方向と一致する場合にのみボーナスを付与

2. UnifiedAnalyzer/TriggerFileGenerator分離の原則を厳守し、ボーナス計算はsignal_detector層で適用。`mtf_bonus_fn` パラメータによる関数注入で、既存アーキテクチャを変更せずに機能追加

3. `enabled=false` デフォルトで後方互換性を完全維持。29 unit + 10 integration + 4,196 regression テスト全件PASS。バックテストでの有効性確認後に有効化する段階的導入設計
