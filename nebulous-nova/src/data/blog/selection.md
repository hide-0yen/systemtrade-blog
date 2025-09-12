---
author: "45395"
pubDatetime: 2025-09-11T10:00:00+09:00
modDatetime: 2025-09-11T10:00:00+09:00
title: FXでシステムトレードを開発している理由
featured: false
draft: false
tags:
  - FX
  - Python
  - 開発環境
  - Windows
  - kabuステーション
  - マーケットスピード
  - OANDA
  - J-Quants
  - yfinance
  - Mac
  - ParallelsDesktop
description: システムトレードを開発するにあたりFXを選定した理由について
---

## FXを選んだ理由と開発環境

私がシステムトレード開発において **FXを選定した理由** は、シンプルに  
「現在使用している開発環境との相性」と「構想していたシステム像との相性」でした。

---

## システム構築における条件

システム構築にあたり、私が重視した条件は以下の通りです。

- 無料で利用できること  
- 高信頼度で遅延が少ないこと  
- macで開発可能であること  
- ローカル環境で完結できること  

---

## 現在の開発環境

これらの条件を踏まえ、現在は以下の環境で開発を進めています。

- **Mac**  
- **[OANDA](https://www.oanda.jp/)** の REST API / PUSH API  
- **Python**  
- **PostgreSQL & TimescaleDB**  

---

## 日本株からFXへ至るまでの経緯

実際には、WindowsソフトやExcelなど出費もかさみました。  
当初は日本株のテクニカル指標とFXのテクニカル指標が流用できるとは知らず、まともに株価データを取得するまでに約3年を要しました。  

以下は検討・実装したものの、最終的に頓挫した技術です。

---

### 株価取得のために試した技術

- **[yfinance (Pythonライブラリ)](https://pypi.org/project/yfinance/)**  
  …取得精度が不十分だった。  

- **[J-Quants API](https://jpx-jquants.com/)**  
  …無料版は **12週間遅れ** のデータしか取得できなかった。  

- **[kabuステーション](https://kabu.com/tool/kabustation/default.html)**（auカブコム証券提供）  
  …REST API / PUSH API 対応だが、専用Windowsソフトの起動が必要で、取得できる銘柄は **最大50件**。  
  毎朝必ず強制ログアウトされるため、完全自動化は困難だった。  

- **[マーケットスピード II](https://marketspeed.jp/ms2/)**（楽天証券提供）  
  …Excelが必須。精度は最も良かったが、二段階認証と毎朝の強制ログアウトにより完全自動化が難しかった。  

---

## Windows環境について

なお、Windows環境は **[Parallels Desktop](https://www.parallels.com/jp/products/desktop/)** を利用してMac上で構築していました。  
当時は上記のWindowsソフトも動作しており、検証を進めることができました。
