---
title: Vault
description: mikan が credentials を state directory に保存し、sandbox mode に応じて env または file mounts として注入する仕組み。
---

## State directory と vault の場所

state directory のデフォルトは次のとおりです：

```text
~/.mikan/
```

重要な内容：

```text
~/.mikan/
├── settings.json
└── vaults/
    └── <vault-id>/
```

`--state-dir` で指定することもできます：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

この場合、credential は次に保存されます：

```text
/secure/mikan-state/vaults/
```

グローバル設定ファイルは `<state-dir>/settings.json` にあります。Conversation-local 設定は `<working-directory>/<conversationId>/settings.json` にあり、その conversation のグローバルデフォルトを上書きします。

起動時、mikan は world-writable または現在のユーザー所有でない `--state-dir` の使用を拒否し、ローカルの他ユーザーによる settings や vault 内容の改ざんを防ぎます。

## Vault の内容

各 vault は `vaults/` 配下のディレクトリで、次を含められます：

- `env` file：`KEY=value` 形式の環境変数
- file credentials：例：`gws.json`、`.ssh/config`

mikan はファイル名/パスから mount target を自動推論します。例：`gws.json` → `/root/.config/gws/credentials.json`、`.ssh/` → `/root/.ssh`。

例：

```text
~/.mikan/vaults/
└── container-mikan-tools/
    ├── env
    └── gws.json
```

`env` の例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## Sandbox の挙動

| Sandbox mode       | Vault env injection | File credential projection | Vault key                                             |
| ------------------ | ------------------- | -------------------------- | ----------------------------------------------------- |
| `host`             | 注入しない          | 投影しない                 | credentials は保存できるが host commands へ注入しない |
| `container:<name>` | 注入する            | 投影しない                 | `container-<name>`                                    |
| `image:<image>`    | 注入する            | 自動投影                   | generated conversation vault。通常は conversation ID  |
| `firecracker:*`    | 注入する            | 投影しない                 | generated conversation vault                          |
| `cloudflare:*`     | 注入する            | 投影しない                 | generated platform-scoped conversation vault          |

## `/login`

ユーザーは DM / private chat で次を実行します：

```text
/login
```

mikan は 15 分間有効な onboarding link を生成します。ユーザーは Web ページで次を保存できます：

- 任意の API key / env var
- GitHub OAuth credential
- Google Workspace CLI OAuth credential

`/login` は DM / private chat でのみ使用でき、共有チャンネル内の他人が credential onboarding link を取得することを防ぎます。

## link server の有効化

本番デプロイでは公開 URL を設定します：

```bash
export LINK_URL="https://mikan.example.com"
```

`LINK_PORT` が未設定の場合、`LINK_URL` が存在すると mikan はデフォルトで port `8181` を使用します。

明示的に指定することもできます：

```bash
export LINK_PORT=8181
```

ローカルテストだけなら、次だけを設定しても構いません：

```bash
export LINK_PORT=8181
```

このとき `/login` link は次を使用します：

```text
http://localhost:8181
```

OAuth callback URL は次のとおりです：

```text
<LINK_URL>/oauth/callback
```
