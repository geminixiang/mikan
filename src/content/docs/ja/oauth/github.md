---
title: GitHub OAuth の設定
description: GitHub OAuth App を作成し、mikan の /login が GitHub 認証情報を保存および注入できるようにします。
sidebar:
  order: 1
  label: GitHub
---

## 1. GitHub OAuth App の作成

GitHub にアクセスします：

```text
Settings → Developer settings → OAuth Apps → New OAuth App
```

以下を入力します：

- Application name：例 `mikan`
- Homepage URL：お使いの `LINK_URL`
- Authorization callback URL：`<LINK_URL>/oauth/callback`

例：

```text
LINK_URL=https://mikan.example.com
Callback URL=https://mikan.example.com/oauth/callback
```

## 2. 環境変数の設定

```bash
export LINK_URL="https://mikan.example.com"
export GITHUB_OAUTH_CLIENT_ID="<client-id>"
export GITHUB_OAUTH_CLIENT_SECRET="<client-secret>"
```

`LINK_PORT` が設定されていない場合、`LINK_URL` が存在していれば、mikan はデフォルトで `8181` ポートをリスンします。

## 3. mikan の起動

```bash
mikan --sandbox=container:mikan-tools /path/to/workspace
```

または、ユーザーごとに管理されたコンテナ（managed per-user container）を使用する場合：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

または：

```bash
mikan --sandbox=firecracker:192.168.1.100:/path/to/workspace /path/to/workspace
```

## 4. `/login` の使用

ボットとの DM（ダイレクトメッセージ）で以下を入力します：

```text
/login
```

mikan から返されたリンクを開き、GitHub OAuth を選択します。

成功すると、mikan は対応する vault の `env` にトークンを書き込みます。これには以下が含まれます：

```text
GITHUB_OAUTH_ACCESS_TOKEN
GH_TOKEN
```

`container` / `image` / `firecracker` サンドボックスでは、その後のツール実行時にこれらの環境変数が注入されます。

## スコープ

デフォルトの GitHub OAuth スコープ：

```text
repo read:user user:email read:org gist
```

環境変数を使用して上書きできます：

```bash
export GITHUB_OAUTH_SCOPES="repo read:user user:email read:org gist workflow"
```

本当に必要なスコープのみを追加してください。権限の強いスコープは、認証情報が漏洩した際のリスクを高めます。
