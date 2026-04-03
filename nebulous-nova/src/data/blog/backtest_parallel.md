---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "バックテストを並列化して7日→1日に短縮した話"
featured: false
draft: false
tags:
  - FX
  - バックテスト
  - Python
  - パフォーマンス最適化
  - 並列処理
description: "PythonのmultiprocessingでFXバックテストのグリッドサーチを並列化し、実行時間を7日から1日に短縮した設計と実装の記録。"
---

FXの自動売買システムで施策の効果を検証するたびに、9通貨ペア × 複数パラメータのグリッドサーチを回す必要がある。逐次実行では1回のグリッドサーチに7日かかっていた。

これを `multiprocessing` による並列処理で1日に短縮した。計画7日の工数を1日で完了し、55テスト全PASSで本番稼働している。

本記事では、Pythonのバックテストを並列化する際の設計判断、GILの回避、メモリ管理、再現性の確保について記録する。

---

## なぜバックテストの高速化が重要か

### グリッドサーチの計算量

新しいフィルターやパラメータの効果を検証するとき、以下のような組み合わせを試す。

```
通貨ペア: 9種類（EUR_JPY, GBP_JPY, AUD_JPY, ...）
SL倍率:  [0.5, 1.0, 1.5, 2.0]
TP倍率:  [1.0, 2.0, 3.0, 4.0, 5.0]
min_score: [1.5, 1.9, 2.3, 2.7]
期間:     2022-06-29 〜 現在（約3.5年分のH4足データ）

合計: 9 × 4 × 5 × 4 = 720パターン
```

1パターンあたり30秒〜1分かかるため、逐次実行では720分（12時間）。これを9通貨ペアのパラメータ組み合わせを変えながら複数回実行するため、施策検証1回に7日かかっていた。

### 高速化の効果

- **検証サイクルの短縮**: 1週間→1日。「仮説→検証→改善」のイテレーション速度が7倍に
- **より多くのパラメータを試せる**: 計算時間が制約でなくなれば、探索範囲を広げられる
- **心理的ハードル低下**: 「バックテスト回すの面倒だから、このパラメータでいいか」という妥協がなくなる

---

## PythonのGIL問題と回避策

### GIL（Global Interpreter Lock）とは

Pythonには「GIL」（Global Interpreter Lock、グローバルインタプリタロック）という仕組みがある。これはPythonのスレッドが同時に1つしかPythonコードを実行できないようにする排他ロックだ。

つまり `threading` モジュールでスレッドを増やしても、CPU集約的な処理（バックテストの計算）は並列に実行されない。

```python
# これではバックテストは速くならない
import threading
threads = [threading.Thread(target=run_backtest, args=(pair,)) for pair in pairs]
for t in threads:
    t.start()  # GILにより、実質逐次実行
```

### multiprocessingでGILを回避

`multiprocessing` モジュールを使うと、各プロセスが独立したPythonインタプリタとメモリ空間を持つため、GILの制約を受けない。CPUコア数分の真の並列実行が可能になる。

```python
from multiprocessing import Pool

def run_backtest_for_params(params: dict) -> dict:
    """1パラメータセットのバックテストを実行して結果を返す"""
    pair = params["pair"]
    sl = params["sl_multiplier"]
    tp = params["tp_multiplier"]
    # ... バックテスト実行 ...
    return {"pair": pair, "sharpe": sharpe_ratio, "max_dd": max_dd}

# CPUコア数の80%を使用（システム全体を占有しない）
num_workers = max(1, int(os.cpu_count() * 0.8))

with Pool(processes=num_workers) as pool:
    results = pool.map(run_backtest_for_params, all_param_combinations)
```

---

## 並列化で直面した課題

### 課題1: メモリ消費の爆発

各プロセスが独立したメモリ空間を持つため、8プロセス並列にすると、データフレームが8倍メモリを消費する。3.5年分のH4足データ（9通貨ペア分）を全プロセスに読み込むと、メモリが枯渇した。

**解決策**: 各プロセスに「自分が担当する通貨ペアのデータだけ」を渡す。データの分割はメインプロセスで行い、各ワーカーには必要最小限のデータだけをシリアライズして送る。

```python
def prepare_worker_data(pair: str) -> dict:
    """ワーカーに渡すデータを最小限に絞る"""
    df = load_pair_data(pair)  # 1ペア分のみ読み込み
    return {
        "pair": pair,
        "data": df.to_dict("records"),  # シリアライズ可能な形式に変換
    }
```

### 課題2: Parquetファイルの同時読み込み競合

複数プロセスが同じParquetファイルを同時に読み込もうとすると、ファイルロックの問題が発生する場合がある。

**解決策**: データの読み込みはメインプロセスで一括実行し、ワーカーにはメモリ上のデータを渡す方式に変更。

### 課題3: 再現性の確保

並列実行では、プロセスの実行順序が不定になる。結果の順序がバラバラになると、デバッグや過去の結果との比較が困難になる。

**解決策**: 結果に必ず入力パラメータのIDを含め、全結果収集後にソートする。乱数を使う場合はシード値を入力パラメータに含めて、各ワーカーで決定的に設定する。

```python
def run_backtest_for_params(params: dict) -> dict:
    # 再現性のためにシード値を固定
    random.seed(params.get("seed", 42))
    np.random.seed(params.get("seed", 42))
    # ...
```

### 課題4: エラーハンドリング

1つのワーカーが例外で落ちると、Pool全体が影響を受ける。

**解決策**: 各ワーカー内で例外をキャッチし、エラー情報を結果として返す。メインプロセスでは「成功した結果」だけを集計し、「失敗した結果」はログに記録する。

```python
def run_backtest_for_params(params: dict) -> dict:
    try:
        # バックテスト実行
        return {"status": "success", "params": params, "result": result}
    except Exception as e:
        return {"status": "error", "params": params, "error": str(e)}
```

---

## 実行スクリプトの設計

```bash
# 基本的な使い方
python scripts/run_fast_grid_search.py \
  --pairs EUR_JPY GBP_JPY AUD_JPY \
  --workers 4 \
  --output results/grid_search_2026_03.csv

# 全通貨ペア・全パラメータ
python scripts/run_fast_grid_search.py \
  --pairs ALL \
  --workers 8 \
  --sl-range 0.5 2.0 0.5 \
  --tp-range 1.0 5.0 1.0 \
  --score-range 1.5 2.7 0.4
```

結果はCSVに出力し、以下のカラムを含む。

```
pair, sl_multiplier, tp_multiplier, min_score,
sharpe_ratio, max_drawdown, profit_factor,
total_trades, win_rate, avg_pnl
```

---

## 速度改善の結果

| 実行方式 | 720パターンの実行時間 | CPUコア使用率 |
|---------|---------------------|-------------|
| 逐次実行 | 約12時間 | 12%（1コア） |
| Pool(4workers) | 約3.5時間 | 48% |
| Pool(8workers) | 約1.8時間 | 80% |

8ワーカーで約6.7倍の高速化を達成。理論上の8倍には達しないのは、データの分配・結果の集約・メモリバスの帯域幅がボトルネックになるためだ（アムダールの法則）。

---

## 学んだこと

### 1. GILを理解していないと「並列化したのに速くならない」罠にハマる

Pythonの `threading` はI/O待ち（ネットワーク通信、ファイル読み書き）には有効だが、CPU集約的な処理（バックテスト計算）には効果がない。`multiprocessing` で別プロセスにすることでGILを回避する必要がある。

### 2. メモリは「コア数倍」を覚悟する

`multiprocessing` は各プロセスがメモリを独立に持つ。8並列なら8倍のメモリが必要になりうる。データの分割・必要最小限の転送が実装の要だ。

### 3. 再現性は並列化の最大の敵

実行順序が不定になるため、結果の順序保証・乱数シードの管理を明示的に行う必要がある。これを怠ると「昨日と違う結果が出たが、パラメータの問題か実行順序の問題か分からない」という悪夢に陥る。

---

## まとめ

バックテスト並列化の設計で重要なのは以下の3点だ。

1. **multiprocessingでGIL回避**: `threading` ではCPU集約処理は速くならない。`multiprocessing.Pool` で真の並列実行
2. **メモリ管理**: 各ワーカーに必要最小限のデータだけを渡す。全データの丸コピーはメモリ枯渇の原因
3. **再現性の確保**: 乱数シード固定・結果のIDベースソートで、並列でも決定的な結果を保証

計画7日を1日に短縮したことで、「もう1パターン試してみよう」が気軽にできるようになった。これがバックテスト高速化の最大の価値だ。
