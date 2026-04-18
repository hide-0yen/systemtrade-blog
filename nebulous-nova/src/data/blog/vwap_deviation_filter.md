---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "VWAP乖離エントリーフィルター：「寄天」損失を構造的に排除する"
featured: false
draft: false
tags:
  - 日本株
  - VWAP
  - エントリーフィルター
  - リスク管理
description: "VWAP乖離率で「寄天」（寄り付き天井）損失を構造的に排除する2段階フィルターの設計と実装。penaltyモードとblockモードの使い分けを解説する。"
---

日本株のシステムトレードで頻発する「寄天」（寄り付き天井）損失を、VWAP（出来高加重平均価格）乖離フィルターで構造的に排除する。VWAPを大幅に上回る水準での買いエントリーは統計的に負の期待リターンとなるため、ペナルティまたはブロックを適用する。

JS-E5施策では2段階の閾値（通常2%/重度5%）を設定し、penalty（スコア減算）とblock（エントリー拒否）の2モードを実装した。

---

## 「寄天」問題とは

### 典型的な損失パターン

```
株価
  ↑
  │    ★ 寄付（始値）= 本日最高値
  │   ╱╲
  │  ╱  ╲
  │ ╱    ╲
  │╱      ╲───── VWAP
  │        ╲
  │         ╲
  │          ╲
  │           ★ 終値
  ├──────────────→ 時間
  9:00        15:00

テクニカルスコア: 8.2/10（前日の分析で算出）
寄付で買い注文 → VWAPから+3.5%乖離
→ 当日中にVWAPに収束 → 損切り発動
```

前日のテクニカル分析で強い買いシグナルが出ていても、翌朝の寄付が異常に高い場合、そこからの下落で損失を被る。VWAPからの乖離率が大きいほど、この「平均回帰」のリスクが高い。

---

## VWAP乖離率によるフィルタリング

### VWAP（出来高加重平均価格）とは

```python
# VWAPの計算
VWAP = Σ(Price_i × Volume_i) / Σ(Volume_i)

# 乖離率の計算
deviation_pct = (current_price - prev_vwap) / prev_vwap * 100
```

VWAPは「その日の取引の平均的な約定価格」を表す。VWAPを大幅に上回る価格で買うことは、「市場参加者の平均より割高に買う」ことを意味する。

### 2段階フィルタリング

```
乖離率        判定           アクション
──────────────────────────────────────
0〜2%        正常           そのまま通過
2〜5%        注意（penalty） スコア -1.5
5%〜         危険（severe）  スコア -3.0（またはblock）
```

---

## 実装

### VwapDeviationFilter

```python
# _jsTradingEngine/core/vwap_deviation_filter.py

class VwapDeviationFilter:
    def __init__(self, config: VwapDeviationFilterConfig):
        self._config = config

    def calculate_deviation_pct(
        self, current_price: float, prev_vwap: float
    ) -> float:
        """VWAP乖離率を計算"""
        if prev_vwap <= 0:
            return 0.0
        return (current_price - prev_vwap) / prev_vwap * 100

    def get_score_penalty(
        self, current_price: float, prev_vwap: float
    ) -> float:
        """ペナルティスコアを返す（0以下の値）"""
        if not self._config.enabled:
            return 0.0

        deviation = self.calculate_deviation_pct(current_price, prev_vwap)

        # 買いの場合のみフィルタリング（VWAPより高い=割高）
        if deviation <= 0:
            return 0.0

        if deviation >= self._config.severe_threshold_pct:
            return self._config.severe_penalty_score  # -3.0
        elif deviation >= self._config.deviation_threshold_pct:
            return self._config.penalty_score  # -1.5

        return 0.0

    def check_entry_allowed(
        self, current_price: float, prev_vwap: float
    ) -> bool:
        """エントリーを許可するか（blockモード用）"""
        if not self._config.enabled:
            return True

        if self._config.filter_mode != "block":
            return True  # penaltyモードでは常に許可

        deviation = self.calculate_deviation_pct(current_price, prev_vwap)

        if deviation >= self._config.severe_threshold_pct:
            logger.warning(
                f"[JS-E5] BLOCKED: VWAP deviation {deviation:.1f}% "
                f">= {self._config.severe_threshold_pct}%"
            )
            return False

        return True
```

### トレードエンジンへの統合

```python
# _jsTradingEngine/core/trading_engine.py（統合部分）

class TradingEngine:
    def _check_entry_filters(
        self, signal: TradeSignal, market_data: MarketData
    ) -> tuple[bool, float]:
        """エントリーフィルターを適用"""
        total_penalty = 0.0

        # JS-E5: VWAP乖離フィルター
        if self._vwap_filter is not None:
            # blockモードチェック
            if not self._vwap_filter.check_entry_allowed(
                market_data.open_price, market_data.prev_vwap
            ):
                return False, 0.0

            # penaltyモードチェック
            penalty = self._vwap_filter.get_score_penalty(
                market_data.open_price, market_data.prev_vwap
            )
            if penalty < 0:
                logger.info(
                    f"[JS-E5] {signal.code}: VWAP penalty={penalty:.1f}, "
                    f"deviation={self._vwap_filter.calculate_deviation_pct(market_data.open_price, market_data.prev_vwap):.1f}%"
                )
            total_penalty += penalty

        # 他のフィルターも同様に適用...

        return True, total_penalty
```

---

## パラメータ設計

```json
{
  "vwap_deviation_filter": {
    "enabled": false,
    "filter_mode": "penalty",
    "deviation_threshold_pct": 2.0,
    "penalty_score": -1.5,
    "severe_threshold_pct": 5.0,
    "severe_penalty_score": -3.0
  }
}
```

### penalty vs block の使い分け

| モード    | 動作                                           | 適するケース     |
| --------- | ---------------------------------------------- | ---------------- |
| `penalty` | スコアから減算。他の要因が強ければエントリー可 | 通常運用（推奨） |
| `block`   | 重度乖離時にエントリー完全拒否                 | 保守的な運用     |

`penalty` モードでは、VWAP+3%乖離でもテクニカルスコアが十分高ければ（スコア >= 1.9 + 1.5 = 3.4）エントリー可能。本当に強いシグナルまでは排除しない。

---

## テスト戦略

```
テスト構成（53 unit + 22 integration + 3092 regression）:
├── calculate_deviation_pct テスト（10件）
│   ├── 正の乖離（割高）
│   ├── 負の乖離（割安）
│   ├── ゼロ乖離
│   ├── prev_vwap = 0 の防御
│   └── 大きな乖離値
├── get_score_penalty テスト（15件）
│   ├── 閾値未満（ペナルティなし）
│   ├── 通常閾値境界（2.0%）
│   ├── 重度閾値境界（5.0%）
│   ├── 売り方向（フィルタリングなし）
│   └── enabled=false で常に0
├── check_entry_allowed テスト（12件）
│   ├── penaltyモード（常にTrue）
│   ├── blockモード + 閾値未満
│   ├── blockモード + 重度乖離
│   └── enabled=false で常にTrue
├── 統合テスト（16件）
│   ├── TradingEngineでのフィルター適用
│   ├── 他フィルターとの併用
│   ├── バックテストエンジン対応
│   └── ログ出力確認
└── 回帰テスト
    └── 既存3,092テスト全件PASS
```

---

## 期待効果

| 指標             | Before  | After（予測）             |
| ---------------- | ------- | ------------------------- |
| 勝率             | 48%     | 51〜53%（+3〜5%）         |
| 寄天による損失   | 月2-3回 | 月0-1回                   |
| 見送りトレード数 | なし    | 月1-2件（VWAP乖離で除外） |

---

## まとめ

1. VWAP乖離率で「寄天」損失を構造的に排除する。2段階の閾値（通常2%→ペナルティ-1.5、重度5%→ペナルティ-3.0）により、VWAPを大幅に上回る水準での買いエントリーを抑制

2. penalty（スコア減算）とblock（エントリー拒否）の2モードを実装。推奨はpenaltyモードで、テクニカルスコアが十分に強いシグナルまでは排除しない設計

3. `enabled=false` デフォルトで後方互換性を完全維持。53 unit + 22 integration + 3,092 regression テスト全件PASS。バックテスト結果に基づき有効化を判断

---

## 関連記事

- マルチタイムフレーム整合性ボーナス：H4エントリーにD足トレンド方向の確認を加える
- 外国人投資家フロー連動フィルター：需給環境でエントリーを制御する
- ファンダメンタル複合スコア：財務データ5軸で銘柄の質を判定する
