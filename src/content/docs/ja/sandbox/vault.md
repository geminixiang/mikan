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
├── conversations/
│   └── <office-key>/
│       └── settings.json
└── vaults/
    ├── <office-key>/          # 1 つの conversation の認証情報
    ├── shared/<name>/         # 共有 login profiles
    └── extensions/<slug>/     # extension secrets（host 側のみ）
```

`--state-dir` で指定することもできます：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

この場合、credentials は次に保存されます：

```text
/secure/mikan-state/vaults/
```

グローバル設定ファイルは `<state-dir>/settings.json` にあります。Conversation overrides は host-only の `<state-dir>/conversations/<office-key>/settings.json` にあります。従来の `<working-directory>/<conversationId>/settings.json` は一度移行され、その後は無視されます。conversation directory は sandbox に読み書き可能で mount されるため、settings は意図的にその外側に置かれています。

起動時、mikan は world-writable または現在のユーザー所有でない `--state-dir` の使用を拒否します。新しく作成される state/vault directories と credential files には private modes が使われますが、既存の group/world-readable state directory は自動的には制限されません。`chmod 0700 <state-dir>` を使用してください。

## Vault の内容

各 vault は `vaults/` 配下のディレクトリで、次を含められます：

- `env` file：`KEY=value` 形式の環境変数
- file credentials：例：`gws.json`、`.ssh/config`

mikan はファイル名/パスから mount target を自動推論します — `gws.json` → `/root/.config/gws/credentials.json`、`gcloud-adc.json` → `/root/.config/gcloud/application_default_credentials.json`、`.ssh/` → `/root/.ssh`、`.kube/` → `/root/.kube`、`.config/gh/` → `/root/.config/gh` — それ以外は既定で `/root/<relative-path>` になります。target は vault を解決するたびにファイル名から導出され、メタデータとして保存されるわけではありません。したがって credential file の名前を変えると、配置先も変わります。組み込みの OAuth flow は、正しい場所に推論される名前を選び、それに合わせて対応する環境変数（例：`GOOGLE_APPLICATION_CREDENTIALS`）を設定します。

image mode ではこれらは bind mount であり sandbox 内から書き込み可能なため、tools が更新する場合があります。変更が問題になる credentials は backup を保管してください。`gondolin:default` では、ファイルは所有者のみ読める権限で guest にコピーされ、書き戻されません。そのため guest 側の編集は runtime の再作成時に破棄されます。

例：

```text
~/.mikan/vaults/
└── v1-slack-c0123456789-1a2b3c4d5e6f7a8b/
    ├── env
    └── gws.json
```

`env` の例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## guest に届くもの

Vault の内容は、一様な 1 種類の secret ではありません：

- **conversation 自身の vault は guest に届くことが意図されています。** その `env` エントリは tool command の環境変数になり、credential file は target path（既定では `/root` 配下）へ投影されます。それこそが目的です。agent はログインした本人として `gh`、`gcloud`、`ssh` を実行します。
- **vault directory 自体がまとめて mount されることはありません。** 解決された vault が宣言する個々の credential file だけが、1 ファイルにつき 1 mount で、しかもその key が解決した conversation に対してのみ投影されます。
- **Daemon の token は guest に届きません。** プラットフォームの bot token（`SLACK_BOT_TOKEN`、GitHub App の private key など）は mikan の host プロセスが読み取るもので、vault 注入の対象ではありません。
- **Extension secrets は guest に届きません。** `vaults/extensions/<slug>/env` は extension API を通じて host 側で読み取られます。user vault ではなく、mount も注入もされません。

これはデータの境界であって、実行の境界ではありません。その conversation 自身の認証情報でできることは、その agent にもできます。保存する認証情報の範囲は、それを踏まえて絞ってください。

## Sandbox の挙動

| Sandbox mode       | Vault env injection | File credentials       | Vault key                        |
| ------------------ | ------------------- | ---------------------- | -------------------------------- |
| `host`             | 注入しない          | 拒否                   | プラットフォームの user から導出 |
| `container:<name>` | 注入する            | 拒否                   | container 名から導出             |
| `image:<image>`    | 注入する            | 投影する（bind mount） | office key                       |
| `gondolin:default` | 注入する            | 投影する（コピー）     | office key                       |
| `firecracker:*`    | 注入する            | 拒否                   | office key                       |
| `cloudflare:*`     | 注入する            | 拒否                   | office key                       |

**拒否とは、ファイルが黙って無視されるのではなく、実行が失敗するという意味です。** directory に `env`
以外のファイルを持つ vault は file mount に解決され、ファイルを mount できないモードは、不完全な認証
情報のまま実行する代わりに `Sandbox type "<type>" does not support vault file mounts` を送出します。
したがってこれらのモードでは、認証情報を `env` のみに留めてください。以前の `image` デプロイから
vault に残った `gws.json` 1 つで、その conversation は実行できなくなります。

office key は、platform 名とプラットフォームの生の conversation id を一緒に hash して導出されるため、生 id を共有する 2 つのプラットフォームが互いの認証情報を解決することはできません。古い生 id 方式で作成された conversation の vault directory は、起動時の migration によって office key へ rename されます。衝突（両方の directory が存在する）が起きた場合は、どちらかを選ぶのではなく boot を止めて手作業での統合を促します。

## 共有 vault

`sandbox.defaultSharedVault` は `vaults/shared/` 配下の profile を指定し、それが新しい conversation の vault に初回利用時にコピーされます。この ambient なコピーが起きるのは、membership でゲートされたプラットフォーム（Slack、Discord、Telegram）で、かつ隔離された `image` と `cloudflare` のトポロジーの場合だけです。GitHub のような open-trigger な面が継承することはありません。管理者が特定の GitHub conversation に対して明示的に vault をプロビジョニングすることは引き続き可能です。

## `/pi-login`

DM / private message で次を実行します：

```text
/pi-login
```

`/login` も同じコマンドとして受け付けられます。Slack には `/pi-` 綴りが登録されています。

mikan は 15 分間有効な onboarding link を生成します。Web ページで次を保存できます：

- 任意の API keys / env vars
- GitHub OAuth credentials
- Google Cloud SDK OAuth credentials
- Google Workspace CLI OAuth credentials

このコマンドは DM / private messages でのみ使用でき、共有チャンネル内の他人が credential onboarding link を取得することを防ぎます。この link は bearer capability であり、credential の書き込みまたは OAuth callback が完了した時点で消費されます。[Portal 認証と capability モデル](/ja/portal-auth-model/) を参照してください。

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
