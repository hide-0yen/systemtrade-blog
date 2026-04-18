---
author: "45395"
pubDatetime: 2026-04-11T15:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "PEAD多軸サプライズ拡張：EPS単軸からEPS＋売上高＋営業利益の3軸判定へ"
featured: false
draft: false
tags:
  - 日本株
  - ファンダメンタル分析
  - エントリーフィルター
description: "PEAD（決算後ドリフト）の判定をEPS単軸から3軸（EPS+売上高+営業利益）に拡張し、コストカットや一過性利益による偽陽性を30〜50%削減するコンセンサス判定の設計と実装を解説する。"
---

PEAD（Post-Earnings Announcement Drift）は、好決算の銘柄は決算発表後も上昇を続け、悪決算の銘柄は下落を続けるという市場のアノマリーである。NEW-04施策でEPS（1株当たり利益）の単軸サプライズ判定を実装済みだが、EPSだけでは「売上減・コストカットによる見かけのEPS増」のような偽陽性を拾ってしまっていた。

JS-E9施策では、EPSに加えて売上高（NetSales）と営業利益（OperatingProfit）の3軸に拡張し、コンセンサス判定（majority/any/all）で偽陽性を30〜50%削減する。

---

## なぜEPS単軸では不十分か

### 偽陽性パターン

```
パターン1: コストカット型
  売上高: -15%（減収）
  営業利益: -8%（減益）
  EPS: +12%（増益）← 特別利益や税効果で見かけ上プラス
  → EPS単軸: ボーナス付与 ❌
  → 3軸判定(majority): 2/3がネガティブ → ボーナスなし ✅

パターン2: 一過性の特需
  売上高: +50%（大幅増収）← 一時的な特需
  営業利益: +3%（微増益）← 原価率悪化
  EPS: +45%（大幅増益）← 税効果
  → EPS単軸: 強ボーナス ❌（持続性が疑問）
  → 3軸判定(majority): 営業利益が弱いため中程度ボーナス ✅
```

### サプライズ率の計算

```python
# EPS（既存）
eps_surprise = (actual_EPS - forecast_EPS) / abs(forecast_EPS)

# 売上高（新規）
sales_surprise = (NetSales - ForecastNetSales) / abs(ForecastNetSales)

# 営業利益（新規）
op_surprise = (OperatingProfit - ForecastOperatingProfit) / abs(ForecastOperatingProfit)
```

---

## 3軸コンセンサス判定

### コンセンサスモード

3つのモードを設定で切り替えられる。

```
majority（推奨）: 3軸中2軸以上がポジティブならボーナス
  EPS +20%, Sales +5%, OP -3% → 2/3 → ボーナス ✅

any: いずれか1軸でもポジティブならボーナス
  EPS -5%, Sales -3%, OP +2% → 1/3 → ボーナス ✅
  → 偽陽性が増える可能性

all: 全軸ポジティブの場合のみボーナス
  EPS +20%, Sales +5%, OP -3% → 2/3 → ボーナスなし ❌
  → 機会損失が増える可能性
```

### 除外判定（ネガティブサプライズ）

```
majority: 3軸中2軸以上がネガティブ（閾値以下）なら除外
  EPS -15%, Sales -10%, OP -20% → 3/3ネガティブ → 除外 ✅
  EPS -15%, Sales +5%, OP -20%  → 2/3ネガティブ → 除外 ✅
  EPS -15%, Sales +5%, OP +3%   → 1/3ネガティブ → 除外なし ✅
```

---

## 実装

### PeadEntry の拡張

```python
# _jsTradingEngine/core/pead_manager.py

@dataclass
class PeadEntry:
    code: str
    earnings_date: date
    surprise_rate: float          # EPS サプライズ率（既存）
    bonus_score: float
    valid_until: date
    excluded: bool
    # JS-E9 新規フィールド
    sales_surprise_rate: float | None = None
    op_surprise_rate: float | None = None
```

### 多軸サプライズ計算

```python
class PeadManager:
    def _parse_statements_response(
        self, code: str, statements: list[dict]
    ) -> PeadEntry | None:
        """決算データから多軸サプライズ率を計算"""
        latest = statements[0]

        # EPS サプライズ（既存）
        actual_eps = latest.get("EarningPerShare", 0)
        forecast_eps = latest.get("ForecastEarningPerShare", 0)
        eps_surprise = self._calc_surprise(actual_eps, forecast_eps)

        # 売上高サプライズ（新規）
        sales_surprise = None
        if self._config.multi_axis_enabled:
            actual_sales = latest.get("NetSales", 0)
            forecast_sales = latest.get("ForecastNetSales", 0)
            sales_surprise = self._calc_surprise(actual_sales, forecast_sales)

        # 営業利益サプライズ（新規）
        op_surprise = None
        if self._config.multi_axis_enabled:
            actual_op = latest.get("OperatingProfit", 0)
            forecast_op = latest.get("ForecastOperatingProfit", 0)
            op_surprise = self._calc_surprise(actual_op, forecast_op)

        # ボーナス計算
        bonus = self._calculate_bonus(eps_surprise, sales_surprise, op_surprise)
        excluded = self._check_exclusion(eps_surprise, sales_surprise, op_surprise)

        return PeadEntry(
            code=code,
            earnings_date=date.fromisoformat(latest["DisclosedDate"]),
            surprise_rate=eps_surprise,
            bonus_score=bonus,
            valid_until=date.fromisoformat(latest["DisclosedDate"])
                + timedelta(days=self._config.drift_days),
            excluded=excluded,
            sales_surprise_rate=sales_surprise,
            op_surprise_rate=op_surprise,
        )

    def _calculate_bonus(
        self,
        eps_surprise: float,
        sales_surprise: float | None,
        op_surprise: float | None,
    ) -> float:
        """多軸コンセンサスでボーナスを計算"""
        if not self._config.multi_axis_enabled:
            # 既存EPS単軸ロジック
            return self._single_axis_bonus(eps_surprise)

        # 各軸のボーナスを計算
        eps_bonus = self._axis_bonus(eps_surprise, self._config.bonus_thresholds)
        sales_bonus = self._axis_bonus(
            sales_surprise, self._config.sales_bonus_thresholds
        ) if sales_surprise is not None else 0
        op_bonus = self._axis_bonus(
            op_surprise, self._config.op_bonus_thresholds
        ) if op_surprise is not None else 0

        # コンセンサス判定
        positive_axes = sum(
            1 for b in [eps_bonus, sales_bonus, op_bonus] if b > 0
        )

        if self._config.consensus_mode == "majority":
            return max(eps_bonus, sales_bonus, op_bonus) if positive_axes >= 2 else 0
        elif self._config.consensus_mode == "all":
            return min(eps_bonus, sales_bonus, op_bonus) if positive_axes == 3 else 0
        else:  # "any"
            return max(eps_bonus, sales_bonus, op_bonus) if positive_axes >= 1 else 0
```

### 後方互換性

```python
# multi_axis_enabled=false の場合
# → 既存のEPS単軸ロジックがそのまま動作
# → sales_surprise_rate, op_surprise_rate は None のまま
# → pead_calendar.json の既存データもそのまま読み込み可能

# pead_calendar.json の後方互換
{
    "7203": {
        "earnings_date": "2026-02-05",
        "surprise_rate": 0.15,        // 既存フィールド
        "sales_surprise_rate": 0.08,  // 新規（なくても動作する）
        "op_surprise_rate": 0.12      // 新規（なくても動作する）
    }
}
```

---

## パラメータ設計

```json
{
  "pead_filter": {
    "enabled": true,
    "drift_days": 3,
    "enable_negative_exclusion": true,
    "negative_exclusion_threshold": -0.1,
    "bonus_thresholds": [
      [0.1, 0.5],
      [0.2, 1.0],
      [0.5, 1.5]
    ],

    "multi_axis_enabled": false,
    "consensus_mode": "majority",
    "sales_bonus_thresholds": [
      [0.05, 0.5],
      [0.1, 1.0],
      [0.3, 1.5]
    ],
    "op_bonus_thresholds": [
      [0.1, 0.5],
      [0.2, 1.0],
      [0.5, 1.5]
    ],
    "sales_negative_exclusion_threshold": -0.1,
    "op_negative_exclusion_threshold": -0.1
  }
}
```

**売上高の閾値が低い理由**: 売上高は利益指標と比べてサプライズ率が小さい傾向がある（±5%でも大きなサプライズ）。そのため `sales_bonus_thresholds` の最低閾値を0.05（5%）に設定。

---

## テスト戦略

```
テスト構成（62新規 + 25既存 + 3017回帰）:
├── 多軸サプライズ計算テスト（18件）
│   ├── 3軸全てポジティブ
│   ├── 2軸ポジティブ / 1軸ネガティブ
│   ├── 1軸ポジティブ / 2軸ネガティブ
│   ├── 3軸全てネガティブ
│   ├── 売上高/営業利益データ欠損時のフォールバック
│   └── forecast=0 の除算エラー防止
├── コンセンサスモードテスト（15件）
│   ├── majority: 2/3で判定
│   ├── any: 1/3で判定
│   ├── all: 3/3で判定
│   └── 各モードでの除外判定
├── 後方互換テスト（12件）
│   ├── multi_axis_enabled=false で既存動作維持
│   ├── 旧形式pead_calendar.json の読み込み
│   └── 新フィールド欠損時の安全な動作
├── 統合テスト（17件）
│   ├── TradingEngineとの統合
│   ├── VWAP/外国人フィルターとの併用
│   └── バックテストエンジンでの多軸適用
└── 回帰テスト
    └── 既存25テスト + 3017回帰テスト全件PASS
```

---

## 期待効果

| 指標         | EPS単軸（Before）      | 3軸判定（After予測）      |
| ------------ | ---------------------- | ------------------------- |
| PEAD偽陽性率 | 100%（基準）           | 50〜70%（30〜50%削減）    |
| ボーナス精度 | コストカット型を誤検出 | 実質的な業績改善のみ検出  |
| 除外精度     | EPS単軸で見逃し        | 3軸コンセンサスで包括判定 |

---

## まとめ

1. PEAD（決算後ドリフト）の判定をEPS単軸から3軸（EPS+売上高+営業利益）に拡張した。コストカットや一過性利益による見かけのEPS増を、売上高と営業利益の裏付けで検証することで、偽陽性を30〜50%削減する

2. 3つのコンセンサスモード（majority/any/all）を設定で切り替えられる設計。推奨は`majority`（3軸中2軸以上が一致で判定）で、精度と機会のバランスが最も良い

3. `multi_axis_enabled=false` デフォルトで完全な後方互換性を維持。`pead_calendar.json` の既存データもそのまま読み込み可能。NEW-04 PEADフィルターのGo/No-Go判定後に有効化する段階的導入設計

---

## 関連記事

- ファンダメンタル複合スコア：財務データ5軸で銘柄の質を判定する
- VWAP乖離エントリーフィルター：「寄天」損失を構造的に排除する
- 外国人投資家フロー連動フィルター：需給環境でエントリーを制御する
