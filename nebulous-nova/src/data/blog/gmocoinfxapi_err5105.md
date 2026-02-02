---
author: "45395"
pubDatetime: 2026-02-02T10:00:00+09:00
modDatetime: 2026-02-02T10:00:00+09:00
title: 【5日間の死闘】GMO Coin FX API ERR-5105の真犯人は二重JSON化
featured: false
draft: false
tags:
  - トラブルシューティング
  - GMOCoinFXAPI
  - テクニカル分析
  - Python
  - JSON
  - デバッグ
  - GMOCoinFXAPI
  - エラー解決
  - API統合
  - FX自動売買
description: GMO Coin FX APIでのERR-5105のトラブルシューティングについて解説しています。
---

# 【5日間の死闘】GMO Coin FX API ERR-5105の真犯人は二重JSON化

## 🔥 要約

GMO Coin FX APIを使ったFX自動売買システムで、2025年12月31日から2026年1月5日まで**5日間連続**でERR-5105エラーが発生。HTTP 404エラー、型不一致エラー、パラメータ削除、最小ロット修正...全ての対策を試しても解決しませんでした。

**真犯人は「二重JSON化」だった。**

`place_order()`で`json.dumps()`、`_request()`で再度`json.dumps()`を実行し、JSONがさらにJSON化されてエスケープされた文字列になっていた。GMOサポートの「正常なJSON形式でない」という曖昧な指摘から、`isinstance(body, str)`による型チェックを追加してERR-5105を完全解消。

**この記事で学べること**:
- GMO Coin FX API ERR-5105エラーの具体的な解決方法
- 二重JSON化問題の診断と修正テクニック
- API統合デバッグの体系的アプローチ
- GMOサポート問い合わせの効果的な活用法

---

## 📅 5日間のエラー履歴タイムライン

### Day 1: 2025-12-31 07:00 - 練習 mode初日の悪夢

**背景**: この日は待ちに待ったGMO Coin FX APIを使った**練習 mode（最小ロット実運用）開始日**だった。バックテストで破産確率0%を達成し、DryRunモードでも問題なし。満を持しての本番運用開始...のはずだった。

**エラー内容**:
```bash
2025-12-31 07:00:15 [ERROR] 注文実行エラー: HTTP 404
全7通貨ペアの注文が失敗
```

**リクエスト**:
```json
{
  "symbol": "USD_JPY",
  "side": "SELL",
  "executionType": "MARKET",
  "size": "1000",
  "settleType": "OPEN",
  "timeInForce": "FAK"
}
```

**初期仮説**: MARKET注文で`price`パラメータが不要なのに指定していた？

**対策**: `price: null`を削除 → **失敗（HTTP 404継続）**

**次の**: 「DryRunで動いていたのになぜか動かない。APIドキュメントを読み直し」

---

### Day 2: 2026-01-01 07:00 - HTTP 404の原因判明

**WebFetch調査**: GMO Coin FX API公式ドキュメントを改めて調査

**発見**: `settleType`と`timeInForce`はGMO Coin **Crypto API専用**パラメータで、**FX APIには存在しない**！

公式ドキュメントのサンプルコードが混在していたため、誤って使用していた。

**対策**: `settleType`と`timeInForce`を削除

**リクエスト**（修正版）:
```json
{
  "symbol": "USD_JPY",
  "side": "SELL",
  "executionType": "MARKET",
  "size": "1000"
}
```

**実行結果**: HTTP 404は解消 → **しかし新たなエラー「ERR-5105」が登場**

```json
{
  "status": 1,
  "messages": [{
    "message_code": "ERR-5105",
    "message_string": "Request parameter include mismatch type."
  }],
  "responsetime": "2026-01-01T22:00:38.495Z"
}
```

---

### Day 3: 2026-01-02 07:00 - 型変更の迷走

**仮説1**: `size`パラメータは文字列型であるべき？

**対策**: `size`を数値型（`1000`）→ 文字列型（`"1000"`）に変更

**結果**: **ERR-5105継続**

```python
# 修正コード
body_dict = {
    "symbol": symbol,
    "side": side.upper(),
    "executionType": execution_type.upper(),
    "size": str(size)  # 文字列型に変更
}
```

**仮説2**: `losscutPrice`（ストップロス価格）の型が不正？

**対策**: `losscutPrice`パラメータ削除（MARKET注文では使えない可能性）

**結果**: **ERR-5105継続**


---

### Day 4: 2026-01-03 07:00 - 最小ロット問題の発覚

**WebFetch調査**: GMO Coin FX API取引ルール（GET /public/v1/rules）を確認

**発見**: **最小注文数量（minOpenOrderSize）は10,000通貨**だった！

従来のOANDA API（最小1,000通貨）と混同していた。

**対策**: `size`を`1000` → `10000`に修正

**リクエスト**（修正版）:
```json
{
  "symbol": "NZD_JPY",
  "side": "SELL",
  "executionType": "MARKET",
  "size": "10000"
}
```

**実行結果**: **ERR-5105継続**

```json
{
  "status": 1,
  "messages": [{
    "message_code": "ERR-5105",
    "message_string": "Request parameter include mismatch type."
  }]
}
```


---

### Day 5-1: 2026-01-04 09:00 - SELL方向制限仮説の検証

**新仮説**: GMO Coin FX APIでは**SELL方向（空売り）が制限**されている？

**検証**: USD_JPYで**BUY注文**を実行

**リクエスト**:
```json
{
  "symbol": "USD_JPY",
  "side": "BUY",
  "executionType": "MARKET",
  "size": "10000"
}
```

**実行結果**: **BUYでもERR-5105発生**

**結論**: SELL direction特有の問題ではない。より根本的なパラメータ問題が存在。


---

### Day 5-2: 2026-01-04 14:00 - GMOサポート問い合わせ

**問い合わせ内容**:
> MARKET注文でERR-5105（型不一致）エラーが継続的に発生しています。リクエストボディは公式ドキュメント通りで、settleType/timeInForce削除、size型修正、最小ロット10,000通貨に変更済みですが解決しません。

**GMO回答**（翌日）:
> お問い合わせいただいたエラー（ERR-5105）の場合、設定いただいているリクエストボディが**正常なjson形式でない**ことが考えられます。

---

### Day 5-3: 2026-01-05 19:00 - 真犯人発見！

GMOサポートの「正常なJSON形式でない」という曖昧な指摘を受け、JSON生成ロジックを再精査。

**コードレビュー**:

```python
# place_order() メソッド (L1883)
body_dict = {
    "symbol": symbol,
    "side": side.upper(),
    "executionType": execution_type.upper(),
    "size": str(size)
}
body_json = json.dumps(body_dict)  # 🔴 1回目のJSON化
response = self._request("POST", "/v1/order", body=body_json)

# _request() メソッド (L1393) - 修正前
body_str = json.dumps(body) if body else ""  # 🔴 2回目のJSON化（誤り）
```

**発見**: `place_order()`で既にJSON化された文字列を、`_request()`で再度JSON化していた！

**実際に送信されていたデータ**:
```json
"{\"symbol\": \"USD_JPY\", \"side\": \"BUY\", \"executionType\": \"MARKET\", \"size\": \"10000\"}"
```

→ JSON文字列がさらにJSON化され、**ダブルクォートでエスケープされた文字列**になっていた

GMO APIが期待していたのは:
```json
{"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}
```

しかし実際に受信したのは:
```json
"{\"symbol\": \"USD_JPY\", \"side\": \"BUY\", \"executionType\": \"MARKET\", \"size\": \"10000\"}"
```

これでは**文字列型の値**として認識され、JSONオブジェクトとしてパースできない。


---

### Day 5-4: 2026-01-05 19:30 - 修正と検証

**修正内容**（`execution/core/gmo_client.py:1393-1399`）:

```python
# 修正前
body_str = json.dumps(body) if body else ""

# 修正後
# bodyが既にJSON文字列の場合はそのまま使用、dictの場合はJSON化
if isinstance(body, str):
    body_str = body  # ✅ 既にJSON化済みならそのまま使用
elif body:
    body_str = json.dumps(body)  # ✅ dictならJSON化
else:
    body_str = ""
```

**検証**:

```bash
PYTHONPATH=/Users/htada/systemtrade/_fxTradingEngine:/Users/htada/systemtrade \
  /opt/anaconda3/envs/st312/bin/python \
  execution/main_forward_test_gmo.py \
  --trade-type Swing --mode 練習 --once
```

**実行結果**: ✅ **ERR-5105エラー完全解消！**

新しいエラー: **ERR-201: Trading margin is insufficient**（証拠金不足）

```json
{
  "status": 1,
  "messages": [{
    "message_code": "ERR-201",
    "message_string": "Trading margin is insufficient."
  }]
}
```

**この新しいエラーは何を意味するか？**

→ APIリクエストが**正常に処理されている証明**

ERR-5105（型不一致）ではなく、ERR-201（ビジネスロジックエラー）になったということは、GMO APIがリクエストを正しくパースし、注文処理まで進んだ証拠。

---

## 🔍 根本原因の詳細分析

### 二重JSON化とは？

**正常なフロー**（修正後）:
```python
# Step 1: Pythonオブジェクト（dict）作成
body_dict = {"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}

# Step 2: JSON文字列化（1回のみ）
body_json = json.dumps(body_dict)
# → '{"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}'

# Step 3: HTTPリクエスト送信
requests.post(url, data=body_json, headers=headers)
```

**異常なフロー**（修正前）:
```python
# Step 1: Pythonオブジェクト（dict）作成
body_dict = {"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}

# Step 2: JSON文字列化（1回目）
body_json = json.dumps(body_dict)
# → '{"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}'

# Step 3: 再度JSON文字列化（2回目）🔴 ここが問題！
body_str = json.dumps(body_json)
# → '"{\"symbol\": \"USD_JPY\", \"side\": \"BUY\", \"executionType\": \"MARKET\", \"size\": \"10000\"}"'

# Step 4: HTTPリクエスト送信
requests.post(url, data=body_str, headers=headers)
```

### GMO APIサーバー側の処理

**正常なリクエスト**を受信した場合:
```python
# サーバー側でJSONパース
import json
request_body = '{"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}'
data = json.loads(request_body)
# → {"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}

# パラメータ検証
assert isinstance(data, dict)  # ✅ Pass
assert "symbol" in data        # ✅ Pass
assert isinstance(data["size"], str)  # ✅ Pass
```

**異常なリクエスト**（二重JSON化）を受信した場合:
```python
# サーバー側でJSONパース
import json
request_body = '"{\"symbol\": \"USD_JPY\", \"side\": \"BUY\", \"executionType\": \"MARKET\", \"size\": \"10000\"}"'
data = json.loads(request_body)
# → '{"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}'
# 🔴 文字列型！dictではない！

# パラメータ検証
assert isinstance(data, dict)  # ❌ Fail!
# → ERR-5105: Request parameter include mismatch type.
```

---

## 💡 解決策の実装詳細

### 型チェックによる分岐処理

**実装コード**（`execution/core/gmo_client.py:1393-1401`）:

```python
def _request(
    self,
    method: str,
    path: str,
    body: Optional[Union[Dict[str, Any], str]] = None,
    max_retries: Optional[int] = None
) -> Dict[str, Any]:
    """
    GMO Coin FX APIへのHTTPリクエストを実行

    Args:
        method: HTTPメソッド（GET/POST/PUT/DELETE）
        path: APIパス（例: /v1/order）
        body: リクエストボディ（dictまたはJSON文字列）
        max_retries: 最大リトライ回数（Noneの場合はself.MAX_RETRIESを使用）

    Returns:
        APIレスポンス（JSON）
    """
    # URLとボディの準備
    url = self.base_url + path

    # 🔑 ここが重要！型チェックで二重JSON化を防止
    if isinstance(body, str):
        # 既にJSON文字列ならそのまま使用
        body_str = body
    elif body:
        # dictならJSON化
        body_str = json.dumps(body)
    else:
        # Noneまたは空ならば空文字列
        body_str = ""

    # HTTPヘッダー生成（HMAC-SHA256署名含む）
    headers = self._build_headers(method, path, body_str)

    # HTTPリクエスト実行
    response = requests.request(
        method=method,
        url=url,
        data=body_str,  # ✅ ここで送信されるのは1回だけJSON化された文字列
        headers=headers,
        timeout=self.TIMEOUT
    )

    return response.json()
```

### 型ヒントの活用

修正前は`body`パラメータの型が曖昧だった:
```python
# 修正前
def _request(self, method: str, path: str, body=None):
    # bodyがdictかstrか不明
    body_str = json.dumps(body) if body else ""  # 🔴 常にjson.dumps()実行
```

修正後は`Union[Dict, str]`で明示:
```python
# 修正後
def _request(
    self,
    method: str,
    path: str,
    body: Optional[Union[Dict[str, Any], str]] = None  # ✅ 型ヒントで明示
):
    # bodyの型を判定して処理を分岐
    if isinstance(body, str):
        body_str = body
    elif body:
        body_str = json.dumps(body)
    else:
        body_str = ""
```

---

## 🎓 学んだ教訓

### 1. JSON生成の二重化に注意

**問題の本質**:
- `place_order()`で`json.dumps(body_dict)`を実行
- `_request()`で再度`json.dumps(body)`を実行
- 結果: `"{\"symbol\": ...}"`という文字列が送信される

**教訓**:
- JSON文字列とdict型を明確に区別する
- `isinstance(body, str)`で型チェックを行う
- メソッド間でデータ形式の契約を明確にする（型ヒント活用）

**防止策**:
```python
# ✅ 良い例: 型チェックで二重JSON化を防止
if isinstance(body, str):
    body_str = body
elif body:
    body_str = json.dumps(body)

# ❌ 悪い例: 常にjson.dumps()実行
body_str = json.dumps(body) if body else ""
```

### 2. サポート問い合わせの重要性

**GMOサポートの指摘**: 「正常なJSON形式でない」

この曖昧な表現が、二重JSON化という具体的な問題を発見する手がかりになった。

**教訓**:
- ドキュメントでは見つけられない実装の問題をサポートが指摘してくれる
- エラーメッセージが不明確な場合は積極的にサポート問い合わせ
- 問い合わせ時は**具体的なリクエスト/レスポンスを提示**する

**効果的な問い合わせ例**:
```
【問い合わせテンプレート】
- エラーコード: ERR-5105
- エラーメッセージ: Request parameter include mismatch type.
- リクエストボディ: {"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}
- 試した対策: settleType削除、size型変更、最小ロット修正
- 疑問点: どのパラメータの型が不一致なのか？
```

### 3. エラーメッセージの多義性

**ERR-5105: Request parameter include mismatch type** の意味:

1. **型不一致**（size: string vs number）
2. **値の範囲違反**（size: 1,000 < minOpenOrderSize: 10,000）
3. **JSON形式エラー（二重JSON化）** ← 今回の原因

**教訓**:
- エラーコードだけで判断せず、根本原因を探る
- 複数の仮説を立てて体系的に検証
- ログ出力を詳細化（リクエスト/レスポンス全体を記録）

**ログ出力の改善例**:
```python
# 修正前
self.logger.error(f"API呼び出しエラー: {error_code}")

# 修正後
self.logger.error(f"API呼び出しエラー詳細:")
self.logger.error(f"  リクエストパス: {path}")
self.logger.error(f"  リクエストボディ: {body}")
self.logger.error(f"  レスポンス全体: {json.dumps(response_data, ensure_ascii=False, indent=2)}")
```

### 4. 段階的な検証の重要性

**5日間で試した対策**:
1. `price: null`削除 → HTTP 404継続
2. `settleType/timeInForce`削除 → ERR-5105登場
3. `size`型変更（数値→文字列） → ERR-5105継続
4. `losscutPrice`削除 → ERR-5105継続
5. 最小ロット修正（1,000→10,000） → ERR-5105継続
6. BUY方向テスト → ERR-5105継続（仮説否定）
7. **二重JSON化修正 → ERR-5105解消** ✅

**教訓**:
- 各テストが「原因ではない」ことを証明し、真の原因に近づく
- 失敗も貴重なデータ（仮説を絞り込める）
- 焦らず体系的にデバッグを進める

### 5. 型システムの活用

**型ヒントがあれば防げた**:

```python
# 型ヒントなし（修正前）
def _request(self, method, path, body=None):
    # bodyの型が不明確
    pass

# 型ヒント付き（修正後）
def _request(
    self,
    method: str,
    path: str,
    body: Optional[Union[Dict[str, Any], str]] = None  # ✅ 型を明示
) -> Dict[str, Any]:
    # bodyがdictかstrかを型ヒントで明示
    # isinstance()による型チェックが自然に導かれる
    pass
```

**教訓**:
- Python型ヒント（typing module）を積極的に活用
- mypyなどの静的型チェッカーで早期発見
- API境界では特に型を明確にする

---

## 🛠️ 実装コード全文

### 修正箇所1: _request()メソッド

**ファイル**: `execution/core/gmo_client.py`

```python
def _request(
    self,
    method: str,
    path: str,
    body: Optional[Union[Dict[str, Any], str]] = None,
    max_retries: Optional[int] = None
) -> Dict[str, Any]:
    """
    GMO Coin FX APIへのHTTPリクエストを実行

    Args:
        method: HTTPメソッド（GET/POST/PUT/DELETE）
        path: APIパス（例: /v1/order）
        body: リクエストボディ（dictまたはJSON文字列）
        max_retries: 最大リトライ回数

    Returns:
        APIレスポンス（JSON）

    Raises:
        GmoApiError: API呼び出しエラー
    """
    # レート制限チェック
    self._check_rate_limit(method)

    # URLとボディの準備
    url = self.base_url + path

    # bodyが既にJSON文字列の場合はそのまま使用、dictの場合はJSON化
    if isinstance(body, str):
        body_str = body
    elif body:
        body_str = json.dumps(body)
    else:
        body_str = ""

    # HTTPヘッダー生成（署名含む）
    headers = self._build_headers(method, path, body_str)

    # リトライループ（指数バックオフ）
    for attempt in range(max_retries or self.MAX_RETRIES):
        try:
            self.logger.debug(
                f"APIリクエスト: {method} {path} "
                f"(attempt {attempt + 1}/{max_retries or self.MAX_RETRIES})"
            )

            # HTTPリクエスト実行
            response = requests.request(
                method=method,
                url=url,
                data=body_str,
                headers=headers,
                timeout=self.TIMEOUT
            )

            # レスポンス処理
            return self._handle_response(response, path, body_str)

        except requests.exceptions.Timeout:
            # タイムアウト時はリトライ
            if attempt < (max_retries or self.MAX_RETRIES) - 1:
                wait_time = 2 ** attempt  # 指数バックオフ
                self.logger.warning(
                    f"タイムアウト発生。{wait_time}秒後にリトライします"
                )
                time.sleep(wait_time)
                continue
            else:
                raise GmoApiError(
                    0,
                    "APIリクエストがタイムアウトしました",
                    error_code="TIMEOUT"
                )
```

### 修正箇所2: place_order()メソッド

**ファイル**: `execution/core/gmo_client.py`

```python
def place_order(
    self,
    symbol: str,
    side: str,
    execution_type: str,
    size: int,
    price: Optional[float] = None,
    losscut_price: Optional[float] = None
) -> Dict[str, Any]:
    """
    新規注文を発行

    Args:
        symbol: 通貨ペア（例: USD_JPY）
        side: BUY/SELL
        execution_type: MARKET/LIMIT
        size: 注文数量（最小10,000通貨）
        price: 指値価格（LIMIT注文のみ）
        losscut_price: ストップロス価格（オプション、現在未使用）

    Returns:
        注文レスポンス
    """
    self.logger.info(
        f"注文発行: {symbol} {side} {execution_type} {size:,}通貨"
    )

    # リクエストボディ作成
    body_dict = {
        "symbol": symbol,
        "side": side.upper(),
        "executionType": execution_type.upper(),
        "size": str(size)  # ✅ 文字列型で送信（GMO API仕様）
    }

    # LIMIT注文の場合は指値価格を追加
    if execution_type.upper() == "LIMIT" and price is not None:
        body_dict["price"] = self._round_price(symbol, price)

    # JSON文字列化（1回のみ）
    body_json = json.dumps(body_dict)

    # APIリクエスト実行
    # _request()では二重JSON化を防止（isinstance(body, str)チェック）
    response = self._request("POST", "/v1/order", body=body_json)

    # レスポンスデータ取得
    data = response.get("data")
    if isinstance(data, list):
        # GMO APIはdataをlistで返すことがある
        data = data[0]

    self.logger.info(f"注文成功: order_id={data.get('orderId')}")
    return data
```

---

## 📊 検証結果

### 修正前（ERR-5105発生）

**リクエスト**（実際に送信されていたデータ）:
```json
"{\"symbol\": \"USD_JPY\", \"side\": \"BUY\", \"executionType\": \"MARKET\", \"size\": \"10000\"}"
```

**レスポンス**:
```json
{
  "status": 1,
  "messages": [{
    "message_code": "ERR-5105",
    "message_string": "Request parameter include mismatch type."
  }],
  "responsetime": "2026-01-05T10:30:38.495Z"
}
```

### 修正後（ERR-5105解消）

**リクエスト**（正しいJSON）:
```json
{"symbol": "USD_JPY", "side": "BUY", "executionType": "MARKET", "size": "10000"}
```

**レスポンス**:
```json
{
  "status": 1,
  "messages": [{
    "message_code": "ERR-201",
    "message_string": "Trading margin is insufficient."
  }],
  "responsetime": "2026-01-05T10:49:15.123Z"
}
```

**ERR-201の意味**: 証拠金不足（ビジネスロジックエラー）

→ **APIリクエストが正常に処理されている証明**！

---

## 🎯 まとめ

### この記事のポイント

1. **二重JSON化問題**: `json.dumps()`を2回実行すると、JSON文字列がエスケープされた文字列になる
2. **型チェックの重要性**: `isinstance(body, str)`で型判定し、二重JSON化を防止
3. **エラーメッセージの多義性**: ERR-5105は型不一致、範囲違反、JSON形式エラーなど複数の意味を持つ
4. **サポート問い合わせの効果**: 曖昧な指摘でも真の原因に近づく手がかりになる
5. **段階的デバッグ**: 5日間の試行錯誤が真の原因を絞り込んだ

### GMO Coin FX API利用者へのアドバイス

**チェックリスト**:
- [ ] `json.dumps()`を2回実行していないか？
- [ ] `isinstance(body, str)`で型チェックしているか？
- [ ] リクエスト/レスポンスログを詳細化しているか？
- [ ] エラー発生時はサポート問い合わせを検討したか？
- [ ] 型ヒント（typing module）を活用しているか？

**避けるべきパターン**:
```python
# ❌ 悪い例
body_json = json.dumps(body_dict)
response = requests.post(url, data=json.dumps(body_json))  # 二重JSON化

# ✅ 良い例
body_json = json.dumps(body_dict)
response = requests.post(url, data=body_json)  # 1回のみJSON化
```

### 次のステップ

ERR-5105を解消した後は、証拠金管理、IFDOCO注文（Entry+SL+TP同時設定）、レート制限対策などの実装が待っています。

次回記事では**「GMO Coin FX API完全ガイド - 5つの落とし穴と正しい実装パターン」**をお届けします。

---

## 📚 参考リンク

- [GMO Coin FX API公式ドキュメント](https://api.coin.z.com/fxdocs/)
- [Python typing module](https://docs.python.org/ja/3/library/typing.html)
- [JSON RFC 8259](https://datatracker.ietf.org/doc/html/rfc8259)

---