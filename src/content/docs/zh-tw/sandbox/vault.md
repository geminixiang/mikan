---
title: Vault
description: mikan 如何把 credentials 存在 state directory，並依 sandbox 模式注入 env 或 file mounts。
---

## State directory 與 vault 位置

state directory 預設是：

```text
~/.mikan/
```

其中重要內容包含：

```text
~/.mikan/
├── settings.json
├── conversations/
│   └── <office-key>/
│       └── settings.json
└── vaults/
    ├── <office-key>/          # one conversation's credentials
    ├── shared/<name>/         # shared login profiles
    └── extensions/<slug>/     # extension secrets (host-side only)
```

也可以用 `--state-dir` 指定：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

此時 credential 會存在：

```text
/secure/mikan-state/vaults/
```

全域設定檔位於 `<state-dir>/settings.json`。Conversation overrides 是僅限 host 的 `<state-dir>/conversations/<office-key>/settings.json`。舊版 `<working-directory>/<conversationId>/settings.json` 會移轉一次，之後忽略——conversation 目錄會以可讀寫的方式掛進 sandbox，所以設定是刻意放在它們之外的。

啟動時，mikan 會拒絕 world-writable 或不由目前使用者擁有的 `--state-dir`。新建立的 state/vault directories 與 credential files 使用 private modes，但既有、group/world-readable 的 state directory 不會自動收緊權限；請執行 `chmod 0700 <state-dir>`。

## Vault 內容

每個 vault 是 `vaults/` 下的一個目錄，裡面可包含：

- `env` file：`KEY=value` 形式的環境變數
- file credentials：例如 `gws.json`、`.ssh/config`

mikan 會從檔名／路徑推斷 mount targets——`gws.json` → `/root/.config/gws/credentials.json`、`gcloud-adc.json` → `/root/.config/gcloud/application_default_credentials.json`、`.ssh/` → `/root/.ssh`、`.kube/` → `/root/.kube`、`.config/gh/` → `/root/.config/gh`——其他則一律預設為 `/root/<relative-path>`。target 是在每次解析 vault 時從檔名推導的，並不會存成 metadata，因此把 credential 檔案改名就會改變它落腳的位置。內建的 OAuth flow 會挑選能推斷到正確位置的檔名，並把對應的 env var（例如 `GOOGLE_APPLICATION_CREDENTIALS`）設成該路徑。

Image 模式下，這些是 bind mount，可從 sandbox 內寫入，因此工具可能更新它們——若憑證遭修改會造成影響，請保留備份。在 `gondolin:default` 中，這些檔案會以僅擁有者可存取的權限複製進 guest，而且不會寫回，因此 guest 端的修改會在 runtime 重建時被捨棄。

範例：

```text
~/.mikan/vaults/
└── v1-slack-c0123456789-1a2b3c4d5e6f7a8b/
    ├── env
    └── gws.json
```

`env` 範例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## 什麼東西會進到 sandbox

Vault 裡的內容並不是同一類的祕密：

- **對話自己的 vault 本來就該進到 guest。** 它的 `env` 項目會成為工具指令的環境變數，credential 檔案則會被投影到各自的 target path（預設在 `/root` 底下）。這正是重點所在：agent 是以登入者的身分執行 `gh`、`gcloud` 或 `ssh`。
- **Vault 目錄本身絕不會被整包掛載。** 只有已解析 vault 所宣告的個別 credential 檔案會被投影，一個檔案一個 mount，而且只針對解析出該 key 的那個對話。
- **Daemon token 絕不會進到 guest。** 平台 bot token（`SLACK_BOT_TOKEN`、GitHub App private key 等）由 mikan host process 讀取，不屬於任何 vault injection。
- **Extension secret 絕不會進到 guest。** `vaults/extensions/<slug>/env` 是透過 extension API 在 host 端讀取的；它不是使用者 vault，不會被掛載或注入。
- **OAuth refresh token 絕不會進到 guest。** 以 `_REFRESH_TOKEN` 結尾的 env key（例如 `/login` OAuth 流程存下的 `GITHUB_OAUTH_REFRESH_TOKEN`）會在注入時被過濾掉：沒有 guest 工具會直接使用它們，而 refresh grant 還需要只存在於 daemon 的 OAuth client secret。它們留在 vault 供 host 端使用。自訂 OAuth service 的 refresh key 也請用這個字尾命名，即可獲得相同保護。

這是資料邊界，不是執行邊界。對話自己的憑證能做的任何事，它的 agent 都能做——請據此決定你存進去的憑證要有多大權限。

把長效個人 token 注入 guest 刻意被定位為*escape hatch*，而不是預設姿態：只要工作流程不需要 guest 憑證就能完成，優先使用 host 端工具（GitHub adapter 的 `github_*` pack、[connector gateway](/connector/)），只在 CLI 真的必須於 sandbox 內認證時才投影 token。這條界線背後的業界調查見 [`docs/research/sandbox-git-credential-patterns.md`](https://github.com/geminixiang/mikan/blob/main/docs/research/sandbox-git-credential-patterns.md)。

## Sandbox 行為

| Sandbox mode       | Vault env injection | File credentials     | Vault key             |
| ------------------ | ------------------- | -------------------- | --------------------- |
| `host`             | 不注入              | 拒絕                 | 由平台使用者推導      |
| `container:<name>` | 注入                | 拒絕                 | 由 container 名稱推導 |
| `image:<image>`    | 注入                | 投影（bind mount）   | office key            |
| `gondolin:default` | 注入                | 投影（複製進 guest） | office key            |
| `firecracker:*`    | 注入                | 拒絕                 | office key            |
| `cloudflare:*`     | 注入                | 拒絕                 | office key            |

**「拒絕」的意思是執行會失敗，而不是靜靜地忽略那個檔案。** 只要 vault 目錄中存在 `env` 以外的任何檔案，就會解析出 file mount；無法掛載檔案的模式會拋出 `Sandbox type "<type>" does not support vault file mounts`，而不是在憑證不完整的情況下執行。因此在這些模式上，請只把憑證放在 `env` 裡——一個從先前 `image` 部署留在 vault 中的 `gws.json`，就足以讓該對話無法執行。

office key 由平台名稱與該平台的原始 conversation id 一起雜湊而來，因此兩個共用相同 raw id 的平台無法解析到對方的憑證。在舊的 raw-id 機制下建立的 conversation vault 目錄，會由開機時的遷移改名為 office key；若發生衝突（兩個目錄都存在），開機會停下來讓人手動合併，而不是自行挑一個。

## Shared vault

`sandbox.defaultSharedVault` 指定 `vaults/shared/` 底下的一份 profile，會在新對話第一次使用時複製進它的 vault。這種預設複製只發生在需要成員資格的平台（Slack、Discord、Telegram），且僅限 isolated 的 `image` 與 `cloudflare` 拓撲。像 GitHub 這種可由任何人觸發的介面永遠不會繼承它——但管理員仍可明確為特定的 GitHub 對話佈建 vault。

## `/pi-login`

使用者在 DM / 私訊中執行：

```text
/pi-login
```

`/login` 也會被接受為同一個指令；Slack 註冊的是 `/pi-` 這種寫法。

mikan 會產生一個 15 分鐘有效的 onboarding link。使用者可在網頁中儲存：

- 任意 API key / env var
- GitHub OAuth credential
- Google Cloud SDK OAuth credential
- Google Workspace CLI OAuth credential

這個指令只能在 DM / 私訊使用，避免共享頻道中的其他人取得 credential onboarding link。該連結是一個 bearer capability，在憑證寫入或 OAuth callback 完成後就會被消耗掉——見 [Portal 驗證與 capability 模型](/zh-tw/portal-auth-model/)。

## 啟用 link server

正式部署時，設定公開 URL：

```bash
export LINK_URL="https://mikan.example.com"
```

若沒有設定 `LINK_PORT`，mikan 會在 `LINK_URL` 存在時預設使用 port `8181`。

也可以明確指定：

```bash
export LINK_PORT=8181
```

若只是本機測試，也可以只設：

```bash
export LINK_PORT=8181
```

此時 `/login` link 會使用：

```text
http://localhost:8181
```

OAuth callback URL 是：

```text
<LINK_URL>/oauth/callback
```
