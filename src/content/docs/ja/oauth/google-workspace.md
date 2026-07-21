---
title: Google Workspace CLI OAuth の設定
description: Google Workspace CLI OAuth を設定し、mikan に Google Workspace 認証情報を保存およびプロジェクション（投影）させます。
sidebar:
  order: 3
  label: Google Workspace CLI
---

> 注意：mikan は Google の authorized_user JSON を vault に保存し、ターゲットパス（target path）のメタデータを保持します。`image` サンドボックスは、この種の vault ファイルをコンテナ内のターゲットパスへ自動的に投影（プロジェクション）します。現行の `container` / `firecracker` ランタイムは、依然として自動的なファイルのプロジェクションを行いません。

## 1. Google OAuth クライアントの作成

Google Cloud Console に移動します：

```text
APIs & Services → Credentials → Create Credentials → OAuth client ID
```

設定：

- アプリケーションの種類（Application type）：`Web application`
- 承認済みのリダイレクト URI（Authorized redirect URI）：`<LINK_URL>/oauth/callback`

例：

```text
LINK_URL=https://mikan.example.com
Redirect URI=https://mikan.example.com/oauth/callback
```

OAuth アプリがまだテストモード（testing mode）の場合は、テストユーザーを追加してください：

```text
OAuth consent screen → Test users
```

## 2. 環境変数の設定

```bash
export LINK_URL="https://mikan.example.com"
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<client-secret>"
```

`LINK_PORT` が設定されていない場合、mikan は `LINK_URL` が存在するときにデフォルトで `8181` ポートを監視します。

任意：デフォルトのスコープ（scopes）のオーバーライド：

```bash
export GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES="https://www.googleapis.com/auth/drive https://mail.google.com/ https://www.googleapis.com/auth/calendar"
```

## 3. `/login` の使用

以降のランタイムでこの認証情報（credential）ファイルを `/root/.config/gws/credentials.json` に自動的に投影したい場合は、`image` サンドボックスを使用して mikan を起動することをお勧めします：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

ボットとのダイレクトメッセージ（DM）で以下を入力します：

```text
/login
```

mikan から返されたリンクを開き、Google Workspace CLI OAuth を選択します。

成功すると、mikan は承認されたユーザーの認証情報（authorized user credential）を vault ファイルとして保存します。例：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "type": "authorized_user"
}
```

デフォルトのメタデータターゲットパス（metadata target path）は以下の通りです：

```text
/root/.config/gws/credentials.json
```

## 注意事項

- mikan は Web OAuth コールバックを使用するため、Google OAuth クライアントはデスクトップアプリではなく、`Web application` である必要があります。
- Google から `refresh_token` が返されない場合は、既存の同意（consent）を取り消してから再度 `/login` を行ってください。mikan は `access_type=offline` および `prompt=consent` を要求しますが、既存の承認があるために Google がリフレッシュトークンを省略することがあります。
- `gws.json` を `/root/.config/gws/credentials.json` に自動的に表示させるには、`image` サンドボックスを使用してください。`container` / `firecracker` は、現時点ではファイル認証情報のメタデータ（file credential metadata）を保存するのみで、自動投影は行いません。
