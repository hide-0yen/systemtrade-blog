---
author: "45395"
pubDatetime: 2026-04-08T10:00:00+09:00
modDatetime: 2026-04-08T10:00:00+09:00
title: PythonでFXテクニカル分析を実装する：酒田五法・一目均衡表のアルゴリズム化
featured: false
draft: false
tags:
  - FX
  - Python
  - テクニカル分析
  - 自動売買
description: "酒田五法（三山・三川・三空・三兵・三法）と一目均衡表をPythonでアルゴリズム化した実装記録。日本発テクニカル分析のパターン検出ロジックとシグナル判定を解説する。"
---

# PythonでFXテクニカル分析を実装する：酒田五法・一目均衡表のアルゴリズム化

日本発のテクニカル分析には独自の深みがある。酒田五法は江戸時代の米相場から生まれたローソク足パターン分析であり、一目均衡表は昭和初期に考案された時間論ベースのトレンド分析だ。どちらも「目視で判断する」前提で設計されているため、アルゴリズム化するには独自の工夫が必要になる。

本記事では、2025年8月〜9月にsystemtradeプロジェクトで実装した酒田五法と一目均衡表のPython実装を記録する。もともと株式版で先に実装し、9月5日〜7日にかけてFX版へ横展開した。

---

## 設計方針：signalsConfig.pyによる統一インターフェース

テクニカル指標は種類が多く、追加・削除のたびにコード全体に影響が出るのを防ぐ必要がある。そこで`signalsConfig.py`でEnum定義による統一インターフェースを採用した。

```python
from enum import Enum

class SignalType(Enum):
    """テクニカルシグナルの種別定義"""
    # 酒田五法
    SAKATA_SANZAN = "sakata_sanzan"            # 三山（トリプルトップ）
    SAKATA_SANSEN = "sakata_sansen"            # 三川（トリプルボトム）
    SAKATA_SANKU = "sakata_sanku"              # 三空（3連続窓開け）
    SAKATA_SANPEI = "sakata_sanpei"            # 三兵（3連続同方向足）
    SAKATA_SANPO = "sakata_sanpo"              # 三法（保ち合い後のブレイク）

    # 一目均衡表
    ICHIMOKU_SANYAKU_KOTEN = "ichimoku_sanyaku_koten"    # 三役好転
    ICHIMOKU_SANYAKU_GYAKUTEN = "ichimoku_sanyaku_gyakuten"  # 三役逆転
    ICHIMOKU_KUMO_BREAKOUT = "ichimoku_kumo_breakout"    # 雲ブレイク
```

この設計により、新しいシグナルを追加するときはEnumに1行追加し、対応する計算ロジックを`analyticsEngine.py`に書くだけで済む。呼び出し側のコードを変更する必要がない。

---

## 酒田五法の実装

### 酒田五法とは

酒田五法は以下の5つのパターンから成る。

| パターン | 読み     | 意味                                       |
| -------- | -------- | ------------------------------------------ |
| 三山     | さんざん | 3回高値をつけて反落（天井シグナル）        |
| 三川     | さんせん | 3回安値をつけて反発（底値シグナル）        |
| 三空     | さんくう | 3連続の窓開け（過熱シグナル）              |
| 三兵     | さんぺい | 3連続の同方向陽線/陰線（トレンド継続）     |
| 三法     | さんぽう | 小動きの保ち合い後にブレイク（レンジ脱出） |

### 三山（三尊天井含む）の検出ロジック

三山は「3回高値をつけたが超えられず反落する」パターンだ。特に2番目の山が最も高い場合を「三尊天井（ヘッド・アンド・ショルダーズ）」と呼ぶ。

```python
def detect_sanzan(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    lookback: int = 20,
    tolerance: float = 0.002,
) -> bool:
    """
    三山（トリプルトップ）の検出

    Args:
        highs: 高値のリスト（直近lookback本分）
        lows: 安値のリスト
        closes: 終値のリスト
        lookback: 検出対象期間（本数）
        tolerance: 高値の許容誤差（0.2%）

    Returns:
        三山パターンが検出された場合True
    """
    if len(highs) < lookback:
        return False

    recent_highs = highs[-lookback:]

    # ローカルピーク（前後より高い点）を抽出
    peaks: list[tuple[int, float]] = []
    for i in range(1, len(recent_highs) - 1):
        if recent_highs[i] > recent_highs[i - 1] and recent_highs[i] > recent_highs[i + 1]:
            peaks.append((i, recent_highs[i]))

    if len(peaks) < 3:
        return False

    # 直近3つのピークを取得
    last_three = peaks[-3:]
    peak_values = [p[1] for p in last_three]

    # 3つのピークが近い水準にあるか判定
    max_peak = max(peak_values)
    for value in peak_values:
        if abs(value - max_peak) / max_peak > tolerance:
            return False

    # 直近の終値が3つのピークより下にあるか
    current_close = closes[-1]
    if current_close < min(peak_values) * (1 - tolerance):
        return True

    return False
```

**アルゴリズム化のポイント**: 「高値をつけた」の定義が曖昧なため、ローカルピーク（前後の足より高い点）として数値的に定義した。`tolerance`パラメータで「同じ水準」の許容幅を設定できるようにしている。

### 三空の検出ロジック

三空は「3連続の窓開け（ギャップ）」を検出する。FXでは株式ほど窓が開かないため、閾値の調整が重要になる。

```python
def detect_sanku(
    opens: list[float],
    closes: list[float],
    gap_threshold: float = 0.0005,
) -> str | None:
    """
    三空の検出

    Args:
        opens: 始値のリスト（直近4本分以上）
        closes: 終値のリスト
        gap_threshold: 窓と判定する最小幅（FXの場合0.05%程度）

    Returns:
        "bearish": 三空踏み上げ（売りシグナル）
        "bullish": 三空叩き込み（買いシグナル）
        None: シグナルなし
    """
    if len(opens) < 4:
        return None

    gaps_up = 0
    gaps_down = 0

    for i in range(-3, 0):
        prev_close = closes[i - 1]
        curr_open = opens[i]
        gap_ratio = (curr_open - prev_close) / prev_close

        if gap_ratio > gap_threshold:
            gaps_up += 1
        elif gap_ratio < -gap_threshold:
            gaps_down += 1

    if gaps_up == 3:
        return "bearish"   # 三空踏み上げ → 過熱 → 売り
    elif gaps_down == 3:
        return "bullish"   # 三空叩き込み → 売られすぎ → 買い

    return None
```

### 三兵の検出ロジック

```python
def detect_sanpei(
    opens: list[float],
    closes: list[float],
) -> str | None:
    """
    三兵（赤三兵 / 黒三兵）の検出

    Returns:
        "bullish": 赤三兵（3連続陽線、各足の終値が前足の終値を上回る）
        "bearish": 黒三兵（3連続陰線、各足の終値が前足の終値を下回る）
        None: シグナルなし
    """
    if len(opens) < 3:
        return None

    bullish_count = 0
    bearish_count = 0

    for i in range(-3, 0):
        is_bullish = closes[i] > opens[i]
        is_bearish = closes[i] < opens[i]

        if i > -3:
            higher_close = closes[i] > closes[i - 1]
            lower_close = closes[i] < closes[i - 1]
        else:
            higher_close = True
            lower_close = True

        if is_bullish and higher_close:
            bullish_count += 1
        if is_bearish and lower_close:
            bearish_count += 1

    if bullish_count == 3:
        return "bullish"
    elif bearish_count == 3:
        return "bearish"

    return None
```

---

## 一目均衡表の実装

### 5つの構成要素

一目均衡表は5つの線で構成される。

| 線          | 計算式                                                | 期間 |
| ----------- | ----------------------------------------------------- | ---- |
| 転換線      | (過去N期間の最高値 + 最安値) / 2                      | N=9  |
| 基準線      | (過去M期間の最高値 + 最安値) / 2                      | M=26 |
| 先行スパン1 | (転換線 + 基準線) / 2 を26期間先にプロット            | -    |
| 先行スパン2 | (過去L期間の最高値 + 最安値) / 2 を26期間先にプロット | L=52 |
| 遅行スパン  | 終値を26期間前にプロット                              | -    |

```python
def calculate_ichimoku(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    tenkan_period: int = 9,
    kijun_period: int = 26,
    senkou_b_period: int = 52,
    displacement: int = 26,
) -> dict[str, list[float | None]]:
    """一目均衡表の全5線を計算"""
    length = len(highs)
    tenkan: list[float | None] = [None] * length
    kijun: list[float | None] = [None] * length
    senkou_a: list[float | None] = [None] * length
    senkou_b: list[float | None] = [None] * length
    chikou: list[float | None] = [None] * length

    for i in range(length):
        # 転換線
        if i >= tenkan_period - 1:
            h = max(highs[i - tenkan_period + 1 : i + 1])
            l = min(lows[i - tenkan_period + 1 : i + 1])
            tenkan[i] = (h + l) / 2

        # 基準線
        if i >= kijun_period - 1:
            h = max(highs[i - kijun_period + 1 : i + 1])
            l = min(lows[i - kijun_period + 1 : i + 1])
            kijun[i] = (h + l) / 2

        # 先行スパン1（displacement期間先にプロット）
        if tenkan[i] is not None and kijun[i] is not None:
            target_idx = i + displacement
            if target_idx < length:
                senkou_a[target_idx] = (tenkan[i] + kijun[i]) / 2

        # 先行スパン2
        if i >= senkou_b_period - 1:
            h = max(highs[i - senkou_b_period + 1 : i + 1])
            l = min(lows[i - senkou_b_period + 1 : i + 1])
            target_idx = i + displacement
            if target_idx < length:
                senkou_b[target_idx] = (h + l) / 2

        # 遅行スパン（displacement期間前にプロット）
        past_idx = i - displacement
        if past_idx >= 0:
            chikou[past_idx] = closes[i]

    return {
        "tenkan": tenkan,
        "kijun": kijun,
        "senkou_a": senkou_a,
        "senkou_b": senkou_b,
        "chikou": chikou,
    }
```

### 三役好転・三役逆転のシグナル判定

三役好転は「買い」の強いシグナル、三役逆転は「売り」の強いシグナルだ。

```python
def detect_ichimoku_signal(
    closes: list[float],
    ichimoku: dict[str, list[float | None]],
    index: int,
    displacement: int = 26,
) -> str | None:
    """
    三役好転 / 三役逆転の判定

    三役好転の3条件:
      1. 転換線 > 基準線
      2. 終値 > 雲の上限（先行スパン1と2の大きい方）
      3. 遅行スパン > 26期間前の終値

    三役逆転はすべて逆。
    """
    tenkan = ichimoku["tenkan"][index]
    kijun = ichimoku["kijun"][index]
    senkou_a = ichimoku["senkou_a"][index]
    senkou_b = ichimoku["senkou_b"][index]

    if any(v is None for v in [tenkan, kijun, senkou_a, senkou_b]):
        return None

    close = closes[index]
    kumo_upper = max(senkou_a, senkou_b)  # type: ignore[arg-type]
    kumo_lower = min(senkou_a, senkou_b)  # type: ignore[arg-type]

    # 遅行スパンの比較対象（26期間前の終値）
    chikou_ref_idx = index - displacement
    if chikou_ref_idx < 0:
        return None
    chikou_ref = closes[chikou_ref_idx]
    chikou_value = closes[index]  # 遅行スパン = 現在の終値を過去にプロット

    # 三役好転判定
    bullish_1 = tenkan > kijun           # type: ignore[operator]
    bullish_2 = close > kumo_upper
    bullish_3 = chikou_value > chikou_ref

    if bullish_1 and bullish_2 and bullish_3:
        return "sanyaku_koten"

    # 三役逆転判定
    bearish_1 = tenkan < kijun           # type: ignore[operator]
    bearish_2 = close < kumo_lower
    bearish_3 = chikou_value < chikou_ref

    if bearish_1 and bearish_2 and bearish_3:
        return "sanyaku_gyakuten"

    return None
```

### 雲の厚さによるトレンド強度判定

先行スパン1と先行スパン2の差（雲の厚さ）はトレンドの強さを示す。雲が厚いほどサポート/レジスタンスが強い。

```python
def calculate_kumo_strength(
    senkou_a: float | None,
    senkou_b: float | None,
    close: float,
) -> dict[str, float | str] | None:
    """雲の厚さとトレンド強度を計算"""
    if senkou_a is None or senkou_b is None:
        return None

    thickness = abs(senkou_a - senkou_b)
    thickness_ratio = thickness / close  # 終値に対する比率

    position: str
    if close > max(senkou_a, senkou_b):
        position = "above_kumo"   # 雲の上 → 上昇トレンド
    elif close < min(senkou_a, senkou_b):
        position = "below_kumo"   # 雲の下 → 下降トレンド
    else:
        position = "inside_kumo"  # 雲の中 → 方向感なし

    return {
        "thickness": thickness,
        "thickness_ratio": thickness_ratio,
        "position": position,
    }
```

---

## 株式版からFX版への横展開で変わった点

株式版で先に実装し、FX版へ横展開した際に調整が必要だった点を記録する。

### 1. 窓（ギャップ）の閾値

株式市場はオーバーナイトの窓が頻繁に発生するが、FXは24時間市場のため窓が少ない。三空の`gap_threshold`を株式版の0.5%からFX版では0.05%に引き下げた。

### 2. 一目均衡表のパラメータ

一目均衡表の標準パラメータ（9, 26, 52）は日足ベースの設計だ。FXのH4足やH1足で使う場合は、時間軸に合わせた調整が選択肢になる。ただし、多くのトレーダーが標準パラメータを使っているため「自己成就的予言」の効果を考慮し、標準パラメータのまま運用している。

### 3. トレードスタイル別の適用

| スタイル       | 酒田五法   | 一目均衡表     |
| -------------- | ---------- | -------------- |
| スイング       | 日足で適用 | 標準パラメータ |
| デイトレ       | H4足で適用 | 参考程度       |
| スキャルピング | 適用なし   | 適用なし       |

スキャルピングでは酒田五法・一目均衡表とも使っていない。足の本数が少なく、パターンの信頼性が低下するためだ。

---

## analyticsEngine.pyでの統合

各シグナルの計算結果は`analyticsEngine.py`で統合し、統一フォーマットで出力する。

```python
from dataclasses import dataclass
from datetime import datetime

@dataclass(frozen=True)
class SignalResult:
    signal_type: SignalType
    direction: str          # "bullish" | "bearish"
    strength: float         # 0.0〜1.0
    timestamp: datetime
    pair: str               # "USD_JPY" etc.

def analyze_japanese_signals(
    ohlc_data: dict[str, list[float]],
    pair: str,
    timestamp: datetime,
) -> list[SignalResult]:
    """酒田五法 + 一目均衡表のシグナルを一括計算"""
    results: list[SignalResult] = []

    # 酒田五法
    if detect_sanzan(ohlc_data["high"], ohlc_data["low"], ohlc_data["close"]):
        results.append(SignalResult(
            signal_type=SignalType.SAKATA_SANZAN,
            direction="bearish",
            strength=0.7,
            timestamp=timestamp,
            pair=pair,
        ))

    sanpei = detect_sanpei(ohlc_data["open"], ohlc_data["close"])
    if sanpei is not None:
        results.append(SignalResult(
            signal_type=SignalType.SAKATA_SANPEI,
            direction=sanpei,
            strength=0.6,
            timestamp=timestamp,
            pair=pair,
        ))

    # 一目均衡表
    ichimoku = calculate_ichimoku(
        ohlc_data["high"], ohlc_data["low"], ohlc_data["close"],
    )
    last_idx = len(ohlc_data["close"]) - 1
    ichimoku_signal = detect_ichimoku_signal(
        ohlc_data["close"], ichimoku, last_idx,
    )
    if ichimoku_signal == "sanyaku_koten":
        results.append(SignalResult(
            signal_type=SignalType.ICHIMOKU_SANYAKU_KOTEN,
            direction="bullish",
            strength=0.8,
            timestamp=timestamp,
            pair=pair,
        ))
    elif ichimoku_signal == "sanyaku_gyakuten":
        results.append(SignalResult(
            signal_type=SignalType.ICHIMOKU_SANYAKU_GYAKUTEN,
            direction="bearish",
            strength=0.8,
            timestamp=timestamp,
            pair=pair,
        ))

    return results
```

---

## まとめ

日本発テクニカル分析をPythonで実装する際のポイントは以下の3点だ。

1. **Enumによる統一インターフェース**: `signalsConfig.py`でシグナル種別をEnum定義し、追加・削除の影響範囲を局所化する
2. **「目視判断」の数値化**: 酒田五法の「同じ水準の高値」をtolerance（許容誤差）で定義するなど、曖昧な概念に明確な閾値を設ける
3. **市場特性に合わせた閾値調整**: 株式版からFX版への横展開では、窓の閾値やパラメータの調整が必要。ただし一目均衡表のパラメータは「自己成就的予言」を考慮して標準値を維持した

酒田五法も一目均衡表も、アルゴリズム化すること自体は難しくない。難しいのは「どの閾値が実用的か」の判断だ。バックテストで検証しながら閾値を詰めていくプロセスについては、別記事で扱う。
