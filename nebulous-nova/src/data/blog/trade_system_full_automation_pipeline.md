---
author: "45395"
pubDatetime: 2026-04-08T10:00:00+09:00
modDatetime: 2026-04-08T10:00:00+09:00
title: "株式トレードシステムの完全自動化：データ取得→分析→シミュレーション→Slack通知のパイプライン構築"
featured: false
draft: false
tags:
  - 日本株
  - Python
  - 自動売買
  - バックテスト
  - テクニカル分析
description: "株式・FXトレードシステムのパイプライン全体像を解説。データ取得からParquet保存、テクニカル分析、売買シミュレーション、DB格納、Slack+メール通知までの自動化構成を記録する。"
---

# 株式トレードシステムの完全自動化：データ取得→分析→シミュレーション→Slack通知のパイプライン構築

トレードシステムの個々のコンポーネント（テクニカル分析、バックテスト、通知など）は単体で解説されることが多いが、**パイプライン全体をどう繋げるか**の情報は少ない。データ取得から通知までが一気通貫で動く仕組みがなければ、毎回手動でスクリプトを実行する羽目になる。

本記事では、systemtradeプロジェクトで構築したパイプラインの全体像を記録する。株式とFXで3種のトレードスタイル、計6プログラムが自動稼働している。

---

## パイプラインの全体像

```
データ取得（API）
    ↓
Parquetファイルに保存
    ↓
テクニカル分析計算
    ↓
売買シミュレーション
    ↓
DB格納（結果の永続化）
    ↓
Slack通知 + メール通知
```

各ステージは独立したPythonモジュールとして実装されており、パイプライン制御スクリプトが順番に呼び出す。各ステージが失敗した場合はそこで停止し、Slackにエラー通知を送る。

---

## 6プログラムの構成

3種のトレードスタイル × 2市場（株式・FX）で、計6つの売買シミュレーションプログラムが存在する。

| プログラム | 市場 | スタイル | 実行タイミング |
|-----------|------|---------|-------------|
| `_simJSSwingTrade` | 日本株 | スイング | 日次（市場クローズ後） |
| `_simJSDayTrade` | 日本株 | デイトレ | 日次（市場クローズ後） |
| `_simJSScalpingTrade` | 日本株 | スキャルピング | 日次（市場クローズ後） |
| `_simFXSwingTrade` | FX | スイング | 毎時（H4足確定後） |
| `_simFXDayTrade` | FX | デイトレ | 毎時（H1足確定後） |
| `_simFXScalpingTrade` | FX | スキャルピング | 毎時（M15足確定後） |

日本株は市場が閉まった後の1回実行、FXは24時間市場のため毎時実行という違いがある。

---

## ステージ1: データ取得

### データソース

| 市場 | データソース | 取得データ |
|------|-----------|----------|
| 日本株 | J-Quants API | 日足OHLCV、財務データ |
| FX | OANDA API等 | H4/H1/M15足OHLCV |

※利用しているAPI名は実際の環境に基づくもの。各APIの利用規約を遵守すること。

### 取得処理の実装パターン

```python
from pathlib import Path
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)

def fetch_and_save(
    pair: str,
    timeframe: str,
    data_dir: Path,
    days_back: int = 365,
) -> Path:
    """
    データを取得してParquetファイルに保存する。

    Args:
        pair: 通貨ペアまたは銘柄コード
        timeframe: 時間足（"D", "H4", "H1", "M15"）
        data_dir: 保存先ディレクトリ
        days_back: 何日分取得するか

    Returns:
        保存したParquetファイルのパス
    """
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days_back)

    # API呼び出し（具体的な実装はデータソースごとに異なる）
    raw_data = call_api(pair, timeframe, start_date, end_date)

    # DataFrameに変換
    df = parse_to_dataframe(raw_data)

    # Parquetで保存（CSVより読み書きが高速かつ型情報を保持）
    output_path = data_dir / f"{pair}_{timeframe}.parquet"
    df.to_parquet(output_path, index=False)

    logger.info(
        "データ保存完了: %s (%d行, %.1f KB)",
        output_path.name,
        len(df),
        output_path.stat().st_size / 1024,
    )
    return output_path
```

**Parquetを採用した理由**: CSVと比較して読み書き速度が速く、カラムの型情報（datetime, float64など）が保持される。毎時実行のFXパイプラインでは、この速度差が積み重なると無視できない。

---

## ステージ2: テクニカル分析計算

取得したOHLCVデータに対してテクニカル指標を計算し、DataFrameにカラムとして追加する。

```python
import pandas as pd

def calculate_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """テクニカル指標を計算してカラム追加"""
    # 移動平均線
    df["sma_20"] = df["close"].rolling(window=20).mean()
    df["sma_50"] = df["close"].rolling(window=50).mean()

    # RSI
    df["rsi_14"] = calculate_rsi(df["close"], period=14)

    # MACD
    ema_12 = df["close"].ewm(span=12).mean()
    ema_26 = df["close"].ewm(span=26).mean()
    df["macd"] = ema_12 - ema_26
    df["macd_signal"] = df["macd"].ewm(span=9).mean()

    # 一目均衡表（別記事で詳述）
    ichimoku = calculate_ichimoku_for_df(df)
    df = pd.concat([df, ichimoku], axis=1)

    # 酒田五法（別記事で詳述）
    df["sakata_signal"] = detect_sakata_patterns(df)

    return df
```

計算済みのDataFrameもParquetで保存し、次のステージに渡す。

---

## ステージ3: 売買シミュレーション

テクニカル指標のシグナルに基づいて売買判定を行い、ポジションの管理とP/L（損益）計算を実行する。

```python
from dataclasses import dataclass
from datetime import datetime

@dataclass
class TradeRecord:
    """1トレードの記録"""
    entry_datetime: datetime
    exit_datetime: datetime | None
    action: str                  # "BUY" | "SELL"
    signal_name: str             # シグナル名（例: "golden_cross"）
    symbol: str                  # 銘柄コード or 通貨ペア
    price: float                 # エントリー価格
    quantity: int | float        # 数量
    total_amount: float          # 総額
    exit_price: float | None     # 決済価格
    pnl: float | None            # 損益
    result: str | None           # "WIN" | "LOSE" | None（未決済）

def run_simulation(
    df: pd.DataFrame,
    initial_capital: float,
    risk_per_trade: float = 0.02,
) -> list[TradeRecord]:
    """
    売買シミュレーションを実行

    Args:
        df: テクニカル指標計算済みのDataFrame
        initial_capital: 初期資金
        risk_per_trade: 1トレードあたりのリスク比率（2%）

    Returns:
        トレード記録のリスト
    """
    trades: list[TradeRecord] = []
    capital = initial_capital
    position: TradeRecord | None = None

    for i, row in df.iterrows():
        # エントリー判定（ポジションなしの場合）
        if position is None:
            signal = evaluate_entry_signal(row)
            if signal is not None:
                quantity = calculate_position_size(
                    capital, row["close"], risk_per_trade,
                )
                position = TradeRecord(
                    entry_datetime=row["datetime"],
                    exit_datetime=None,
                    action=signal["action"],
                    signal_name=signal["name"],
                    symbol=row.get("symbol", ""),
                    price=row["close"],
                    quantity=quantity,
                    total_amount=row["close"] * quantity,
                    exit_price=None,
                    pnl=None,
                    result=None,
                )

        # エグジット判定（ポジションありの場合）
        elif should_exit(row, position):
            position.exit_datetime = row["datetime"]
            position.exit_price = row["close"]

            if position.action == "BUY":
                position.pnl = (row["close"] - position.price) * position.quantity
            else:
                position.pnl = (position.price - row["close"]) * position.quantity

            position.result = "WIN" if position.pnl > 0 else "LOSE"
            capital += position.pnl
            trades.append(position)
            position = None

    return trades
```

---

## ステージ4: DB格納

シミュレーション結果はデータベースに格納し、過去の実績と合わせて分析できるようにする。

```python
import sqlite3
from pathlib import Path

def save_trades_to_db(
    trades: list[TradeRecord],
    db_path: Path,
) -> int:
    """トレード結果をSQLiteに保存"""
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_datetime TEXT NOT NULL,
            exit_datetime TEXT,
            action TEXT NOT NULL,
            signal_name TEXT NOT NULL,
            symbol TEXT NOT NULL,
            price REAL NOT NULL,
            quantity REAL NOT NULL,
            total_amount REAL NOT NULL,
            exit_price REAL,
            pnl REAL,
            result TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    inserted = 0
    for trade in trades:
        cursor.execute(
            """INSERT INTO trades
               (entry_datetime, exit_datetime, action, signal_name,
                symbol, price, quantity, total_amount,
                exit_price, pnl, result)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                trade.entry_datetime.isoformat(),
                trade.exit_datetime.isoformat() if trade.exit_datetime else None,
                trade.action,
                trade.signal_name,
                trade.symbol,
                trade.price,
                trade.quantity,
                trade.total_amount,
                trade.exit_price,
                trade.pnl,
                trade.result,
            ),
        )
        inserted += 1

    conn.commit()
    conn.close()
    return inserted
```

---

## ステージ5: Slack + メール通知

通知は2系統で冗長化している。Slackは即時確認用、メールはSlack障害時のバックアップだ。

### Slack通知

```python
import json
import urllib.request
import os
from dotenv import load_dotenv

load_dotenv()

def notify_slack(trades: list[TradeRecord]) -> None:
    """トレード結果をSlackに通知"""
    webhook_url = os.getenv("SLACK_WEBHOOK_URL")
    if webhook_url is None:
        logger.warning("SLACK_WEBHOOK_URL が未設定。Slack通知をスキップ。")
        return

    for trade in trades:
        if trade.result is None:
            continue

        emoji = ":chart_with_upwards_trend:" if trade.result == "WIN" else ":chart_with_downwards_trend:"
        pnl_str = f"+{trade.pnl:,.0f}" if trade.pnl and trade.pnl > 0 else f"{trade.pnl:,.0f}"

        message = {
            "text": (
                f"{emoji} *{trade.action}* {trade.symbol}\n"
                f"シグナル: {trade.signal_name}\n"
                f"エントリー: {trade.price:,.2f} → 決済: {trade.exit_price:,.2f}\n"
                f"数量: {trade.quantity} | 損益: {pnl_str}円\n"
                f"結果: *{trade.result}*"
            ),
        }

        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(message).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req)
```

### メール通知

```python
import smtplib
from email.mime.text import MIMEText

def notify_email(trades: list[TradeRecord], summary: str) -> None:
    """トレードサマリーをメールで送信"""
    smtp_server = os.getenv("SMTP_SERVER")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    sender = os.getenv("EMAIL_SENDER")
    password = os.getenv("EMAIL_PASSWORD")
    recipient = os.getenv("EMAIL_RECIPIENT")

    if any(v is None for v in [smtp_server, sender, password, recipient]):
        logger.warning("メール設定が不完全。メール通知をスキップ。")
        return

    # トレードサマリーの組み立て
    body_lines = [summary, "", "--- 個別トレード ---"]
    for trade in trades:
        if trade.result is None:
            continue
        body_lines.append(
            f"{trade.entry_datetime:%Y-%m-%d %H:%M} | {trade.action} | "
            f"{trade.signal_name} | {trade.symbol} | "
            f"{trade.price:,.2f} → {trade.exit_price:,.2f} | "
            f"数量: {trade.quantity} | 損益: {trade.pnl:,.0f}円 | {trade.result}"
        )

    msg = MIMEText("\n".join(body_lines), "plain", "utf-8")
    msg["Subject"] = f"トレード結果: {len(trades)}件"
    msg["From"] = sender  # type: ignore[arg-type]
    msg["To"] = recipient  # type: ignore[arg-type]

    with smtplib.SMTP(smtp_server, smtp_port) as server:  # type: ignore[arg-type]
        server.starttls()
        server.login(sender, password)  # type: ignore[arg-type]
        server.send_message(msg)
```

### 二重通知の設計意図

| 通知 | 用途 | 特性 |
|------|------|------|
| Slack | リアルタイム確認 | 即時性が高い。スマホで確認可能 |
| メール | バックアップ | Slack障害時でも確実に届く。検索しやすい |

Slackだけでは障害時に通知を見逃す。メールだけでは確認が遅れる。両方送ることで「見逃し」を防いでいる。

---

## パイプライン制御

各ステージを順番に呼び出すメインスクリプトの構造。

```python
import sys
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

def run_pipeline(
    program_name: str,
    config: dict[str, str | int | float | Path],
) -> bool:
    """パイプラインを順番に実行"""
    try:
        # ステージ1: データ取得
        logger.info("[%s] ステージ1: データ取得開始", program_name)
        data_path = fetch_and_save(
            pair=config["pair"],          # type: ignore[arg-type]
            timeframe=config["timeframe"],  # type: ignore[arg-type]
            data_dir=config["data_dir"],    # type: ignore[arg-type]
        )

        # ステージ2: テクニカル分析
        logger.info("[%s] ステージ2: テクニカル分析開始", program_name)
        df = pd.read_parquet(data_path)
        df = calculate_indicators(df)

        # ステージ3: 売買シミュレーション
        logger.info("[%s] ステージ3: シミュレーション開始", program_name)
        trades = run_simulation(df, initial_capital=config["capital"])  # type: ignore[arg-type]

        # ステージ4: DB格納
        logger.info("[%s] ステージ4: DB格納", program_name)
        save_trades_to_db(trades, config["db_path"])  # type: ignore[arg-type]

        # ステージ5: 通知
        logger.info("[%s] ステージ5: 通知送信", program_name)
        completed_trades = [t for t in trades if t.result is not None]
        if completed_trades:
            summary = generate_summary(completed_trades)
            notify_slack(completed_trades)
            notify_email(completed_trades, summary)

        logger.info("[%s] パイプライン完了: %d件の取引", program_name, len(completed_trades))
        return True

    except Exception:
        logger.exception("[%s] パイプラインエラー", program_name)
        # エラー時もSlackに通知
        notify_slack_error(program_name, sys.exc_info())
        return False
```

---

## Windows Task Schedulerによる定期実行

6プログラムはWindows Task Schedulerで定期実行している。※macOSの場合は`launchd`で同等の定期実行が可能だ。

```
日本株（3プログラム）: 毎営業日 16:00（東証クローズ後）に実行
FX（3プログラム）: 毎時00分に実行（24時間365日）
```

タスクスケジューラの設定や、XML定義のテンプレート化については、別途45395.jpの記事で詳しく扱う予定だ。

---

## 仕様書の同時改訂ワークフロー

パイプラインのコードを変更する際は、仕様書も同時に更新する運用にしている。

```
1. 仕様変更の要件定義
2. 仕様書を更新（変更箇所をマークダウンで記述）
3. コードを変更
4. テスト実行
5. 仕様書とコードの差分を確認
6. コミット（仕様書とコードをセットで）
```

「コードは動くが仕様書が古い」状態を防ぐため、**仕様書の更新をコードの変更より先に行う**ルールにしている。仕様書が先にあれば、コードレビューの際に「仕様通りに実装されているか」を確認できる。

---

## まとめ

トレードシステムの完全自動化で重要なのは以下の3点だ。

1. **5ステージのパイプライン設計**: データ取得→分析→シミュレーション→DB格納→通知。各ステージを独立モジュールにして、障害の影響範囲を限定する
2. **Slack + メールの二重通知**: 即時性（Slack）と確実性（メール）の両立。片方が障害でも見逃さない
3. **6プログラムの統一アーキテクチャ**: 3トレードスタイル × 2市場 = 6プログラムだが、パイプラインの構造は共通。設定値（通貨ペア、時間足、実行タイミング）だけが異なる

個々のテクニカル分析やバックテストの精度向上も重要だが、それ以上に**パイプライン全体が安定して動き続けること**がシステムトレードの基盤になる。
