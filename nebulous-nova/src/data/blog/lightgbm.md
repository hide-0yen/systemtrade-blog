---
author: "45395"
pubDatetime: 2026-03-30T10:00:00+09:00
modDatetime: 2026-02-30T10:00:00+09:00
title: LightGBMでテクニカル指標の重みを動的に学習する
featured: false
draft: false
tags:
  - AI駆動開発
  - LightGBM
  - 勾配ブースティング決定木
  - テクニカル分析
  - テクニカル指標
  - スコアリング改善
  - GBDT
  - 線形回帰
  - ニューラルネット
  - ランダムフォレスト
  - 機械学習

description: LightGBM（Gradient Boosting Decision Tree、勾配ブースティング決定木）を使用してテクニカル指標の重みを過去データから動的に学習するスコアリングシステムの設計と実装について解説しています。
---

テクニカル指標ベースの自動売買システムでは、各指標のスコアに「重み」を掛けて合計し、閾値以上ならエントリーする。しかし、この重みを人間が固定値で決めている限り、「どの指標がどの局面で有効か」という変化に追随できません。

本記事では、LightGBM（Gradient Boosting Decision Tree、勾配ブースティング決定木）を使って、テクニカル指標の重みを過去データから動的に学習するスコアリングシステムの設計と実装方法を解説しています。

---

## 静的スコアリングの限界

### 従来の仕組み

```python
STATIC_WEIGHTS = {
    "RSI":        1.0,
    "MACD":       1.2,
    "SMA_CROSS":  0.8,
    "ADX":        1.0,
    "VOLUME":     0.5,
}

total_score = sum(indicator_score * STATIC_WEIGHTS[name] for name, indicator_score in signals)
```

この重みは人間（私）が「MACDは重要だから1.2」「出来高はそこそこだから0.5」と勘で決めていました。

### 問題点

1. **相場環境で有効な指標が変わる**: トレンド相場ではMACDが強いが、レンジ相場ではRSIが強い
2. **通貨ペアごとに特性が異なる**: EUR_JPYで有効な指標がGBP_JPYでも有効とは限らない
3. **時間経過で有効性が変化**: 2022年に有効だった指標が2026年にも有効とは限らない

---

## LightGBMを選んだ理由

### なぜGBDT（勾配ブースティング決定木）か

機械学習モデルには多くの選択肢があるが、トレードシグナルのスコアリングにはGBDTが最適だと判断しました。

| モデル             | メリット                                       | デメリット                   | 採用  |
| ------------------ | ---------------------------------------------- | ---------------------------- | ----- |
| 線形回帰           | シンプル、解釈容易                             | 非線形パターンを捉えられない | ❌     |
| ニューラルネット   | 非線形を高精度で捕捉                           | 過学習しやすい、解釈困難     | ❌     |
| ランダムフォレスト | 過学習に強い                                   | 予測速度がGBDTより遅い       | △     |
| **LightGBM**       | **高速、過学習制御容易、特徴量重要度が見える** | ハイパーパラメータ調整が必要 | **✅** |

LightGBMの最大の利点は**特徴量重要度（Feature Importance）**が得られることです。「このモデルはMACDを最も重視している」「VolumeはほとんどGainに寄与していない」といった情報が、人間にも解釈可能な形で得られます。

### 学習データ

```
入力（特徴量）: 各テクニカル指標のスコア値（RSI, MACD, SMA, ADX, Volume, ...）
出力（ラベル）: そのトレードが利益か損失か（1=勝ち, 0=負け）
データソース: バックテスト全トレードの実績
```

---

## 動的重みの設計

### scale_factorの役割

LightGBMの出力（0〜1の確率値）をそのまま重みに使うと、静的スコアとの整合性が取れない。`scale_factor`で出力をスケーリングする。

```python
def predict_dynamic_weights(features: dict, model, scale_factor: float = 3.8) -> dict:
    """LightGBMの予測値を動的重みに変換"""
    feature_importances = model.feature_importance(importance_type="gain")
    total_importance = sum(feature_importances)

    dynamic_weights = {}
    for i, name in enumerate(feature_names):
        # 重要度を正規化し、scale_factorでスケーリング
        weight = (feature_importances[i] / total_importance) * scale_factor
        dynamic_weights[name] = weight

    return dynamic_weights
```

`scale_factor=3.8`は、静的重みの合計値（約4.5）に近い値として設定した。これにより、動的重みと静的重みのスコアレンジが同等になり、既存の`min_total_score`閾値をそのまま使用できる。

### fallback_to_static：安全装置

モデルの推論が失敗した場合（モデルファイルが壊れた、入力データが異常など）、静的重みにフォールバックする。

```python
def get_weights(features: dict) -> dict:
    if not model_available or fallback_to_static:
        return STATIC_WEIGHTS  # 静的重みにフォールバック
    try:
        return predict_dynamic_weights(features, model)
    except Exception:
        return STATIC_WEIGHTS  # 推論失敗時も静的重みで継続
```

この設計により、LightGBMモデルが壊れてもシステム全体が停止することはありません。

---

## モデルの訓練と更新

### 訓練データの構築

バックテストの全トレード結果から訓練データを構築。

```python
# 各トレードのエントリー時点の指標値を特徴量として抽出
training_data = []
for trade in backtest_results:
    features = {
        "RSI": trade.entry_rsi,
        "MACD": trade.entry_macd_score,
        "SMA_CROSS": trade.entry_sma_cross_score,
        "ADX": trade.entry_adx,
        "VOLUME": trade.entry_volume_score,
        # ... 全指標
    }
    label = 1 if trade.pnl > 0 else 0
    training_data.append((features, label))
```

### 過学習対策

トレードデータは件数が限られる（数百〜数千件）ため、過学習のリスクが高い。以下の対策を実施。

1. **時系列分割（Walk-Forward）**: 将来のデータで訓練しない。2022-2024年で訓練、2024-2026年で検証
2. **正則化パラメータ**: `reg_lambda=1.0`（L2正則化）、`min_child_samples=20`
3. **早期停止**: 検証セットのAUCが改善しなくなったら訓練を停止
4. **特徴量の制限**: 相関の高い指標は片方のみ使用（多重共線性の回避）

---

## RVレジーム判定フィルター（NEW-01）との連携

LightGBMスコアリングと並行して実装した**RVレジーム判定フィルター**（Realized Volatility、実現ボラティリティ）も、指標重みの動的調整に関連する施策。

RV（実現ボラティリティ）は、過去の価格変動から計算した「実際のボラティリティ」だ。VIX（予想ボラティリティ）と異なり、実績ベースの値です。

```python
def classify_rv_regime(rv_short: float, rv_long: float) -> str:
    """RV短期/長期比でレジーム判定"""
    ratio = rv_short / rv_long if rv_long > 0 else 1.0
    if ratio > 1.2:
        return "EXPANDING"    # ボラ拡大中 → リスクオフ
    elif ratio < 0.8:
        return "CONTRACTING"  # ボラ縮小中 → 通常
    else:
        return "STABLE"       # 安定
```

RVが「拡大中」（EXPANDING）の場合、LightGBMの動的重みにさらに保守的な補正を加えました。
これにより「ボラが急拡大している局面ではエントリー基準を厳しくする」二重の防御層が形成されます。

---

## 学んだこと

### 1. 機械学習は「重み付け」に使い、「売買判断」には使わない

LightGBMで直接「買うべきか/売るべきか」を予測するのではなく、「各指標の重要度」を学習させている。売買判断はルールベースのスコアリングが行い、そのスコアの重み配分だけを機械学習で最適化する。これにより、モデルが誤っても壊滅的な損失にはならない。

### 2. フォールバックがないMLシステムは危険

モデルが壊れた瞬間にシステムが止まるのは致命的だ。`fallback_to_static=true`により、最悪でも「人間が決めた静的重み」で動き続ける安全設計にしました。

### 3. 特徴量重要度は「人間の理解」を助ける

ニューラルネットのブラックボックスと違い、LightGBMの特徴量重要度は「今、どの指標が最も効いているか」を人間に教えてくれる。これにより「モデルの判断を信頼できるか」を人間が判断可能な状態にしました。

---

## まとめ

LightGBM動的スコアリングの設計で重要なのは以下の3点です。

1. **用途を限定する**: 売買判断ではなく「重み付け」にMLを使用。壊滅的失敗を防止
2. **フォールバック必須**: `fallback_to_static=true`で、モデル障害時は静的重みで継続
3. **特徴量重要度の活用**: 人間が解釈可能な形でモデルの判断根拠を確認できる

機械学習をトレードに使う最大のリスクは「過学習」と「ブラックボックス化」だ。両方を抑制した設計が、実運用で生き残るシステムの条件かと思います。
