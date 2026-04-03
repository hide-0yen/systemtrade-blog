---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "ファンダメンタル複合スコア：財務データ5軸で銘柄の質を判定する"
featured: false
draft: false
tags:
  - 日本株
  - ファンダメンタル分析
  - J-Quants
  - Python
description: "J-Quants V2の財務データから5軸の複合スコアを算出し、テクニカル分析と組み合わせて銘柄の質を判定するシステムの設計と実装を解説する。"
---

日本株トレードエンジンのエントリー判定はテクニカル分析75指標に基づくスコアリングで行っているが、テクニカルだけでは財務的に脆弱な銘柄を排除できない。好シグナルが出ても、決算後に急落するケースが繰り返し発生していた。

JS-E8施策では、J-Quants V2 `/fins/summary` の107フィールドから5軸の複合スコアを算出し、買いシグナルの `quality_score` にボーナス/ペナルティを適用する。財務健全な銘柄には加点、脆弱な銘柄には減点することで、勝率+2〜4%の改善を目指す。

---

## テクニカル分析だけでは防げない損失

### 問題：決算後の急落

テクニカル指標が強い買いシグナルを出した銘柄が、翌日の決算発表で急落するケースがあった。

```
銘柄A: テクニカルスコア 8.5/10（強い買い）
  → 翌日決算で営業利益-30% → 株価-12%
  → 損切り発動、SL幅を超える損失

銘柄B: テクニカルスコア 7.2/10（買い）
  → 自己資本比率 15%、有利子負債過大
  → 金利上昇局面で急落 → 損切り
```

テクニカル分析は「株価の動き」を見るが、「企業の体力」は見ない。

---

## 5軸ファンダメンタルスコアリング

### 設計思想

財務データの107フィールドから、銘柄の「質」を判定するのに最も有効な5軸を選定した。

```
                  ファンダメンタル複合スコア（0〜10）
                           │
        ┌──────┬──────┬──────┬──────┐
        │      │      │      │      │
    自己資本率  BPS成長  営業CF  配当予想  EPS成長
    (安定性)  (資産成長) (現金力) (還元)  (収益成長)
     0-2点    0-2点    0-2点   0-2点   0-2点
```

### 5軸の詳細

| 軸 | 指標 | 計算方法 | 高評価基準 | 低評価基準 |
|---|------|---------|-----------|-----------|
| 1 | 自己資本比率 | `equity_to_asset_ratio` | ≥50%: 2点 | <30%: 0点 |
| 2 | BPS成長率 | `BPS(今期) / BPS(前期) - 1` | ≥10%: 2点 | <3%: 0点 |
| 3 | 営業CF | `cash_flows_from_operating_activities` | 正: 2点 | 負: 0点 |
| 4 | 配当予想 | `forecast_dividend_per_share_annual` | 正: 2点 | 0/未定: 0点 |
| 5 | EPS成長率 | `EPS(今期) / EPS(前期) - 1` | ≥20%: 2点 | <5%: 0点 |

### ランク判定とスコア調整

```
合計スコア → ランク → スコア調整
  8-10点   →  A    → +0.5（ボーナス）
  5-7点    →  B    →  0  （中立）
  3-4点    →  C    → -0.5（ペナルティ）
  0-2点    →  D    → -1.0（強ペナルティ）
```

---

## 実装

### コアクラス

```python
# _jsTradingEngine/core/fundamental_scorer.py

@dataclass(frozen=True)
class FundamentalScore:
    code: str
    total_score: float       # 0-10
    rank: str                # A/B/C/D
    adjustment: float        # スコア調整値
    equity_ratio: float
    bps_growth: float
    operating_cf_positive: bool
    dividend_positive: bool
    eps_growth: float


class FundamentalScorer:
    def __init__(self, config: FundamentalScorerConfig, db_conn):
        self._config = config
        self._db_conn = db_conn
        self._cache: dict[str, FundamentalScore] = {}

    def preload(self, trade_date: date, codes: list[str]) -> None:
        """対象銘柄の最新FY + 前年FYをDBから一括取得"""
        query = """
            SELECT code, fiscal_year,
                   equity_to_asset_ratio,
                   book_value_per_share,
                   cash_flows_from_operating_activities,
                   forecast_dividend_per_share_annual,
                   earning_per_share
            FROM jquants_financials
            WHERE code = ANY(%s)
              AND disclosed_date <= %s
            ORDER BY code, fiscal_year DESC
        """
        rows = self._db_conn.execute(query, [codes, trade_date])
        self._build_cache(rows)

    def get_score_adjustment(self, code: str) -> float:
        """スコア調整値を返す（データなしなら0）"""
        score = self._cache.get(code)
        if score is None:
            return 0.0
        return score.adjustment

    def _calculate_score(self, current_fy: dict, prev_fy: dict) -> FundamentalScore:
        """5軸スコアを計算"""
        points = 0.0

        # 軸1: 自己資本比率
        equity_ratio = current_fy.get("equity_to_asset_ratio", 0)
        if equity_ratio >= self._config.equity_ratio_thresholds[0]:
            points += 2.0
        elif equity_ratio >= self._config.equity_ratio_thresholds[1]:
            points += 1.0

        # 軸2: BPS成長率
        bps_current = current_fy.get("book_value_per_share", 0)
        bps_prev = prev_fy.get("book_value_per_share", 0)
        bps_growth = (bps_current / bps_prev - 1) * 100 if bps_prev > 0 else 0
        if bps_growth >= self._config.bps_growth_thresholds[0]:
            points += 2.0
        elif bps_growth >= self._config.bps_growth_thresholds[1]:
            points += 1.0

        # 軸3: 営業CF
        op_cf = current_fy.get("cash_flows_from_operating_activities", 0)
        op_cf_positive = op_cf > 0
        if op_cf_positive:
            points += 2.0

        # 軸4: 配当予想
        dividend = current_fy.get("forecast_dividend_per_share_annual", 0)
        dividend_positive = dividend is not None and dividend > 0
        if dividend_positive:
            points += 2.0

        # 軸5: EPS成長率
        eps_current = current_fy.get("earning_per_share", 0)
        eps_prev = prev_fy.get("earning_per_share", 0)
        eps_growth = (eps_current / eps_prev - 1) * 100 if eps_prev > 0 else 0
        if eps_growth >= self._config.eps_growth_thresholds[0]:
            points += 2.0
        elif eps_growth >= self._config.eps_growth_thresholds[1]:
            points += 1.0

        # ランク判定
        rank, adjustment = self._classify_rank(points)

        return FundamentalScore(
            code=current_fy["code"],
            total_score=points,
            rank=rank,
            adjustment=adjustment,
            equity_ratio=equity_ratio,
            bps_growth=bps_growth,
            operating_cf_positive=op_cf_positive,
            dividend_positive=dividend_positive,
            eps_growth=eps_growth,
        )
```

### トレードエンジンへの統合

```python
# _jsTradingEngine/core/trading_engine.py（統合部分）

class TradingEngine:
    def __init__(self, config: TradingConfig):
        # ... 既存の初期化 ...
        if config.fundamental_scorer.enabled:
            self._fundamental_scorer = FundamentalScorer(
                config.fundamental_scorer, self._db_conn
            )

    def _evaluate_signal(self, signal: TradeSignal) -> float:
        """シグナル評価（ファンダメンタルスコア適用）"""
        score = signal.quality_score

        # ファンダメンタル調整
        if self._fundamental_scorer is not None:
            adjustment = self._fundamental_scorer.get_score_adjustment(signal.code)
            score += adjustment
            if adjustment != 0:
                logger.info(
                    f"[JS-E8] {signal.code}: "
                    f"fundamental adjustment={adjustment:+.1f}, "
                    f"score {signal.quality_score:.1f} -> {score:.1f}"
                )

        return score
```

---

## パラメータ設計

```json
{
  "fundamental_scorer": {
    "enabled": false,
    "filter_mode": "penalty",
    "equity_ratio_thresholds": [50, 30],
    "bps_growth_thresholds": [10, 3],
    "operating_cf_require_positive": true,
    "dividend_require_positive": true,
    "eps_growth_thresholds": [20, 5],
    "rank_a_min_score": 8,
    "rank_b_min_score": 5,
    "rank_c_min_score": 3,
    "bonus_rank_a": 0.5,
    "penalty_rank_c": -0.5,
    "penalty_rank_d": -1.0,
    "always_allow_if_no_data": true
  }
}
```

**`always_allow_if_no_data: true`** は重要な設計判断。IPO直後の銘柄など財務データが未取得の場合、ペナルティを適用せず通過させる。データ不足で機会損失を起こさないための安全弁。

---

## テスト戦略

```
テスト構成（72テスト）:
├── 5軸個別計算テスト（25件）
│   ├── 自己資本比率の閾値境界テスト
│   ├── BPS成長率の計算精度テスト
│   ├── 営業CF符号判定テスト
│   ├── 配当予想のNone/0/正値テスト
│   └── EPS成長率の前年比計算テスト
├── ランク判定テスト（12件）
│   ├── 境界値テスト（7.9→B, 8.0→A）
│   └── 全ランクのスコア調整値テスト
├── preloadテスト（15件）
│   ├── 通常取得テスト
│   ├── 複数FYの最新選択テスト
│   ├── データ未存在銘柄のフォールバック
│   └── 大量銘柄（4300件）のパフォーマンス
├── 統合テスト（12件）
│   ├── TradingEngineとの統合
│   ├── enabled=falseで無影響の確認
│   └── 他フィルター（VWAP, PEAD等）との併用
└── 回帰テスト
    └── 既存テスト全件PASS確認
```

---

## 期待効果

| 指標 | Before | After（予測） |
|------|--------|-------------|
| 勝率 | 48% | 50〜52%（+2〜4%） |
| ランクD銘柄の損失 | 発生 | 排除またはペナルティで回避 |
| 決算急落による損失 | 月1-2回 | 月0-1回 |

---

## まとめ

1. テクニカル分析75指標に加え、財務データ5軸（自己資本比率・BPS成長・営業CF・配当・EPS成長）の複合スコアで銘柄の「質」を判定する。ランクA(+0.5)〜D(-1.0)のスコア調整により、財務脆弱銘柄への投資を構造的に抑制

2. J-Quants V2 `/fins/summary` の107フィールドから必要な5フィールドを選定。`preload()` でセッション開始時にDB一括取得し、トレード中のDB負荷を排除する設計

3. `enabled=false` デフォルト + `always_allow_if_no_data=true` により、後方互換性とIPO銘柄の機会損失回避を両立。NEW-04 PEADフィルターのGo/No-Go判定後に有効化予定

---

## 関連記事

- 【日本株】PEAD多軸サプライズ拡張：EPS単軸からEPS+売上高+営業利益の3軸判定へ
- 【日本株】VWAP乖離エントリーフィルター：「寄天」損失を構造的に排除する
- 【日本株】外国人投資家フロー連動フィルター：需給環境でエントリーを制御する
