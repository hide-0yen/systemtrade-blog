# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

システムトレードに関する個人ブログ「SystemTrade -45395-」のリポジトリ。AstroPaper テーマをベースにした Astro 製静的サイト。

**すべての作業は `nebulous-nova/` ディレクトリ内で行う。**

## Commands

すべてのコマンドは `nebulous-nova/` ディレクトリ内で実行する。

```bash
cd nebulous-nova

pnpm run dev          # 開発サーバー起動 (localhost:4321)
pnpm run build        # 本番ビルド (型チェック → astro build → pagefind インデックス生成)
pnpm run preview      # ビルド結果のプレビュー
pnpm run lint         # ESLint
pnpm run format       # Prettier フォーマット
pnpm run format:check # フォーマットチェックのみ
pnpm run sync         # Astro の TypeScript 型を生成
```

## Architecture

### Tech Stack

- **フレームワーク**: Astro 5.x (静的サイト生成)
- **スタイリング**: TailwindCSS v4 (Vite プラグイン経由)
- **型チェック**: TypeScript
- **検索**: Pagefind (ビルド時インデックス生成)
- **シンタックスハイライト**: Shiki + カスタムトランスフォーマー

### Key Files & Directories

| パス | 説明 |
|------|------|
| `nebulous-nova/src/config.ts` | サイト設定 (URL、タイトル、ページネーション等) |
| `nebulous-nova/src/content.config.ts` | Astro コンテンツコレクション定義 |
| `nebulous-nova/src/data/blog/` | ブログ記事 (Markdown) |
| `nebulous-nova/src/components/` | Astro コンポーネント |
| `nebulous-nova/src/layouts/` | ページレイアウト |
| `nebulous-nova/src/pages/` | ルーティング (ファイルベース) |
| `nebulous-nova/src/utils/` | ユーティリティ関数 |

### Blog Post Frontmatter

`src/data/blog/*.md` に記事を配置する。必須・任意フィールド:

```yaml
---
author: "45395"          # 省略可 (デフォルト値あり)
pubDatetime: 2025-01-01T10:00:00+09:00  # 必須
modDatetime: 2025-01-01T10:00:00+09:00  # 任意
title: "記事タイトル"    # 必須
featured: false          # 任意 (トップページ表示)
draft: false             # 任意 (true なら非公開)
tags:
  - タグ名               # 任意 (省略時は "others")
description: "説明文"    # 必須
ogImage: ""              # 任意 (省略時は動的生成)
hideEditPost: false      # 任意
timezone: "Asia/Tokyo"   # 任意 (省略時はサイト設定値)
---
```

ファイル名の先頭が `_` のものはコレクションから除外される。

### Content Collection

`content.config.ts` で `blog` コレクションを定義。`src/data/blog/` 以下の `*.md` ファイルが対象。`astro:content` の型安全な API でアクセスする。

### Markdown 機能

- **目次**: `## Table of contents` を記事内に書くと自動生成・折りたたみ対応
- **コードブロック**: Shiki による差分表示 (`// [!code ++]`)、ハイライト、ファイル名表示をサポート

## Deployment & CI/CD

### ホスティング

Firebase Hosting (Spark プラン・無料) + Cloudflare DNS。ドメイン `systemtrade.blog` の DNS は Xserver で管理し、A レコードを Firebase の IP に向けている。

### GitHub Actions ワークフロー

| ファイル | トリガー | 内容 |
|----------|----------|------|
| `.github/workflows/deploy.yml` | `main` push | lint → format:check → build → Firebase deploy |
| `.github/workflows/ci.yml` | PR | lint → format:check → build（デプロイなし） |

`deploy.yml` は `working-directory: nebulous-nova` で実行し、`FirebaseExtended/action-hosting-deploy@v0` で `dist/` を Firebase にデプロイする。

### 必要な GitHub Secrets

| Secret 名 | 用途 |
|-----------|------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Hosting へのデプロイ権限（GCP サービスアカウント JSON） |

### Firebase 設定ファイル

| ファイル | 内容 |
|----------|------|
| `nebulous-nova/firebase.json` | `dist/` を公開、キャッシュヘッダー設定 |
| `nebulous-nova/.firebaserc` | プロジェクト ID `systemtrade-c9d0b` にバインド |

### 記事公開フロー

```bash
# 記事を追加・更新して push するだけで自動デプロイ
git add nebulous-nova/src/data/blog/記事.md
git commit -m "post: 記事タイトル"
git push origin main
```
