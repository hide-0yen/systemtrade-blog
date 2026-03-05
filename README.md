# SystemTrade Blog

システムトレード構築のために勉強したことをアウトプットするブログ。
**URL**: https://systemtrade.blog

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フレームワーク | [Astro](https://astro.build/) 5.x |
| スタイリング | TailwindCSS v4 |
| ホスティング | Firebase Hosting (Spark プラン・無料) |
| 検索 | Pagefind（ビルド時インデックス生成） |
| CI/CD | GitHub Actions |
| ドメイン DNS | Xserver（A レコードを Firebase に向けている） |

---

## ローカル開発セットアップ

### 前提条件

- Node.js 20+
- pnpm

### 手順

```bash
# リポジトリをクローン
git clone <repository-url>
cd systemtrade-blog/nebulous-nova

# 依存関係のインストール
pnpm install

# 開発サーバー起動 (http://localhost:4321)
pnpm run dev
```

---

## 記事の追加・更新

### 記事ファイルの作成

`nebulous-nova/src/data/blog/` 以下に Markdown ファイルを作成する。

```bash
# 例
nebulous-nova/src/data/blog/my-new-post.md
```

ファイル名の先頭が `_` のものはビルド対象外（下書き管理に使用可）。

### フロントマター

```yaml
---
pubDatetime: 2025-01-01T10:00:00+09:00  # 必須・公開日時
title: "記事タイトル"                    # 必須
description: "記事の説明"               # 必須
tags:
  - システムトレード
  - Python
draft: false          # true にすると非公開
featured: false       # true にするとトップページに表示
modDatetime:          # 更新日時（更新時のみ記載）
---
```

### ローカルで確認してからプッシュ

```bash
cd nebulous-nova

# ビルドして確認
pnpm run build
pnpm run preview   # http://localhost:4321 でプレビュー
```

### 公開（自動デプロイ）

```bash
git add nebulous-nova/src/data/blog/my-new-post.md
git commit -m "post: 記事タイトル"
git push origin main
# → GitHub Actions が自動でビルド＆Firebase にデプロイ
```

---

## CI/CD パイプライン

### ワークフロー

| ファイル | トリガー | 処理内容 |
|----------|----------|----------|
| `.github/workflows/deploy.yml` | `main` push | lint → format check → build → Firebase deploy |
| `.github/workflows/ci.yml` | PR 作成・更新 | lint → format check → build（デプロイなし） |

### フロー図

```
git push origin main
        │
        ▼
  GitHub Actions
  ├─ pnpm install
  ├─ ESLint
  ├─ Prettier check
  ├─ astro check + astro build + pagefind
  └─ Firebase Hosting deploy
        │
        ▼
  https://systemtrade.blog（Firebase CDN 経由）
```

---

## 初期セットアップ手順（環境を再構築する場合）

### 1. Firebase プロジェクトの設定

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクト `systemtrade-c9d0b` を選択
2. Hosting を有効化

### 2. GitHub Secrets の登録

GCP コンソールでサービスアカウントキー（JSON）を発行し、GitHub リポジトリに登録する。

```
リポジトリ → Settings → Secrets and variables → Actions → New repository secret

Name:   FIREBASE_SERVICE_ACCOUNT
Secret: サービスアカウント JSON の全文
```

### 3. 初回デプロイ（カスタムドメイン設定前に必要）

```bash
cd nebulous-nova
npm install -g firebase-tools
firebase login
pnpm run build
firebase deploy --only hosting
```

### 4. カスタムドメインの設定

Firebase コンソール → Hosting → 「カスタムドメインを追加」→ `systemtrade.blog` を入力。
Firebase が提示する DNS レコードを Xserver のドメイン管理画面で設定する。

| 操作 | タイプ | 値 |
|------|--------|-----|
| 追加 | A | Firebase が提示する IP |
| 追加 | TXT | `hosting-site=systemtrade-c9d0b` |
| 削除 | A | 旧 Xserver の IP |

---

## 開発コマンド一覧

すべて `nebulous-nova/` ディレクトリ内で実行する。

```bash
pnpm run dev          # 開発サーバー起動 (localhost:4321)
pnpm run build        # 本番ビルド
pnpm run preview      # ビルド結果のプレビュー
pnpm run lint         # ESLint
pnpm run format       # Prettier フォーマット
pnpm run format:check # フォーマットチェックのみ
pnpm run sync         # Astro TypeScript 型の再生成
```

---

## Firebase 設定ファイル

| ファイル | 内容 |
|----------|------|
| `nebulous-nova/firebase.json` | `dist/` を公開ディレクトリに指定、キャッシュヘッダー設定 |
| `nebulous-nova/.firebaserc` | Firebase プロジェクト ID `systemtrade-c9d0b` にバインド |
