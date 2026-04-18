---
author: "45395"
pubDatetime: 2025-09-11T10:00:00+09:00
modDatetime: 2026-04-18T10:00:00+09:00
title: システムトレードで大量のデータを扱う
featured: false
draft: false
tags:
  - インフラ
description: システムトレードで時系列データを扱うためにMySQLからPostgreSQL＋TimescaleDBへ移行した経緯、ハイパーテーブルと連続集計を使った運用の勘所を紹介します。
---

## システムトレードにおけるデータベース選び

私の場合、将来的には **Cloud環境** でシステムを運用したいと考えていますが、現在はローカル（Mac）で開発を進めています。

システムトレードでは株価などの **大量の時系列データ** を処理・保存する必要があります。  
最初は手軽さから **MySQL** を採用しましたが、データ量が増えるにつれて処理が追いつかなくなり、より堅牢な **PostgreSQL** に移行しました。

---

## TimescaleDBを選んだ理由

さらに、膨大な時系列データを効率的に扱うために、PostgreSQLの拡張機能である **[TimescaleDB](https://www.tigerdata.com/)** を採用しています。

TimescaleDBは、時系列データの保存と解析に特化したデータベース拡張で、以下のような特徴があります。

- **高速なINSERT性能**  
  毎秒数百万件規模のデータ書き込みにも対応可能。株価やFXのティックデータのような高速更新に強いです。

- **優れた集計処理**  
  時系列データに対して効率的なロールアップや統計処理を実行可能。移動平均やボリンジャーバンドなどのテクニカル分析の計算にも適しています。

- **PostgreSQL互換**  
  SQL文をそのまま利用できるため、既存のPostgreSQLの知識が活かせます。

- **スケーラビリティ**  
  将来的にCloud環境へ移行した際も、大規模データの分散処理に対応できます。

---

## 注意点と利点

TimescaleDBは **更新や削除操作にはやや不向き** ですが、その代わりに **INSERTや集計が非常に高速** です。  
システムトレードのように「追記型のデータが中心で、分析処理が多い」ケースでは特に相性が良いと感じています。

また、オープンソースで **無料で利用できる** のも大きな魅力です。  
ただし、扱うには多少の学習コストが必要になります。それでも、処理速度や安定性を考えれば、システムトレードを実装する上で **必須の技術** だと思います。

---

## MySQL から PostgreSQL へ移行したときに詰まった点

実際に MySQL からデータを引っ越す際、単純な `mysqldump` → `psql` では通らず、以下のような差分に注意が必要でした。

- **日付型のデフォルト値**: MySQL の `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` は PostgreSQL にそのままの構文がなく、トリガーで代用します。
- **AUTO_INCREMENT**: PostgreSQL では `GENERATED ALWAYS AS IDENTITY` もしくは `SERIAL` に置き換えます。
- **`\`（バッククォート）**: PostgreSQL では識別子クォートがダブルクォート `"` になります。
- **`TINYINT(1)` → `BOOLEAN`**: 真偽値の扱いが違うため、アプリケーション側の比較ロジックも見直しが必要でした。

MySQL 側で CSV にエクスポートしてから PostgreSQL の `COPY` で流し込むのが、最終的には一番速く確実でした。

```sql
-- PostgreSQL 側での一括ロード例
COPY ohlc (symbol, ts, open, high, low, close, volume)
FROM '/tmp/ohlc_2024.csv'
WITH (FORMAT csv, HEADER true);
```

---

## ハイパーテーブルの作成例

TimescaleDB の主役は **ハイパーテーブル** です。通常のテーブルと同じように `CREATE TABLE` した後、`create_hypertable` を呼び出すことで、時間軸でチャンクに自動分割される仕組みに変わります。

```sql
-- 拡張を有効化
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 通常のテーブルを作成
CREATE TABLE ohlc (
  symbol   TEXT        NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  open     NUMERIC(12, 4),
  high     NUMERIC(12, 4),
  low      NUMERIC(12, 4),
  close    NUMERIC(12, 4),
  volume   BIGINT
);

-- ハイパーテーブル化（chunk_time_interval は 1 日）
SELECT create_hypertable(
  'ohlc',
  'ts',
  chunk_time_interval => INTERVAL '1 day'
);

-- 検索で多用する複合インデックス
CREATE INDEX ON ohlc (symbol, ts DESC);
```

チャンク間隔は **データ量と検索パターン** を見ながら決めます。ティックデータなら 1 時間、日足なら 1 ヶ月といった単位が扱いやすく、ひとつのチャンクが数百 MB を超えないよう調整するのがコツです。

---

## 連続集計（Continuous Aggregates）の活用

システムトレードでは「5 分足」「1 時間足」「日足」といった粒度の異なるロウソク足を、同じ元データから何度も作り直すシーンが頻出します。TimescaleDB の **連続集計** を使うと、あらかじめ集計結果をマテリアライズしておき、更新だけを差分で回すことができます。

```sql
CREATE MATERIALIZED VIEW ohlc_1h
WITH (timescaledb.continuous) AS
SELECT
  symbol,
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  first(open,  ts) AS open,
  max(high)         AS high,
  min(low)          AS low,
  last(close, ts)   AS close,
  sum(volume)       AS volume
FROM ohlc
GROUP BY symbol, bucket;

-- 自動リフレッシュポリシー（直近 1 日を 5 分ごとに更新）
SELECT add_continuous_aggregate_policy(
  'ohlc_1h',
  start_offset      => INTERVAL '1 day',
  end_offset        => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes'
);
```

バックテスト時に「1 時間足の移動平均」を毎回計算する代わりに、`ohlc_1h` を参照するだけで済むようになり、大規模データでも応答が秒単位に収まります。

---

## 圧縮と保持ポリシー

ティックデータを溜め続けるとすぐにディスクを圧迫するため、**圧縮ポリシー** と **保持ポリシー** をセットで設定しておくと安心です。

```sql
-- 圧縮を有効化（カラム指向に自動変換）
ALTER TABLE ohlc SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol',
  timescaledb.compress_orderby   = 'ts DESC'
);

-- 30 日より古いチャンクを自動圧縮
SELECT add_compression_policy('ohlc', INTERVAL '30 days');

-- 5 年より古いチャンクを自動削除
SELECT add_retention_policy('ohlc', INTERVAL '5 years');
```

私の環境では圧縮後のサイズが 1/8 程度まで縮み、過去データをすべてオンラインで持ちながらもディスク使用量を抑えられています。

---

## 今後について

実際の運用ではここに加え、Python の SQLAlchemy から非同期で INSERT する構成や、`pg_cron` を使ったバッチ集計なども組み合わせています。詳しい使い方や、実際にシステムトレードでどのようにTimescaleDBを活用しているかは、また別の記事で紹介していく予定です。
