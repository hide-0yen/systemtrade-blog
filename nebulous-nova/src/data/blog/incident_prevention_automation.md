---
author: "45395"
pubDatetime: 2026-04-01T15:00:00+09:00
modDatetime: 2026-04-03T10:00:00+09:00
title: "インシデント再発防止と自動検証：137件の障害を未然に防いだ仕組み"
featured: false
draft: false
tags:
  - インフラ
  - 自動売買
description: "自動売買システムの過去インシデントを分析し6つの再発防止策を実装。自動検証スクリプトで137件の潜在障害を事前検出した仕組みを解説する。"
---

自動売買システムは「動いていないこと」に気づくのが最も難しい。株やFXの売買シグナルが正しく出力されていなくても、エラーログを毎日チェックしなければ気づかない。そして気づいたときには、本来取れていたはずの利益を逃している。

本記事では、過去のインシデント（障害）を分析して6つの再発防止策（F-01〜F-06）を実装した経緯と、自動検証スクリプトで137件の潜在障害を事前に検出・防止した仕組みを記録する。

---

## インシデント再発防止（SYS-P-INCIDENT）

### F-01: validate_launchd_health.sh の環境変数・Preパス検証

macOSの`launchd`（定時実行デーモン）でPythonスクリプトを動かしているが、`launchd`経由の実行では通常のシェル環境変数が使えない。

```xml
<!-- plistファイルでの環境変数設定 -->
<key>EnvironmentVariables</key>
<dict>
    <key>PROJECT_ROOT</key>
    <string>/Volumes/work/systemtrade</string>
    <key>PYTHONPATH</key>
    <string>/Volumes/work/systemtrade</string>
</dict>
```

過去のインシデントでは、`PROJECT_ROOT`が未設定のまま`launchd`ジョブが実行され、データファイルのパスが解決できずにサイレントに失敗していた。

**対策**: `validate_launchd_health.sh`に環境変数チェックを追加し、`PROJECT_ROOT`と`PYTHONPATH`が全plistファイルに設定されていることを自動検証する。

### F-02: load_dotenv追加

`.env`ファイル（環境変数定義ファイル）から`SLACK_WEBHOOK_URL`などのシークレット値を読み込む`load_dotenv()`が、一部のスクリプトで欠落していた。

```python
# Before: .envが読み込まれず、Slack通知が送れない
import os
webhook_url = os.getenv("SLACK_WEBHOOK_URL")  # → None

# After: load_dotenvで.envファイルを読み込み
from dotenv import load_dotenv
load_dotenv()
webhook_url = os.getenv("SLACK_WEBHOOK_URL")  # → "https://hooks.slack.com/..."
```

### F-03: US mypy統合

mypy（Pythonの静的型チェッカー）を米国株エンジンにも適用した。型チェックにより、実行時エラーの原因となる型の不一致をデプロイ前に検出できる。

### F-04: CI/CD developトリガー

GitHub Actionsのワークフローが`main`ブランチへのPushのみで起動する設定だった。`develop`ブランチでの変更もCIで検証するようトリガーを追加した。

```yaml
on:
  push:
    branches: [main, develop] # developを追加
  pull_request:
    branches: [main, develop] # developを追加
```

### F-05: JS絶対インポート修正

日本株エンジンで相対インポート（`from ..utils import ...`）を使っていた箇所を絶対インポート（`from _jsTradingEngine.utils import ...`）に修正した。相対インポートは`launchd`経由の実行でPYTHONPATHの設定次第で失敗するリスクがある。

### F-06: pre-commitフック3種

`git commit`時に自動実行されるチェック（pre-commitフック）を3種類追加した。

```
1. mypy型チェック: 型エラーのあるコードのコミットを防止
2. テスト実行: ユニットテストがPASSしないコードのコミットを防止
3. plistバリデーション: 不正なplistファイル（launchd設定）のコミットを防止
```

---

## Phase 2 自動検証スクリプト（SYS-P-PHASE2）

### 計画3週間が1日で完了

当初3週間を見込んでいた自動検証スクリプトの開発が、1日で完了した（350%の短縮）。CI/CDパイプラインの構築経験が蓄積されていたことと、検証項目が明確だったことが要因だ。

### 137件の潜在障害を検出

自動検証スクリプトを全システム（FX・日本株・米国株）に適用した結果、137件の潜在的な障害を検出した。

```
検出カテゴリ:
  環境変数の未設定/不整合:  23件
  インポートパスの問題:     18件
  plistファイルの設定漏れ:  12件
  型チェックエラー:         41件
  テストカバレッジ未達:     28件
  設定ファイルの整合性:     15件
  合計:                    137件
```

これらは「今は偶然動いているが、環境変更やデプロイ時に顕在化する」種類の問題だ。137件のうち、過去に実際にインシデントとして顕在化した問題と同種のものが23件含まれていた。

### 検証の自動実行

```bash
# validate_launchd_health.sh の実行例
$ ./scripts/validate_launchd_health.sh

[CHECK] plist環境変数検証...
  ✅ fx_swing_gmo.plist: PROJECT_ROOT=OK, PYTHONPATH=OK
  ✅ fx_day_gmo.plist: PROJECT_ROOT=OK, PYTHONPATH=OK
  ✅ js_trading.plist: PROJECT_ROOT=OK, PYTHONPATH=OK
  ❌ us_trading.plist: PYTHONPATH=MISSING  ← 検出！

[CHECK] ログ鮮度検証（最終実行から24時間以内か）...
  ✅ fx_swing: 2026-03-27 09:05:00 (2時間前)
  ✅ fx_day: 2026-03-27 08:30:00 (2.5時間前)
  ❌ us_trading: 2026-03-25 22:00:00 (2日前) ← 停止疑い！
```

---

## 学んだこと

### 1. サイレント障害が最も怖い

エラーでクラッシュするバグは気づける。しかし「エラーは出ないが正しく動いていない」サイレント障害は気づけない。`launchd`ジョブが静かに失敗し、数日間シグナルが出力されていなかったインシデントが最も損失が大きかった。

### 2. pre-commitフックは「最も安い保険」

コミット時の自動チェックは、実装コストが低い割に効果が高い。型エラーや設定ミスをデプロイ前に検出できる。

### 3. 検証スクリプトは「投資」ではなく「保険」

137件の潜在障害を事前に検出したことで、将来のインシデント対応工数を大幅に削減した。検証スクリプトの開発に1日かかったが、137件のうち1件でも本番障害になれば、調査・修正・再デプロイに半日〜1日かかる。投資対効果は極めて高い。

---

## まとめ

インシデント再発防止で重要なのは以下の3点だ。

1. **6つの再発防止策（F-01〜F-06）**: 環境変数検証・load_dotenv・mypy・CI/CDトリガー・絶対インポート・pre-commitフック
2. **自動検証スクリプト**: 137件の潜在障害を事前検出。サイレント障害を防ぐ「見える化」
3. **ログ鮮度チェック**: launchdジョブが実際に実行されたかを最終ログ時刻で自動検証

「動いているはず」ではなく「動いていることを証明する」仕組みが、自動売買の安定運用を支える。
