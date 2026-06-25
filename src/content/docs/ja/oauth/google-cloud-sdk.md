---
title: Google Cloud SDK OAuth の設定
description: sandbox 内の gcloud がログイン後のユーザー認証情報を使用できるように、Google Cloud SDK OAuth を設定します。
sidebar:
  order: 2
  label: Google Cloud SDK
---

> 注意：mikan は Google の `authorized_user` JSON を vault に保存し、target path のメタデータを保持します。`image` sandbox はこの種の vault ファイルをコンテナ内の target path に自動的にプロジェクション（投影）しますが、現在の `container` / `firecracker` ランタイムはまだ自動ファイルプロジェクションに対応していません。

## 1. Google OAuth クライアントの作成

Google Cloud コンソールに移動します：

```text
API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID
```

設定：

- アプリケーションの種類：`ウェブ アプリケーション`
- 承認されたリダイレクト URI：`<LINK_URL>/oauth/callback`

例：

```text
LINK_URL=https://mikan.example.com
リダイレクト URI=https://mikan.example.com/oauth/callback
```

OAuth アプリがまだテストモード（Testing mode）の場合は、ユーザーを追加してください：

```text
OAuth 同意画面 → テストユーザー
```

## 2. 環境変数の設定

```bash
export LINK_URL="https://mikan.example.com"
export GOOGLE_CLOUD_SDK_CLIENT_ID="<client-id>"
export GOOGLE_CLOUD_SDK_CLIENT_SECRET="<client-secret>"
```

`LINK_PORT` が設定されていない場合、`LINK_URL` が存在するときに mikan はデフォルトで `8181` ポートを監視します。

任意：デフォルトのスコープ（scopes）を上書きする：

```bash
export GOOGLE_CLOUD_SDK_OAUTH_SCOPES="openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform"
```

## 3. `/pi-login` の使用

後続のランタイムで認証情報ファイルを `/root/.config/gcloud/application_default_credentials.json` に自動的にプロジェクションしたい場合は、`image` sandbox を使用して mikan を起動することをお勧めします：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

ボットとのダイレクトメッセージ（DM）で以下を入力します：

```text
/pi-login
```

mikan から返信されたリンクを開き、**Google Cloud SDK (gcloud)** を選択します。

成功すると、mikan は以下の処理を行います：

- vault ファイルに保存：`gcloud-adc.json`
- sandbox 内の以下にプロジェクション：`/root/.config/gcloud/application_default_credentials.json`
- 環境変数を設定：
  - `GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json`
  - `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/root/.config/gcloud/application_default_credentials.json`

`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` により、`gcloud` はこの認証情報ファイルを優先的に使用するようになります。

## 注意事項

- mikan は Web OAuth コールバックを使用するため、Google OAuth クライアントはデスクトップ アプリ（desktop app）ではなく、`ウェブ アプリケーション`（Web application）である必要があります。
- Google から `refresh_token` が返されない場合は、既存の同意（consent）を取り消してから、再度 `/pi-login` を実行してください。mikan は `access_type=offline` と `prompt=consent` を要求しますが、既存の授権があるため、Google がリフレッシュトークンを省略する場合があります。
- 認証情報ファイルを `/root/.config/gcloud/application_default_credentials.json` に自動的に表示させるには、`image` sandbox を使用してください。`container` / `firecracker` は現在、ファイルの認証情報メタデータを保存するのみで、自動プロジェクションは行いません。
