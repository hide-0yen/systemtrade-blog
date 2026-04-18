---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "コード重複3,700行を52%削減：3モード統合リファクタリングの実践"
featured: false
draft: false
tags:
  - リファクタリング
  - コード品質
  - Python
  - 設計パターン
description: "FXトレードエンジンの3モード間で重複していた約3,700行を、re-exportパターンと継承+テンプレートメソッドで52%削減したリファクタリングの設計と実践記録。"
---

FXトレードエンジンには「Swing」「Day」「Range」の3つのトレードモードがある。歴史的経緯で、RiskManager・BacktestEngine・PositionManagerの3つのコア部品がモードごとに別ファイルとして存在し、ほぼ同一のコードが3重に複製されていた。

コードの重複は「1箇所の修正を3箇所に反映し忘れる」バグの温床だ。実際に、あるバグ修正がSwingモードには適用されたがDayモードには適用されなかった事例が発生した。

本記事では、3つのコア部品を段階的に統合し、合計で約3,700行を52%削減（約1,900行に圧縮）したリファクタリングの設計判断と実施過程を記録する。全統合でそれぞれ33〜41の新規テスト + 4,000件超の回帰テストがPASSしている。

---

## リファクタリング前の状態

### 3モードの歴史

最初にSwingモードが実装された。次にDayモードが必要になったとき、Swingのコードをコピーして一部を変更した。さらにRangeモードが追加されたとき、Dayのコードをコピーした。

```
リファクタリング前:
  risk_manager_swing.py     (500行)
  risk_manager_day.py       (480行)  ← Swingのコピー + 微修正
  risk_manager_range.py     (482行)  ← Dayのコピー + 微修正

  backtest_engine_swing.py  (1,300行)
  backtest_engine_day.py    (1,241行)
  backtest_engine_range.py  (1,200行)

  position_manager_swing.py (520行)
  position_manager_day.py   (480行)
  position_manager_range.py (462行)

  合計: 約6,665行（うち重複約3,700行）
```

3ファイルの差分を取ると、90%以上が同一コードだった。違いは以下の部分のみ：

- エントリー判定のパラメータ（SL/TP倍率、セッションフィルター）
- ポジション管理の最大保有数
- バックテストのデフォルトパラメータ

---

## 統合の設計パターン

### C-DUP-01: RiskManager — Protocol + re-export パターン

RiskManagerは3モードで**完全に同一**のコードだった。差分は文字通りゼロ。

```python
# 統合前: 3ファイルに同じコードが3重に存在
# 統合後: core/shared/risk_manager.py に1つだけ配置

# 後方互換のため、旧パスからのimportも動くようにre-export
# risk_manager_swing.py:
from core.shared.risk_manager import RiskManager  # re-export
```

`re-export` パターンとは、旧ファイルを削除せず、新しい場所のモジュールをインポートして再公開する方法だ。これにより、旧パスでimportしている既存コードを1行も変更せずに統合できる。

### C-DUP-02: BacktestEngine — 継承 + テンプレートメソッド パターン

BacktestEngineは90%が共通で、10%がモード固有のロジックだった。

```python
# 基底クラス: 共通ロジックを持つ
class BaseBacktestEngine:
    def run(self, data):
        self._prepare(data)          # 共通: データ前処理
        signals = self._detect_signals(data)  # 共通: シグナル検出
        for signal in signals:
            if self._should_entry(signal):    # ★モード固有
                self._execute_entry(signal)    # 共通: エントリー実行
        return self._summarize()              # 共通: 結果集計

    def _should_entry(self, signal):
        """サブクラスでオーバーライド"""
        raise NotImplementedError

# モード固有クラス: 差分だけをオーバーライド
class SwingBacktestEngine(BaseBacktestEngine):
    def _should_entry(self, signal):
        return signal.score >= self.min_score and signal.session == "SWING"

class DayBacktestEngine(BaseBacktestEngine):
    def _should_entry(self, signal):
        return signal.score >= self.min_score and signal.session in ["LONDON", "NY"]
```

テンプレートメソッド（Template Method）パターンで、アルゴリズムの骨格を基底クラスに定義し、変化する部分だけをサブクラスでオーバーライドする。

**結果**: 3,741行 → 1,787行（**52%削減**）。41新規テスト + 4,086回帰テスト全PASS。

### C-DUP-03: PositionManager — 継承 + re-export パターン

PositionManagerはBacktestEngineと同様のアプローチで統合した。

**結果**: 1,462行 → 895行（**39%削減**）。33新規テスト + 4,119回帰テスト全PASS。

---

## リファクタリングの判断基準

### 「いつリファクタリングすべきか」

重複コードのリファクタリングは常に正しいわけではない。以下の条件がすべて揃ったときに実施した。

1. **重複率が80%以上**: 差分が20%以下なら統合のメリットが大きい
2. **実際にバグが発生した**: 「1箇所の修正を反映し忘れた」実例がある
3. **今後も変更が入る予定**: 統合しても今後変更が入らないなら、放置でも害は少ない
4. **十分な回帰テストがある**: テストがなければ、リファクタリングは自殺行為

条件4が最も重要だ。4,000件超の回帰テストがあったからこそ、「統合後もすべて動く」ことを保証できた。

### 「何を共通化しないか」

共通化しすぎると、条件分岐が増えて可読性が下がる。以下は意図的に共通化しなかった。

- **設定ファイルの構造**: 各モードの設定JSONは構造が異なる。共通のスキーマに合わせると、不自然な型変換が必要になる
- **ログのフォーマット**: 各モードのログは「見る人が違う」（Swing=日次レポート、Day=リアルタイム）
- **テストの構造**: 各モード固有のエッジケースは、そのモードのテストファイルに残す

---

## 複雑度低減（H-COMP-01〜03）

重複統合と並行して、関数の複雑度（Cyclomatic Complexity）も削減した。

| 施策      | 対象                                     | Before → After | 削減率 |
| --------- | ---------------------------------------- | -------------- | ------ |
| H-COMP-01 | unified_analyzer.py `_analyze_pair`      | CC 60 → 19     | -68%   |
| H-COMP-02 | JS TradingEngine `__init__`              | CC 53 → 21     | -60%   |
| H-COMP-02 | JS TradingEngine `_process_moc_breakout` | CC 51 → 6      | -88%   |
| H-COMP-03 | US TradingEngine `run_session`           | CC 42 → 23     | -45%   |

CC（Cyclomatic Complexity、循環的複雑度）とは、関数内の分岐パス数を測る指標で、一般にCC 10以下が「保守可能」、CC 20以上は「リファクタリング推奨」、CC 50以上は「テスト不能に近い」とされる。

### 分割のアプローチ

CC 60の関数を1つの関数のまま改善するのは不可能だ。責務ごとに小さな関数に分割した。

```python
# Before: 1関数にすべての処理が詰まっている（CC 60）
def _analyze_pair(self, pair, data):
    # 200行の巨大関数
    # データ取得、指標計算、シグナル検出、フィルタリング、レポート生成...

# After: 5つの小関数に分割（各CC 10〜19）
def _analyze_pair(self, pair, data):
    indicators = self._calculate_indicators(pair, data)
    signals = self._detect_signals(pair, indicators)
    filtered = self._apply_filters(pair, signals)
    report = self._generate_report(pair, filtered)
    return self._format_output(pair, report)
```

---

## 学んだこと

### 1. コピペは技術的負債の最速の蓄積方法

「コピーして一部を変更する」は最も速い実装方法だが、最も高い保守コストを生む。2つ目のコピーが発生した時点で統合を検討すべきだった。3つ目のコピーまで放置した結果、統合工数が膨大になった。

### 2. re-exportパターンは移行コストをゼロにする

旧パスを残して新パスに転送するだけで、既存の全importが動く。これにより「統合のために既存コードを修正する」工数がゼロになり、リファクタリングの心理的ハードルが下がる。

### 3. 回帰テストがなければリファクタリングしてはいけない

4,000件超のテストが「統合後もすべて動く」ことを保証した。テストがなかったら、この規模のリファクタリングは不可能だった。テストは「コードを書く自由」を保証するインフラだ。

---

## まとめ

コード重複統合の設計で重要なのは以下の3点だ。

1. **段階的な統合**: RiskManager（完全同一）→ BacktestEngine（90%共通）→ PositionManager（80%共通）の順に難易度を上げて実施
2. **パターンの使い分け**: 完全同一はre-export、部分共通は継承+テンプレートメソッド
3. **回帰テストによる安全保証**: 4,000件超のテストで「何も壊れていない」ことを機械的に証明

6,665行を約3,000行に削減した結果、「1つの修正を1箇所に書けばすべてのモードに反映される」状態を達成した。これがリファクタリングの本質的な価値だ。
