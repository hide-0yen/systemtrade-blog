---
author: "45395"
pubDatetime: 2025-09-18T10:00:00+09:00
modDatetime: 2025-09-18T10:00:00+09:00
title: OANDAのFX日足データ取得プログラムサンプルコード
featured: false
draft: false
tags:
  - OANDA
  - python
  - FX
  - プログラム
description: OANDAのAPIからFXの日足データを取得するサンプルコードです。
---

このプログラムはOANDA APIを使用してFXの日足データを取得するPythonサンプルです。
```python
#!/usr/bin/env python3
"""
OANDA公式のoandapyV20ライブラリを使用してFXの日足データを取得するサンプルプログラム

必要なライブラリ:
pip install oandapyV20 pandas

使用前の準備:
1. OANDAでデモ/ライブアカウントを作成
2. APIトークンを取得
3. このスクリプトの設定部分にトークンとアカウントIDを設定
"""

import oandapyV20
from oandapyV20 import API
import oandapyV20.endpoints.accounts as accounts
import oandapyV20.endpoints.instruments as instruments
import oandapyV20.endpoints.pricing as pricing
import pandas as pd
from datetime import datetime, timedelta
import time
import json

class OandaV20DataFetcher:
    """oandapyV20を使用してOANDA APIからFXデータを取得するクラス"""
    
    def __init__(self, api_token, account_id, environment='practice'):
        """
        初期化
        
        Args:
            api_token (str): OANDAのAPIトークン
            account_id (str): アカウントID
            environment (str): 'practice' (デモ) or 'live' (本番)
        """
        self.api_token = api_token
        self.account_id = account_id
        self.environment = environment
        
        # APIクライアントを初期化
        self.api = API(access_token=api_token, environment=environment)
    
    def get_account_info(self):
        """アカウント情報を取得"""
        try:
            r = accounts.AccountDetails(accountID=self.account_id)
            self.api.request(r)
            return r.response
        except Exception as e:
            print(f"アカウント情報取得エラー: {e}")
            return None
    
    def get_daily_candles(self, instrument, count=100, from_date=None, to_date=None, 
                         price='MBA', smooth=False, include_first=True):
        """
        日足データを取得
        
        Args:
            instrument (str): 通貨ペア (例: 'USD_JPY', 'EUR_USD')
            count (int): 取得するキャンドル数 (最大5000)
            from_date (str): 開始日時 (RFC3339形式またはYYYY-MM-DD)
            to_date (str): 終了日時 (RFC3339形式またはYYYY-MM-DD)
            price (str): 'M' (Mid), 'B' (Bid), 'A' (Ask), 'BA', 'MB', 'MA', 'MBA'
            smooth (bool): 平滑化するかどうか
            include_first (bool): from_dateのキャンドルを含むかどうか
        
        Returns:
            pandas.DataFrame: 日足データ
        """
        params = {
            'granularity': 'D',
            'price': price,
            'smooth': smooth,
            'includeFirst': include_first
        }
        
        # 日付形式の調整
        if from_date and to_date:
            # YYYY-MM-DD形式の場合はRFC3339形式に変換
            if len(from_date) == 10:  # YYYY-MM-DD
                from_date = f"{from_date}T00:00:00Z"
            if len(to_date) == 10:    # YYYY-MM-DD
                to_date = f"{to_date}T23:59:59Z"
            
            params['from'] = from_date
            params['to'] = to_date
        else:
            params['count'] = count
        
        try:
            r = instruments.InstrumentsCandles(instrument=instrument, params=params)
            self.api.request(r)
            
            candles_data = r.response['candles']
            
            # データフレームに変換
            df_data = []
            for candle in candles_data:
                if candle['complete']:  # 確定したキャンドルのみ
                    row = {
                        'time': candle['time'],
                        'volume': candle['volume'],
                    }
                    
                    # Mid価格の処理
                    if 'mid' in candle:
                        row.update({
                            'open': float(candle['mid']['o']),
                            'high': float(candle['mid']['h']),
                            'low': float(candle['mid']['l']),
                            'close': float(candle['mid']['c']),
                        })
                    
                    # Bid価格の処理
                    if 'bid' in candle:
                        row.update({
                            'bid_open': float(candle['bid']['o']),
                            'bid_high': float(candle['bid']['h']),
                            'bid_low': float(candle['bid']['l']),
                            'bid_close': float(candle['bid']['c']),
                        })
                    
                    # Ask価格の処理
                    if 'ask' in candle:
                        row.update({
                            'ask_open': float(candle['ask']['o']),
                            'ask_high': float(candle['ask']['h']),
                            'ask_low': float(candle['ask']['l']),
                            'ask_close': float(candle['ask']['c']),
                        })
                    
                    df_data.append(row)
            
            df = pd.DataFrame(df_data)
            if not df.empty:
                # 時刻をdatetimeに変換
                df['time'] = pd.to_datetime(df['time'])
                df.set_index('time', inplace=True)
                df = df.sort_index()  # 時系列順にソート
            
            return df
            
        except Exception as e:
            print(f"日足データ取得エラー: {e}")
            return pd.DataFrame()
    
    def get_multiple_timeframes(self, instrument, count=50):
        """
        複数の時間足データを取得
        
        Args:
            instrument (str): 通貨ペア
            count (int): 各時間足の取得件数
        
        Returns:
            dict: 時間足ごとのデータフレーム
        """
        timeframes = {
            'Daily': 'D',
            'Weekly': 'W', 
            'Monthly': 'M',
            'H4': 'H4',
            'H1': 'H1'
        }
        
        results = {}
        
        for name, granularity in timeframes.items():
            try:
                params = {
                    'granularity': granularity,
                    'price': 'M',
                    'count': count
                }
                
                r = instruments.InstrumentsCandles(instrument=instrument, params=params)
                self.api.request(r)
                
                candles_data = r.response['candles']
                df_data = []
                
                for candle in candles_data:
                    if candle['complete']:
                        row = {
                            'time': candle['time'],
                            'volume': candle['volume'],
                            'open': float(candle['mid']['o']),
                            'high': float(candle['mid']['h']),
                            'low': float(candle['mid']['l']),
                            'close': float(candle['mid']['c']),
                        }
                        df_data.append(row)
                
                df = pd.DataFrame(df_data)
                if not df.empty:
                    df['time'] = pd.to_datetime(df['time'])
                    df.set_index('time', inplace=True)
                    df = df.sort_index()
                    results[name] = df
                
                time.sleep(0.2)  # API制限対応
                
            except Exception as e:
                print(f"{name}データ取得エラー: {e}")
        
        return results
    
    def get_current_prices(self, instruments_list):
        """
        現在の価格を取得
        
        Args:
            instruments_list (list): 通貨ペアのリスト
        
        Returns:
            pandas.DataFrame: 現在価格データ
        """
        try:
            params = {
                'instruments': ','.join(instruments_list)
            }
            
            r = pricing.PricingInfo(accountID=self.account_id, params=params)
            self.api.request(r)
            
            prices_data = r.response['prices']
            df_data = []
            
            for price in prices_data:
                if price['status'] == 'tradeable':
                    row = {
                        'instrument': price['instrument'],
                        'time': price['time'],
                        'bid': float(price['bids'][0]['price']),
                        'ask': float(price['asks'][0]['price']),
                        'spread': float(price['asks'][0]['price']) - float(price['bids'][0]['price'])
                    }
                    row['mid'] = (row['bid'] + row['ask']) / 2
                    df_data.append(row)
            
            df = pd.DataFrame(df_data)
            if not df.empty:
                df['time'] = pd.to_datetime(df['time'])
                df.set_index('instrument', inplace=True)
            
            return df
            
        except Exception as e:
            print(f"現在価格取得エラー: {e}")
            return pd.DataFrame()
    
    def get_instruments_info(self):
        """利用可能な通貨ペア情報を取得"""
        try:
            r = accounts.AccountInstruments(accountID=self.account_id)
            self.api.request(r)
            
            instruments_data = r.response['instruments']
            df_data = []
            
            for instrument in instruments_data:
                if instrument['type'] == 'CURRENCY':
                    row = {
                        'name': instrument['name'],
                        'display_name': instrument['displayName'],
                        'pip_location': instrument['pipLocation'],
                        'trade_units_precision': instrument['tradeUnitsPrecision'],
                        'minimum_trade_size': float(instrument['minimumTradeSize']),
                        'maximum_trailing_stop_distance': instrument['maximumTrailingStopDistance'],
                        'minimum_trailing_stop_distance': instrument['minimumTrailingStopDistance'],
                        'maximum_position_size': instrument['maximumPositionSize'],
                        'maximum_order_units': instrument['maximumOrderUnits']
                    }
                    df_data.append(row)
            
            df = pd.DataFrame(df_data)
            if not df.empty:
                df.set_index('name', inplace=True)
            
            return df
            
        except Exception as e:
            print(f"通貨ペア情報取得エラー: {e}")
            return pd.DataFrame()

def calculate_technical_indicators(df):
    """
    テクニカル指標を計算
    
    Args:
        df (pandas.DataFrame): OHLCV データ
    
    Returns:
        pandas.DataFrame: テクニカル指標付きのデータ
    """
    if df.empty or 'close' not in df.columns:
        return df
    
    df_with_indicators = df.copy()
    
    # 移動平均線
    df_with_indicators['sma_5'] = df['close'].rolling(window=5).mean()
    df_with_indicators['sma_25'] = df['close'].rolling(window=25).mean()
    df_with_indicators['sma_75'] = df['close'].rolling(window=75).mean()
    
    # ボリンジャーバンド（期間20、標準偏差2）
    df_with_indicators['bb_middle'] = df['close'].rolling(window=20).mean()
    bb_std = df['close'].rolling(window=20).std()
    df_with_indicators['bb_upper'] = df_with_indicators['bb_middle'] + (bb_std * 2)
    df_with_indicators['bb_lower'] = df_with_indicators['bb_middle'] - (bb_std * 2)
    
    # RSI（期間14）
    def calculate_rsi(prices, period=14):
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / loss
        return 100 - (100 / (1 + rs))
    
    df_with_indicators['rsi'] = calculate_rsi(df['close'])
    
    # MACD
    exp1 = df['close'].ewm(span=12).mean()
    exp2 = df['close'].ewm(span=26).mean()
    df_with_indicators['macd'] = exp1 - exp2
    df_with_indicators['macd_signal'] = df_with_indicators['macd'].ewm(span=9).mean()
    df_with_indicators['macd_histogram'] = df_with_indicators['macd'] - df_with_indicators['macd_signal']
    
    return df_with_indicators

def main():
    """メイン実行関数"""
    
    # ===== 設定 =====
    API_TOKEN = "YOUR_API_TOKEN_HERE"
    ACCOUNT_ID = "YOUR_ACCOUNT_ID_HERE"
    ENVIRONMENT = "practice"  # 'practice' または 'live'
    
    # 設定チェック
    if API_TOKEN == "YOUR_API_TOKEN_HERE" or ACCOUNT_ID == "YOUR_ACCOUNT_ID_HERE":
        print("エラー: API_TOKENとACCOUNT_IDを設定してください")
        print("OANDAのダッシュボードから取得できます")
        return
    
    # データフェッチャーを初期化
    fetcher = OandaV20DataFetcher(API_TOKEN, ACCOUNT_ID, ENVIRONMENT)
    
    print("=== OANDA oandapyV20 サンプルプログラム ===\n")
    
    # 1. アカウント情報の表示
    print("1. アカウント情報を取得中...")
    account_info = fetcher.get_account_info()
    if account_info:
        account = account_info['account']
        print(f"アカウントID: {account['id']}")
        print(f"通貨: {account['currency']}")
        print(f"残高: {float(account['balance']):.2f} {account['currency']}")
        print(f"未実現損益: {float(account['unrealizedPL']):.2f} {account['currency']}")
        print(f"利用可能証拠金: {float(account['marginAvailable']):.2f} {account['currency']}")
    
    print("\n" + "="*50)
    
    # 2. 利用可能な通貨ペア情報を表示
    print("2. 利用可能な通貨ペア情報を取得中...")
    instruments_df = fetcher.get_instruments_info()
    if not instruments_df.empty:
        print("主要な通貨ペア情報:")
        major_pairs = ['USD_JPY', 'EUR_USD', 'GBP_USD', 'AUD_USD', 'USD_CAD']
        for pair in major_pairs:
            if pair in instruments_df.index:
                info = instruments_df.loc[pair]
                print(f"  {pair}: {info['display_name']} (最小取引: {info['minimum_trade_size']})")
    
    print("\n" + "="*50)
    
    # 3. 現在価格の取得
    print("3. 現在価格を取得中...")
    major_pairs = ['USD_JPY', 'EUR_USD', 'GBP_USD', 'AUD_USD']
    current_prices = fetcher.get_current_prices(major_pairs)
    if not current_prices.empty:
        print("現在の価格:")
        for instrument in current_prices.index:
            price_info = current_prices.loc[instrument]
            print(f"  {instrument}: Bid={price_info['bid']:.5f}, Ask={price_info['ask']:.5f}, "
                  f"Mid={price_info['mid']:.5f}, Spread={price_info['spread']:.5f}")
    
    print("\n" + "="*50)
    
    # 4. USD/JPYの日足データを取得
    print("4. USD/JPYの日足データ（過去100日分）を取得中...")
    instrument = 'USD_JPY'
    
    df = fetcher.get_daily_candles(instrument, count=100, price='MBA')
    
    if not df.empty:
        print(f"\n{instrument}の日足データ:")
        print(f"データ期間: {df.index.min().strftime('%Y-%m-%d')} ～ {df.index.max().strftime('%Y-%m-%d')}")
        print(f"データ件数: {len(df)}件")
        
        print("\n最新5件のデータ:")
        latest_data = df.tail()[['open', 'high', 'low', 'close', 'volume']]
        print(latest_data.round(3))
        
        # テクニカル指標を計算
        df_with_indicators = calculate_technical_indicators(df)
        
        print(f"\n最新のテクニカル指標:")
        latest_indicators = df_with_indicators.iloc[-1]
        print(f"  SMA5: {latest_indicators['sma_5']:.3f}")
        print(f"  SMA25: {latest_indicators['sma_25']:.3f}")
        print(f"  SMA75: {latest_indicators['sma_75']:.3f}")
        print(f"  RSI: {latest_indicators['rsi']:.2f}")
        print(f"  MACD: {latest_indicators['macd']:.5f}")
        print(f"  MACD Signal: {latest_indicators['macd_signal']:.5f}")
        print(f"  BB Upper: {latest_indicators['bb_upper']:.3f}")
        print(f"  BB Lower: {latest_indicators['bb_lower']:.3f}")
        
        # CSVファイルに保存
        output_file = f"/mnt/user-data/outputs/{instrument}_daily_with_indicators.csv"
        df_with_indicators.to_csv(output_file)
        print(f"\nテクニカル指標付きデータを保存しました: {output_file}")
        
    print("\n" + "="*50)
    
    # 5. 複数時間足のデータを取得
    print("5. EUR/USDの複数時間足データを取得中...")
    instrument = 'EUR_USD'
    
    multiple_timeframes = fetcher.get_multiple_timeframes(instrument, count=20)
    
    if multiple_timeframes:
        print(f"\n{instrument}の複数時間足データ:")
        for timeframe, data in multiple_timeframes.items():
            if not data.empty:
                latest = data.iloc[-1]
                print(f"  {timeframe}: 最新価格={latest['close']:.5f}, "
                      f"変動幅={latest['high'] - latest['low']:.5f}, "
                      f"出来高={latest['volume']}")
        
        # 月足データを詳細表示
        if 'Monthly' in multiple_timeframes:
            monthly_data = multiple_timeframes['Monthly']
            print(f"\n{instrument}の月足データ（最新3か月）:")
            print(monthly_data.tail(3)[['open', 'high', 'low', 'close', 'volume']].round(5))
    
    print("\n" + "="*50)
    
    # 6. 期間指定でのデータ取得
    print("6. 期間指定でのデータ取得例...")
    
    # 過去30日間のデータを取得
    end_date = datetime.now()
    start_date = end_date - timedelta(days=30)
    
    period_data = fetcher.get_daily_candles(
        'GBP_USD',
        from_date=start_date.strftime('%Y-%m-%d'),
        to_date=end_date.strftime('%Y-%m-%d'),
        price='M'  # Mid価格のみ
    )
    
    if not period_data.empty:
        print(f"GBP/USD 過去30日間のデータ:")
        print(f"期間: {period_data.index.min().strftime('%Y-%m-%d')} ～ {period_data.index.max().strftime('%Y-%m-%d')}")
        print(f"件数: {len(period_data)}件")
        
        # 統計情報
        print(f"\n統計情報:")
        print(f"  平均終値: {period_data['close'].mean():.5f}")
        print(f"  最高値: {period_data['high'].max():.5f}")
        print(f"  最安値: {period_data['low'].min():.5f}")
        print(f"  価格変動率: {((period_data['close'].iloc[-1] / period_data['close'].iloc[0]) - 1) * 100:.2f}%")
        print(f"  平均出来高: {period_data['volume'].mean():.0f}")
    
    print(f"\n=== プログラム完了 ===")

if __name__ == "__main__":
    main()
```

## 特徴

### oandapyV20ライブラリの利点
- **公式サポート**: OANDAが公式に提供・メンテナンスしているライブラリ
- **高い信頼性**: API仕様の変更に迅速に対応
- **豊富な機能**: 取引実行、アカウント管理、データ取得など包括的な機能
- **エラーハンドリング**: 適切なエラーハンドリングと例外処理
- **詳細なドキュメント**: 充実した公式ドキュメント

## インストール

### 1. 必要なライブラリのインストール
```bash
pip install oandapyV20 pandas
```

### 2. OANDAアカウントの準備
1. [OANDA Demo Account](https://www.oanda.com/demo-account/)でデモアカウントを作成
2. ダッシュボードでAPIトークンを生成
3. アカウントIDを確認

## プログラムの機能

### 主な機能一覧
1. **アカウント情報取得**
   - 残高、証拠金、未実現損益の表示

2. **通貨ペア情報取得**
   - 利用可能な通貨ペアと取引条件の表示

3. **現在価格取得**
   - リアルタイムのBid/Ask/Mid価格とスプレッド

4. **日足データ取得**
   - OHLCV（始値・高値・安値・終値・出来高）データ
   - 期間指定または件数指定での取得

5. **複数時間足データ取得**
   - 日足、週足、月足、4時間足、1時間足の同時取得

6. **テクニカル指標計算**
   - 移動平均線（SMA 5, 25, 75）
   - ボリンジャーバンド
   - RSI（14期間）
   - MACD

## 使用方法

### 1. 設定
プログラム内の設定部分を編集：

```python
API_TOKEN = "YOUR_API_TOKEN_HERE"     # OANDAから取得したAPIトークン
ACCOUNT_ID = "YOUR_ACCOUNT_ID_HERE"   # アカウントID
ENVIRONMENT = "practice"              # "practice" (デモ) または "live" (本番)
```

### 2. 実行
```bash
python oanda_oandapy_v20.py
```

## プログラム出力例

```
=== OANDA oandapyV20 サンプルプログラム ===

1. アカウント情報を取得中...
アカウントID: 123-456-7890123-001
通貨: USD
残高: 100000.00 USD
未実現損益: 0.00 USD
利用可能証拠金: 100000.00 USD

2. 利用可能な通貨ペア情報を取得中...
主要な通貨ペア情報:
  USD_JPY: USD/JPY (最小取引: 1.0)
  EUR_USD: EUR/USD (最小取引: 1.0)
  GBP_USD: GBP/USD (最小取引: 1.0)

3. 現在価格を取得中...
現在の価格:
  USD_JPY: Bid=142.450, Ask=142.470, Mid=142.460, Spread=0.02000
  EUR_USD: Bid=1.09850, Ask=1.09870, Mid=1.09860, Spread=0.00020

4. USD/JPYの日足データ（過去100日分）を取得中...

USD_JPYの日足データ:
データ期間: 2024-05-21 ～ 2024-09-18
データ件数: 86件

最新5件のデータ:
                      open    high     low   close  volume
time                                                     
2024-09-12 21:00:00  140.755  142.425  140.680  142.320   32854
2024-09-13 21:00:00  142.320  142.950  141.850  142.105   28965

最新のテクニカル指標:
  SMA5: 142.289
  SMA25: 143.456
  SMA75: 150.234
  RSI: 45.67
  MACD: -0.12345
  MACD Signal: -0.09876
  BB Upper: 145.678
  BB Lower: 139.234

5. EUR/USDの複数時間足データを取得中...

EUR/USDの複数時間足データ:
  Daily: 最新価格=1.09860, 変動幅=0.00450, 出来高=45623
  Weekly: 最新価格=1.09860, 変動幅=0.02340, 出来高=234567
  Monthly: 最新価格=1.09860, 変動幅=0.05670, 出来高=1234567
```

## 高度な使用例

### 1. 特定期間のデータ取得
```python
# 2024年8月のデータを取得
df = fetcher.get_daily_candles(
    'USD_JPY',
    from_date='2024-08-01',
    to_date='2024-08-31'
)
```

### 2. Bid/Ask価格を含むデータ取得
```python
# Bid, Ask, Mid価格をすべて取得
df = fetcher.get_daily_candles(
    'EUR_USD', 
    count=50, 
    price='MBA'  # Mid, Bid, Ask
)
```

### 3. 複数時間足での分析
```python
# 複数時間足のデータを取得
timeframes_data = fetcher.get_multiple_timeframes('GBP_USD', count=100)

# 各時間足でのトレンド分析
for timeframe, data in timeframes_data.items():
    latest_price = data['close'].iloc[-1]
    sma_20 = data['close'].rolling(20).mean().iloc[-1]
    trend = "上昇" if latest_price > sma_20 else "下降"
    print(f"{timeframe}: {trend}トレンド")
```

### 4. カスタムテクニカル指標
```python
def calculate_custom_indicators(df):
    """カスタムテクニカル指標を計算"""
    # ストキャスティクス
    low_14 = df['low'].rolling(14).min()
    high_14 = df['high'].rolling(14).max()
    k_percent = ((df['close'] - low_14) / (high_14 - low_14)) * 100
    df['stoch_k'] = k_percent.rolling(3).mean()
    df['stoch_d'] = df['stoch_k'].rolling(3).mean()
    
    # ATR (Average True Range)
    high_low = df['high'] - df['low']
    high_close_prev = abs(df['high'] - df['close'].shift())
    low_close_prev = abs(df['low'] - df['close'].shift())
    true_range = pd.concat([high_low, high_close_prev, low_close_prev], axis=1).max(axis=1)
    df['atr'] = true_range.rolling(14).mean()
    
    return df
```

## oandapyV20 vs requests ライブラリの比較

| 機能 | oandapyV20 | requests |
|------|------------|----------|
| **開発・保守** | OANDA公式 | 自作実装 |
| **API変更対応** | 自動対応 | 手動対応必要 |
| **エラーハンドリング** | 充実 | 自作実装必要 |
| **取引実行** | 対応 | 追加実装必要 |
| **ドキュメント** | 公式ドキュメント豊富 | 自作ドキュメント |
| **学習コスト** | 低い | 中程度 |
| **カスタマイズ性** | 中程度 | 高い |

## エラー対処法

### よくあるエラーと対処法

1. **V20Error: {'errorMessage': 'Insufficient authorization to perform request'}**
   - APIトークンが無効または期限切れ
   - 新しいトークンを生成して設定

2. **V20Error: {'errorMessage': 'Invalid value specified for 'granularity'}**
   - 時間足の指定が間違っている
   - 'D', 'H4', 'H1', 'M30' など正しい値を使用

3. **V20Error: {'errorMessage': 'Invalid value specified for 'count'}**
   - countの値が範囲外（1-5000）
   - 適切な範囲の値を設定

### デバッグのヒント
```python
# デバッグモードでのAPI呼び出し
import logging
logging.basicConfig(level=logging.DEBUG)

# レスポンスの詳細確認
try:
    r = instruments.InstrumentsCandles(instrument='USD_JPY', params={'count': 10})
    api.request(r)
    print(json.dumps(r.response, indent=2))
except Exception as e:
    print(f"エラー詳細: {e}")
```

## 参考資料

- [oandapyV20 公式ドキュメント](https://oanda-api-v20.readthedocs.io/)
- [OANDA v20 API リファレンス](https://developer.oanda.com/rest-live-v20/introduction/)
- [GitHub - oandapyV20](https://github.com/hootnot/oanda-api-v20)
- [OANDA Demo Account](https://www.oanda.com/demo-account/)

## 注意事項

1. **API制限**: 1秒間に10リクエストまで
2. **データ制限**: 一度に最大5000件のキャンドルデータまで取得可能
3. **時刻表記**: すべてUTC（協定世界時）
4. **本番環境**: 十分にテストしてから本番環境を使用
5. **セキュリティ**: APIトークンの管理に注意

