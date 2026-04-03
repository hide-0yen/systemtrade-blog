---
author: "45395"
pubDatetime: 2026-04-03T10:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "外国人投資家フロー連動フィルター：需給環境でエントリーを制御する"
featured: false
draft: false
tags:
  - 日本株
  - エントリーフィルター
  - J-Quants
  - Python
description: "外国人投資家と信託銀行の売買フローを週次で取得し、需給環境に応じてエントリースコアにペナルティを適用するフィルターの設計と実装を解説する。"
---

日本株のシステムトレードでは、テクニカル指標が買いシグナルを出していても、外国人投資家が大量に売り越している局面では株価が下落しやすい。東証プライム市場の売買代金の約6〜7割を占める外国人投資家の売買動向は、個別銘柄のテクニカル分析では捉えられないマクロな需給環境を反映している。

JS-E7施策では、J-Quants V2の投資部門別売買状況データを活用し、外国人投資家（および信託銀行）の売り越し局面でエントリースコアにペナルティを適用する。特に外国人+信託銀行の同時売り越し（ダブルペナルティ）は強い売り圧力のシグナルであり、-2.0の強ペナルティで買いエントリーを抑制する。

---

## なぜ外国人投資家フローが重要か

### 東証プライム市場の売買シェア

```
売買代金シェア（東証プライム）:

外国人投資家  ████████████████████████████████  60-70%
個人投資家    ████████                          15-20%
信託銀行      ████                              5-10%
その他法人    ████                              5-10%

→ 外国人の売買方向 ≒ 市場全体の方向
```

外国人投資家が継続的に売り越している局面では、テクニカル的に割安に見える銘柄も需給悪化で下落が続くケースが多い。逆に、外国人が買い越しに転じると、市場全体が上昇しやすくなる。

### 信託銀行との「ダブル売り」

信託銀行（年金基金等の運用）が外国人と同時に売り越している局面は、機関投資家全体のリスクオフを示唆する。このパターンは単なる外国人の利益確定とは異なり、より構造的な売り圧力を意味する。

```
パターン1: 外国人のみ売り越し
  → 利益確定の可能性あり → ペナルティ -1.0（軽度）

パターン2: 外国人 + 信託銀行 同時売り越し
  → 機関投資家全体のリスクオフ → ペナルティ -2.0（重度）
```

---

## データソース：J-Quants 投資部門別売買状況

### APIエンドポイント

```
GET /eq/investor_types?section=TSEPrime&from_yyyymmdd=20260301&to_yyyymmdd=20260331
```

毎週木曜日に前週分（月〜金）の売買データが公表される。投資家を約10の部門に分類し、各部門の売買株数・売買金額・差引（ネット）を提供する。

### DBスキーマ

```sql
CREATE TABLE jquants_investor_types (
    pub_date        DATE NOT NULL,
    section         VARCHAR(20) NOT NULL,     -- 'TSEPrime' etc.
    investor_type   VARCHAR(50) NOT NULL,     -- 'Foreigners', 'TrustBanks' etc.
    buy_volume      BIGINT,                   -- 買い株数
    sell_volume     BIGINT,                   -- 売り株数
    net_volume      BIGINT,                   -- 差引株数
    buy_value       BIGINT,                   -- 買い金額（円）
    sell_value      BIGINT,                   -- 売り金額（円）
    net_value       BIGINT,                   -- 差引金額（円）
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (pub_date, section, investor_type)
);

-- パフォーマンス用インデックス
CREATE INDEX idx_investor_types_section_date
    ON jquants_investor_types (section, pub_date DESC);
CREATE INDEX idx_investor_types_type_date
    ON jquants_investor_types (investor_type, pub_date DESC);
```

### データ取得パイプライン

```
毎週土曜 08:00（launchd）
  → fetch_investor_types.py --mode weekly --slack
    → J-Quants /eq/investor_types API
    → PascalCase → snake_case 変換
    → jquants_investor_types テーブルへ UPSERT
    → Slack通知（成功/失敗）
```

---

## 実装

### ForeignInvestorFilter

```python
# _jsTradingEngine/core/foreign_investor_filter.py

@dataclass
class InvestorFlowData:
    pub_date: date
    section: str
    investor_type: str
    net_value: int  # 差引金額（円）


class ForeignInvestorFilter:
    def __init__(self, config: ForeignInvestorFilterConfig, logger):
        self._config = config
        self._logger = logger
        self._cache: dict[str, FlowCacheEntry] = {}

    def preload(self, trade_date: date) -> None:
        """セッション開始時に12週分のデータをDB一括取得"""
        self._load_data(trade_date)

    def get_score_penalty(self, trade_date: date) -> float:
        """ペナルティスコアを返す（0以下の値）"""
        if not self._config.enabled:
            return 0.0

        foreign_selling, trust_selling = self._evaluate_flow(trade_date)

        # ダブルペナルティ（外国人 + 信託銀行 同時売り越し）
        if foreign_selling and trust_selling and self._config.use_trust_bank:
            self._logger.warning(
                f"[JS-E7] Double selling detected: "
                f"foreign + trust bank → penalty {self._config.penalty_double}"
            )
            return self._config.penalty_double  # -2.0

        # シングルペナルティ（外国人のみ売り越し）
        if foreign_selling:
            self._logger.info(
                f"[JS-E7] Foreign selling detected: "
                f"penalty {self._config.penalty_single}"
            )
            return self._config.penalty_single  # -1.0

        return 0.0

    def check_entry_allowed(
        self, trade_date: date
    ) -> tuple[bool, str]:
        """エントリーを許可するか（blockモード用）"""
        if not self._config.enabled:
            return True, ""

        if self._config.filter_mode != "block":
            return True, ""  # penaltyモードでは常に許可

        foreign_selling, trust_selling = self._evaluate_flow(trade_date)

        if foreign_selling and trust_selling and self._config.use_trust_bank:
            return False, "Double selling: foreign + trust bank"

        return True, ""

    def _evaluate_flow(
        self, trade_date: date
    ) -> tuple[bool, bool]:
        """直近N週の外国人・信託銀行フローを評価"""
        # キャッシュからデータ取得
        cache = self._cache.get(self._config.target_section)
        if cache is None:
            return False, False  # データなし → 許可

        # 直近 lookback_weeks 週のデータを集計
        threshold_date = trade_date - timedelta(
            days=self._config.lookback_weeks * 7
        )

        # 外国人の売り越し判定
        foreign_net = sum(
            r.net_value for r in cache.records
            if r.pub_date >= threshold_date
        )
        foreign_selling = (
            foreign_net < -self._config.sell_threshold_billion * 1e9
        )

        # 信託銀行の売り越し判定
        trust_selling = False
        if self._config.use_trust_bank and cache.trust_records:
            trust_net = sum(
                r.net_value for r in cache.trust_records
                if r.pub_date >= threshold_date
            )
            trust_selling = (
                trust_net < -self._config.sell_threshold_billion * 1e9
            )

        return foreign_selling, trust_selling
```

### フェイルセーフ設計

外部データに依存するフィルターのため、データ取得失敗時の安全弁を組み込んでいる。

```python
# フェイルセーフ: データがない場合は常に許可
# → DBダウン、API障害、データ遅延時にトレードを止めない

if self._config.always_allow_if_no_data:
    # データなし → ペナルティ0（通過）
    return 0.0

# データ鮮度チェック（14日以上古いデータは無視）
if latest_pub_date < trade_date - timedelta(
    days=self._config.max_data_age_days  # 14
):
    self._logger.warning(
        f"[JS-E7] Stale data: latest={latest_pub_date}, "
        f"max_age={self._config.max_data_age_days} days"
    )
    return 0.0  # 古いデータでペナルティを適用しない
```

### トレードエンジンへの統合

```python
# _jsTradingEngine/core/trading_engine.py（統合部分）

class TradingEngine:
    def __init__(self, config: TradingConfig):
        # ... 既存の初期化 ...
        if config.foreign_investor_filter.enabled:
            self._foreign_investor_filter = ForeignInvestorFilter(
                config.foreign_investor_filter, self._logger
            )

    def load_all_triggers(self, trade_date: date):
        """トリガーファイル読み込み + フィルター適用"""
        # ... 既存のトリガー読み込み ...

        # JS-E7: 外国人投資家フロー ペナルティ適用
        if self._foreign_investor_filter is not None:
            penalty = self._foreign_investor_filter.get_score_penalty(
                trade_date
            )
            if penalty < 0:
                for signal in buy_signals:
                    signal.quality_score += penalty

    def _check_entry_filters(self, signal, market_data):
        """エントリーフィルター（blockモード）"""
        # JS-E7: 外国人フロー ブロック判定
        if self._foreign_investor_filter is not None:
            allowed, reason = (
                self._foreign_investor_filter.check_entry_allowed(
                    market_data.trade_date
                )
            )
            if not allowed:
                return False, reason

        # 他のフィルター...
        return True, ""
```

---

## パラメータ設計

```json
{
  "foreign_investor_filter": {
    "enabled": false,
    "filter_mode": "penalty",
    "lookback_weeks": 4,
    "sell_threshold_billion": 0.5,
    "penalty_single": -1.0,
    "penalty_double": -2.0,
    "use_trust_bank": true,
    "target_section": "TSEPrime",
    "min_data_weeks": 2,
    "always_allow_if_no_data": true,
    "max_data_age_days": 14
  }
}
```

### パラメータの根拠

| パラメータ | 値 | 根拠 |
|-----------|-----|------|
| `lookback_weeks` | 4 | 月間のフロー傾向を捉える。1週だと一時的な変動を拾いすぎる |
| `sell_threshold_billion` | 0.5 | 4週合計で5,000億円以上の売り越し = 明確な売り圧力 |
| `penalty_single` | -1.0 | スコア閾値1.9に対し約半分の減点。強シグナルなら通過可能 |
| `penalty_double` | -2.0 | スコア3.9以上でなければ通過不可。ほぼブロックに近い |
| `max_data_age_days` | 14 | 公表遅延（約1週間）+ バッファ1週間 |
| `always_allow_if_no_data` | true | データ障害時にトレード機会を逃さない安全弁 |

### 市場全体 vs 個別銘柄のフィルタリング粒度

本フィルターは**市場全体**（TSEプライム全体）の需給環境を見る設計である。個別銘柄の需給ではなく、マクロな資金フロー環境を判定する。

```
個別銘柄のテクニカル分析 → 「この銘柄を買うか？」
外国人フローフィルター   → 「今の市場環境で買ってよいか？」
```

この2層構造により、「個別銘柄は強いが市場環境が悪い」ケースでの損失を防ぐ。

---

## データ取得の運用設計

### launchd スケジュール

```xml
<!-- jp.systemtrade.jquants.investor_types.plist -->
<key>StartCalendarInterval</key>
<dict>
    <key>Weekday</key><integer>6</integer>  <!-- 土曜日 -->
    <key>Hour</key><integer>8</integer>
    <key>Minute</key><integer>0</integer>
</dict>
```

J-Quantsの投資部門別売買データは毎週木曜日に公表される。土曜朝8時に取得することで、木曜公表→金曜の市場反応を見た後に最新データを格納する。月曜朝のトレードエンジン実行時には最新の需給データが利用可能。

### バックフィル

```bash
# 過去データの一括取得（初回セットアップ時）
python fetch_investor_types.py --mode backfill \
    --from 2024-01-01 --to 2026-03-31 --slack
```

---

## テスト戦略

```
テスト構成（55 unit + 統合テスト）:
├── Config テスト（5件）
│   ├── デフォルト値の確認
│   ├── from_dict() デシリアライゼーション
│   └── 不正値のバリデーション
├── _evaluate_flow テスト（15件）
│   ├── 外国人売り越し判定（閾値境界）
│   ├── 信託銀行売り越し判定
│   ├── ダブル売り検出
│   ├── データなし時のフォールバック
│   └── lookback_weeks 範囲外データの除外
├── データ鮮度テスト（4件）
│   ├── max_data_age_days 以内
│   ├── max_data_age_days 超過（無視）
│   └── always_allow_if_no_data の動作
├── check_entry_allowed テスト（11件）
│   ├── penaltyモード（常にTrue）
│   ├── blockモード + 正常フロー
│   ├── blockモード + ダブル売り
│   └── enabled=false で常にTrue
├── get_score_penalty テスト（8件）
│   ├── ペナルティなし（買い越し局面）
│   ├── シングルペナルティ（-1.0）
│   ├── ダブルペナルティ（-2.0）
│   ├── use_trust_bank=false でシングルのみ
│   └── enabled=false で常に0
├── preload/_load_data テスト（5件）
│   ├── DB正常取得
│   ├── DB接続失敗時のフォールバック
│   └── 大量データのパフォーマンス
├── セキュリティテスト（2件）
│   ├── SQLインジェクション防止
│   └── パラメータバインディング確認
└── 統合テスト
    ├── TradingEngineとの統合
    ├── VWAP/PEAD/ファンダメンタルフィルターとの併用
    └── enabled=false で既存動作維持
```

---

## 他フィルターとの組み合わせ

JS-E7は他のエントリーフィルターと累積的に適用される。

```
エントリー判定フロー:

テクニカルスコア: 8.2/10 → quality_score: 2.1
  ├── JS-E5 VWAP乖離: +3.2% → penalty -1.5 → score: 0.6
  ├── JS-E7 外国人フロー: 売り越し → penalty -1.0 → score: 1.1
  ├── JS-E8 ファンダメンタル: ランクA → bonus +0.5 → score: 2.6
  └── JS-E9 PEAD: majority 2/3 → bonus +1.0 → score: 3.1

最終スコア = 2.1 + (各フィルターの合計) ≧ 1.9 でエントリー
```

---

## 期待効果

| 指標 | Before | After（予測） |
|------|--------|-------------|
| 勝率 | 48% | 50〜52%（+2〜4%） |
| 需給悪化局面の損失 | 月2-3回 | 月0-1回 |
| 見送りトレード数 | なし | 月1-3件（需給悪化で除外） |
| ダブル売り局面の回避 | なし | 強い売り圧力時にほぼブロック |

---

## まとめ

1. 外国人投資家の売買フローを週次で取得し、直近4週の累計売り越し額が5,000億円を超える局面でエントリースコアにペナルティ（-1.0）を適用する。信託銀行との同時売り越し（ダブルペナルティ）では-2.0を適用し、ほぼエントリーをブロックする

2. 市場全体（TSEプライム）の需給環境を判定するマクロフィルターとして設計。個別銘柄のテクニカル分析とは異なるレイヤーで「今の市場環境で買ってよいか」を判断する。`always_allow_if_no_data=true` と `max_data_age_days=14` のフェイルセーフにより、データ障害時にトレード機会を逃さない

3. `enabled=false` デフォルトで後方互換性を完全維持。55 unit テスト + 統合テスト全件PASS。Pre環境でのDry-Run検証後に有効化する段階的導入設計

---

## 関連記事

- 【日本株】VWAP乖離エントリーフィルター：「寄天」損失を構造的に排除する
- 【日本株】ファンダメンタル複合スコア：財務データ5軸で銘柄の質を判定する
- 【日本株】PEAD多軸サプライズ拡張：EPS単軸からEPS+売上高+営業利益の3軸判定へ
