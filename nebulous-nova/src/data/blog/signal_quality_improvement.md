---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "シグナル品質の地道な改善：スコア計算整合とGranville新カテゴリ"
featured: false
draft: false
tags:
  - FX
  - シグナル品質
  - テクニカル指標
  - バグ修正
description: "FX自動売買エンジンで全9通貨ペアのTotalScore計算を統一し破産確率0.00%を達成した記録と、テクニカル指標カテゴリへグランビルの法則を正式追加したシグナル品質改善の実装解説。"
---

自動売買のシグナル品質は、派手な新指標の追加だけでなく、既存のスコア計算の整合性確認やカテゴリ分類の見直しといった「地味な改善」によっても大きく変わる。

本記事では、FXエンジンで実施した2つの品質改善施策を記録する。

1. **TotalScore計算整合（FX-P-TOTALSCORE-SYNC）**: 全9通貨ペアのスコア計算ロジックを統一し、破産確率0.00%を達成
2. **Granville新カテゴリ（FX-P-GRANVILLE）**: グランビルの法則をテクニカル指標カテゴリに正式追加

---

## TotalScore計算整合（FX-P-TOTALSCORE-SYNC）

### 問題の発見

モンテカルロシミュレーションで破産確率を検証していた際、一部の通貨ペアでスコア計算のロジックが微妙に異なっていることに気づいた。

```
EUR_JPY: total_score = RSI + MACD + SMA_CROSS + ADX + VOLUME
GBP_JPY: total_score = RSI + MACD + SMA_CROSS + ADX + VOLUME  ← 同じ

AUD_JPY: total_score = RSI + MACD + SMA_CROSS + ADX          ← VOLUMEが欠落！
```

FXの出来高データ（Volume）は株式と異なり、ブローカーごとに値が異なる不安定なデータだ。ある時点で「出来高は信頼性が低い」と判断し、AUD_JPYのスコアからVOLUMEを除外した。しかし、その変更が全ペアに反映されず、不整合が残っていた。

### 修正方針

方針は「全ペアで完全に同一のスコア計算ロジックを使う」だ。ペアごとの例外処理は、メンテナンスの地雷になる。

```python
# Before: ペアごとに異なるスコア計算
def calculate_score_aud_jpy(indicators):
    return indicators["RSI"] + indicators["MACD"] + indicators["SMA_CROSS"] + indicators["ADX"]

def calculate_score_eur_jpy(indicators):
    return indicators["RSI"] + indicators["MACD"] + indicators["SMA_CROSS"] + indicators["ADX"] + indicators["VOLUME"]

# After: 全ペア統一
SCORING_INDICATORS = ["RSI", "MACD", "SMA_CROSS", "ADX", "VOLUME", "GRANVILLE"]

def calculate_total_score(indicators: dict) -> float:
    return sum(indicators.get(name, 0.0) for name in SCORING_INDICATORS)
```

### 修正の効果

全9通貨ペアでスコア計算を統一した結果、モンテカルロシミュレーション（10,000試行）で全ペアの破産確率が0.00%に収束した。

```
修正前:
  EUR_JPY: 破産確率 0.00%
  GBP_JPY: 破産確率 0.00%
  AUD_JPY: 破産確率 0.12%  ← 微小だが非ゼロ
  ...

修正後:
  全9ペア: 破産確率 0.00%
```

AUD_JPYの破産確率が0.12%だったのは、VOLUMEスコアが欠落したことでエントリー基準が実質的に緩くなり、低品質なシグナルでエントリーしていたためだ。

---

## Granville新カテゴリ（FX-P-GRANVILLE）

### グランビルの法則とは

グランビルの法則（Granville's Law）は、ジョセフ・グランビル（Joseph Granville）が1960年代に提唱した、移動平均線と株価の位置関係からトレンドの転換点を判断する手法だ。

8つの売買シグナルが定義されている。

```
【買いシグナル】
1. 移動平均線が下落→横ばいに転じ、価格が下から上に突破
2. 移動平均線が上昇中に、価格が一時的に下回った後に再度上抜け
3. 価格が移動平均線の上にあり、下落したが割り込まずに反発
4. 価格が移動平均線から大きく下方に乖離（売られすぎの逆張り）

【売りシグナル】
5〜8: 上記の逆パターン
```

### 従来の問題

FXエンジンのテクニカル指標は、「トレンド系」「オシレーター系」「出来高系」の3カテゴリに分類されていた。しかしグランビルの法則は移動平均線を使うため「トレンド系」に分類されていたものの、逆張りシグナル（4番・8番）を含むため、純粋なトレンド系とは性質が異なる。

### GRANVILLE_INDICATORS の追加

グランビルの法則を独立したカテゴリとして切り出し、スコアリングに組み込んだ。

```python
INDICATOR_CATEGORIES = {
    "TREND":      ["SMA_CROSS", "MACD", "ADX"],
    "OSCILLATOR": ["RSI", "STOCHASTIC", "CCI"],
    "VOLUME":     ["OBV", "VOLUME_MA"],
    "GRANVILLE":  ["GRANVILLE_BUY", "GRANVILLE_SELL"],  # NEW
}

# グランビルシグナルのスコア計算
def calculate_granville_score(price: float, sma: float, sma_slope: float) -> float:
    deviation = (price - sma) / sma  # 移動平均からの乖離率

    if sma_slope > 0 and deviation > 0:
        return 1.0   # 買いシグナル1: 上昇トレンド中の順張り
    elif sma_slope > 0 and -0.02 < deviation < 0:
        return 0.8   # 買いシグナル2: 押し目買い
    elif deviation < -0.05:
        return 0.5   # 買いシグナル4: 乖離逆張り（控えめなスコア）
    else:
        return 0.0
```

逆張りシグナル（4番）のスコアを低めに設定しているのは、トレンドフォロー戦略との整合性を保つためだ。

---

## シグナルバグ修正（FX-P-SIGNAL-BUG）

スコア計算整合と同時期に、シグナル生成のバグも6箇所修正した。

最も影響が大きかったのは、Buyシグナルの列数不足だ。

```
Before: Buyシグナル出力列 = 3列（RSI, MACD, SMA_CROSS）
After:  Buyシグナル出力列 = 9列（RSI, MACD, SMA_CROSS, ADX, VOLUME, GRANVILLE, ...）
```

3列しか出力されていなかった原因は、初期開発時に3指標でスコアリングを開始し、指標を追加した際にBuyシグナルの出力処理が更新されていなかったためだ。Sellシグナルは正しく9列出力されていた。

この非対称性により、Buyシグナルのスコアが実質的に低く計算され、Buyエントリーが本来より少なくなっていた。

---

## 学んだこと

### 1. 「全ペア同一ロジック」が鉄則

ペアごとの例外処理は、追加した本人は覚えていても、3ヶ月後には忘れる。スコア計算ロジックは全ペアで統一し、ペア固有の調整が必要ならパラメータ（重み係数など）で対応すべきだ。

### 2. 地味なバグが大きな影響を与える

Buyシグナルの列数不足は、エラーも出ず、システムも止まらない。しかし「本来取れていたはずのBuyエントリーを逃す」形で、月間収益に静かに影響し続けていた。

### 3. モンテカルロシミュレーションは「検算ツール」としても有効

破産確率の計算過程で、スコア計算の不整合を発見した。MCシミュレーションは「戦略の評価」だけでなく、「実装の検証」にも使える。

---

## まとめ

シグナル品質の地道な改善で重要なのは以下の3点だ。

1. **スコア計算の統一**: 全ペアで同一ロジックを強制。例外処理は将来のバグ源
2. **カテゴリ分類の見直し**: グランビルの法則を独立カテゴリ化し、トレンド系との性質の違いをスコアに反映
3. **サイレントバグの検出**: モンテカルロシミュレーションやバックテスト結果の精査で、エラーにならないバグを発見する

派手な新機能の追加より、既存の仕組みの整合性確認のほうが、収益への影響が大きいことがある。
