---
title: 讓 mikan 成為 GitHub 隊友
description: 用 fine-grained PAT 和 webhook 把一個 GitHub 帳號綁給 mikan，讓團隊可以 @ 它、assign 給它、請它 review。
---

完成這份指南後，團隊在 issue 或 PR 輸入 `@` 就能從自動完成選到 mikan，也能把 issue 或 PR assign 給它，或請它 review。mikan 在 GitHub 上只以這個帳號行動。

以下以 `acme` 代表你的組織、`acme-agent` 代表這個帳號、`https://mikan.example.com` 代表 mikan 的 `LINK_URL`，請換成實際名稱。

## 開始之前

- mikan 已啟用 link server（`LINK_PORT`），並有公開的 HTTPS 網址（`LINK_URL`），讓 GitHub 能連到 `<LINK_URL>/github/webhook`。
- 你是組織 owner，或能請 owner 核准申請、新增 webhook。

## 1. 建立帳號

1. 用團隊共用信箱（例如 `agent@example.com`）註冊一個新的 GitHub 帳號，例如 `acme-agent`。GitHub 允許機器帳號，建立的人要為它負責。
2. 開啟兩步驟驗證。GitHub 要求協作者開啟它，而這個帳號由團隊共用，請確保需要登入的人都能完成驗證。
3. 設定大頭貼、顯示名稱與簡介（例如「mikan AI teammate」），讓大家認得它。

## 2. 給帳號 repo 權限

由 owner 在 `https://github.com/orgs/acme/people` 邀請 `acme-agent`，再用這個帳號登入接受邀請。接著透過 team 或直接授權，讓它在 mikan 要工作的 repo 有角色：

| 角色       | mikan 在該 repo 能做的事                          |
| ---------- | ------------------------------------------------- |
| **Read**   | 被 @、被 assign、留言、按 reaction、讀程式碼與 CI |
| **Triage** | 另外可以管理 label、assignee、關閉 issue          |
| **Write**  | 另外可以推 `pi/*` branch、開 pull request         |

角色是上限，mikan 實際能做什麼由第 6 步的設定決定。

## 3. 建立 fine-grained PAT

以下每一步都要**用這個帳號登入**。

1. 打開 `https://github.com/settings/personal-access-tokens/new`。
2. **Token name** 填 `mikan`，在 **Description** 寫清楚用途和負責人。
3. **Resource owner** 選 `acme`，不要留在個人帳號，否則 token 只看得到帳號自己的 repo。清單裡沒有組織時，由 owner 到 **Organization settings** → **Personal access tokens** → **Settings** 開啟 fine-grained PAT。
4. **Expiration** 依公司政策設定，並在到期前一週設好提醒。
5. **Repository access** 選 **All repositories**，或只選 mikan 要工作的 repo。
6. **Repository permissions** 只加以下幾項：

   | 權限                | 設定           | 用途                            |
   | ------------------- | -------------- | ------------------------------- |
   | **Contents**        | Read and write | Clone，以及推 `pi/*` branch     |
   | **Issues**          | Read and write | 留言、reaction、label、assignee |
   | **Pull requests**   | Read and write | PR 留言、review 回覆、開 PR     |
   | **Actions**         | Read-only      | CI job 與 log                   |
   | **Commit statuses** | Read-only      | GitHub Actions 以外的 CI 結果   |

   **Metadata: Read-only** 會自動加入。Fine-grained PAT 沒有 Checks 權限。

7. 按 **Generate token**，複製 `github_pat_` 開頭的 token。它只會顯示一次。
8. 組織要求核准時，token 頁面會顯示等待核准，而且沒有任何權限。由 owner 到 **Organization settings** → **Personal access tokens** → **Pending requests** 核准。

## 4. 驗證 token

```bash
read -rs GITHUB_AGENT_TOKEN && export GITHUB_AGENT_TOKEN

# 印出帳號名稱，例如 "acme-agent"
curl -s -H "Authorization: Bearer $GITHUB_AGENT_TOKEN" https://api.github.com/user | jq -r .login

# 印出 200；404 代表 token 還沒核准、resource owner 選錯，或帳號沒有權限
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $GITHUB_AGENT_TOKEN" \
  "https://api.github.com/repos/acme/widgets/issues?per_page=1"
```

## 5. 新增 webhook

由組織 owner 打開 `https://github.com/organizations/acme/settings/hooks/new`：

1. **Payload URL**：`https://mikan.example.com/github/webhook`
2. **Content type**：`application/json`
3. **Secret**：一串夠長的亂數，例如用 `openssl rand -hex 32` 產生。
4. **Which events**：選 **Let me select individual events**，勾選 **Issues**、**Issue comments**、**Pull requests**、**Pull request review comments**。
5. 按 **Add webhook**。GitHub 會送一次 ping；mikan 用相同 secret 執行後，**Recent Deliveries** 會出現綠色勾勾。

想用 GitHub App 的 webhook 也可以，設定方式相同，例如 repo 不在組織底下的情況。

## 6. 設定 mikan

在 mikan 的執行環境設定以下變數，然後重新啟動：

```bash
GITHUB_AGENT_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=<webhook 的 secret>
GITHUB_REPOS=acme/*
```

`GITHUB_REPOS` 列出 mikan 會回應的地方：`owner/repo` 或 `owner/*`，用逗號分隔。預設只回應私有 repo、只回應有 write 權限的人，而且只能留言和讀取。可以用下面的設定放寬或收緊：

| 設定                    | 範例             | 效果                                  |
| ----------------------- | ---------------- | ------------------------------------- |
| `GITHUB_CAPABILITIES`   | `triage,push`    | 另外可以管理 label、assignee，並開 PR |
| `GITHUB_TRIGGERS`       | `mention,assign` | 只回應 @ 和 assign                    |
| `GITHUB_USERS`          | `alice,bob`      | 只有這些人能叫它                      |
| `GITHUB_MIN_PERMISSION` | `maintain`       | 只有 maintainer 和 admin 能叫它       |
| `GITHUB_PUBLIC_REPOS`   | `true`           | 也回應公開 repo                       |

啟動 log 會出現：

```text
GitHub bot started as @acme-agent, answering in acme/*
```

Token 無效時，mikan 會啟動失敗。

## 7. 試試看

用在該 repo 有足夠權限的帳號操作：

1. 在測試 issue 輸入 `@acme`，確認自動完成出現 `acme-agent`，送出 `@acme-agent hello`。
2. `acme-agent` 會先按 👀，完成後回覆。
3. 在另一個 issue 的 **Assignees** 選 `acme-agent`，mikan 會從 issue 標題與內文開始處理。

## 疑難排解

| 症狀                                       | 可能原因                                                                        | 處理方式                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 啟動失敗，出現 `GET /user failed with 401` | Token 打錯、過期或被撤銷                                                        | 建立新 token 並更新環境變數                |
| Webhook 推送出現紅色叉叉和 401             | `GITHUB_WEBHOOK_SECRET` 和 webhook 的 secret 不同                               | 兩邊設成相同的 secret                      |
| Webhook 推送連線失敗                       | 網際網路連不到 mikan 的 `LINK_URL`                                              | 檢查 reverse proxy 和 `LINK_PORT`          |
| 推送成功但 mikan 沒反應                    | Repo 不在 `GITHUB_REPOS`、是公開 repo、觸發方式或使用者未開放，或發送者權限不足 | 檢查第 6 步的設定；mikan 會在 log 寫出原因 |
| Clone 或留言出現 404                       | Token 等待核准、resource owner 選錯，或帳號沒有權限                             | 重新檢查第 2、3 步                         |
| 自動完成或 Assignees 找不到帳號            | 帳號對該 repo 沒有權限                                                          | 照第 2 步調整                              |

mikan 不會補送漏掉的推送。mikan 停機時有人 @ 它的話，請再 @ 一次。

## 更換與撤銷 token

- **到期前**：照第 3 步建立新 token → 更新環境變數 → 重新啟動 mikan → 確認回覆正常 → 刪除舊 token。
- **外洩時**：用這個帳號登入，到 **Settings** → **Developer settings** → **Fine-grained tokens** 撤銷，再建立新的。組織 owner 也可以在 **Organization settings** → **Personal access tokens** → **Active tokens** 撤銷。
