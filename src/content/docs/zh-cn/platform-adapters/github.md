---
title: GitHub 适配器
description: 绑定 GitHub 账号、由 webhook 驱动、issue/PR 对话、限制设置，以及以 comment 回复。
---

每个 GitHub issue 或 pull request 都是一个 mikan 对话。mikan 以你绑定的普通 GitHub 账号行动，所以大家可以像对待队友一样，用自动补全 @ 它、把 issue 和 PR assign 给它、请它 review。GitHub 通过带签名的 webhook 通知 mikan 发生了什么。设计理由见 [ADR 0015](https://github.com/geminixiang/mikan/blob/main/docs/adr/0015-github-agent-account-and-webhooks.md)。

Conversation id 是 `GH_<owner>_<repo>_<number>`，其中 owner 与 repo 都转为小写。它避开 `/` 与 `:`，因为 id 会原样作为单一路径片段使用，也会出现在 docker 的 `-v source:target` 语法中；它以 `_` 而非 `-` 分隔，是因为 GitHub owner 可能含有 `-`（那会让 owner/repo 的边界产生歧义），但绝不会含有 `_`。和每个平台一样，原始 id 只停留在 GitHub API 边界上：在磁盘上，该对话位于以 office key 命名的 office 目录中。

## 主要代码

| 文件                                | 用途                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot 主体：判断是否触发、检查权限、送入对话。                                                         |
| `src/adapters/github/activity.ts`   | 校验 webhook 内容，整理成统一的活动格式。                                                                   |
| `src/adapters/github/policy.ts`     | 解析并应用限制设置。                                                                                        |
| `src/adapters/github/webhook.ts`    | 校验签名、响应 GitHub、丢弃重复的推送。                                                                     |
| `src/adapters/github/github-ops.ts` | 每个 `github_*` tool 背后的 host 端 backend。                                                               |
| `src/adapters/github/client.ts`     | 以账号 token 认证的最小 REST client。                                                                       |
| `src/adapters/github/context.ts`    | 创建 GitHub `ConversationResponder`；将完成的回复作为单条 comment 发布（不做 streaming edits）。            |
| `src/adapters/github/ids.ts`        | `rc-<id>` review-comment ts。`GH_<owner>_<repo>_<number>` 语法位于 `src/office/index.ts`。                  |
| `src/adapters/github/tool-pack.ts`  | 把 host 端 tools 打包成由 main 注入的 platform tool pack。                                                  |
| `src/adapters/github/tools/`        | 提供给 agent 的 tools：`github_pr`、`github_checks`、`github_review_reply`、`github_read`、`github_issue`。 |

## 需要准备

- **一个 agent 账号**：给 mikan 用的普通 GitHub 账号，对它要工作的仓库有访问权限。它在各仓库的角色是外层上限：只需要对话的仓库给 read，要推 branch 的仓库给 write。
- **该账号的 fine-grained personal access token**：resource owner 选组织，repository permissions 为 **Contents**、**Issues**、**Pull requests** 读写，**Actions** 与 **Commit statuses** 只读。组织要求审批时由 owner 审批。
- **一个 webhook**：发送到 `<LINK_URL>/github/webhook`，设置 secret，订阅 **Issues**、**Issue comments**、**Pull requests**、**Pull request review comments**。组织 webhook 最简单；GitHub App 的 webhook 也可以，mikan 不使用任何 App 凭证。
- **Link server**（`LINK_PORT` 与公开的 `LINK_URL`），用于接收 webhook。

## 配置

| 环境变量                | 用途                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `GITHUB_AGENT_TOKEN`    | 账号的 fine-grained PAT（必填）。GitHub 拒绝时启动失败。             |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret（必填）。                                             |
| `GITHUB_REPOS`          | 以逗号分隔的 `owner/repo` 或 `owner/*`（必填）。其他仓库一律不回应。 |
| `GITHUB_PUBLIC_REPOS`   | 设为 `true` 时也回应公开仓库（默认 `false`）。                       |
| `GITHUB_USERS`          | 以逗号分隔、允许触发的账号（默认：任何有足够权限的人）。             |
| `GITHUB_MIN_PERMISSION` | 触发者需要的仓库权限：`write`（默认）、`maintain` 或 `admin`。       |
| `GITHUB_TRIGGERS`       | `mention`、`assign`、`review`、`followup` 的任意组合（默认全部）。   |
| `GITHUB_CAPABILITIES`   | 在评论之外额外开放 `triage` 和／或 `push`（默认都不开）。            |

任何一项填了无法识别的值，启动就会失败。

## 触发条件

一次推送要同时满足以下条件才会触发：

1. 发送者不是 bot，也不是 agent 账号自己。
2. 仓库匹配 `GITHUB_REPOS`，且是私有仓库，除非 `GITHUB_PUBLIC_REPOS=true`。
3. 属于已开启的触发方式：
   - `mention`：新的 issue、PR、评论或 inline review comment 提到 `@<账号>`；
   - `assign`：issue 或 PR 被 assign 给这个账号；
   - `review`：PR 请这个账号 review；
   - `followup`：mikan 已经参与的 thread 有新评论。
4. 设置了 `GITHUB_USERS` 时，发送者在名单内。
5. 发送者在该仓库有 `GITHUB_MIN_PERMISSION` 以上的权限。查询结果缓存五分钟，查询失败一律拒绝。

其他情况一律忽略，也不会留下任何状态。@ 账号并评论 `stop`（或 `/stop`）会停止运行中的 session。

推送采用尽力而为：mikan 立即响应 GitHub，忽略重复推送，不保存任何推送记录。mikan 停机或无法访问时发送的事件会丢失，请再 @ 一次。

## 能力

未设置 `GITHUB_CAPABILITIES` 时，mikan 可以评论、添加 reaction、读取仓库与 CI 结果、在 review thread 回复，但不能修改 label、assignee 或代码。

| 能力     | 开放                                                         |
| -------- | ------------------------------------------------------------ |
| `triage` | `github_issue` tool：label、assignee、关闭与重新打开。       |
| `push`   | `github_pr` tool 以及推送 branch、创建 pull request 的说明。 |

未开启的能力，对应的 tool 和说明完全不会提供给 agent，但不会收回凭证：agent 能从 sandbox 推送什么，取决于 sandbox 的 GitHub token、账号在仓库的角色以及 branch protection。请保护默认 branch，让 agent 的改动只能经由 review 过的 pull request 进入。

只有至少具备 write 权限的协作者能触发 mikan，所以 GitHub 报告 `trustModel: "membership"`。GitHub 对话因此会像 Slack 对话一样获得 `sandbox.defaultSharedVault` 与 settings 声明的 MCP servers。参阅 [Vault](/zh-cn/sandbox/vault/)。

## Session 与回复

整个 issue/PR 是一个持久 session（`sessionKey === conversationId`），inline review thread 也会平铺进同一个 session。触发的 review comment 会被注入为带 `[PR review comment rc-<id> on <path>:<line>]` 标记的消息并附上 diff hunk；thread 中段的回复还会附上之前的内容。Agent 用 `github_review_reply` tool 回复该 thread。回复使用 GitHub Flavored Markdown，并在完成后才发布。第一次通过评论接触时，会先记录 issue 标题与正文。

## 仓库访问与 pull request

mikan 从不在 host 上运行 git。agent 在自己的 sandbox 内，用 sandbox 的 GitHub 凭证把仓库 clone 到 scratch 目录、用 `gh pr checkout` 切到 pull request、以 agent 账号 commit 并 push。没有凭证时只能访问公开仓库。

- `github_pr`（能力 `push`）为 agent 已经推送的 branch 创建 pull request（支持 draft）；该 branch 已有开启中的 PR 时直接返回那个 PR。它不会推送，也不能 merge。
- `github_checks` 读取已推送 branch 或 PR head 的 GitHub Actions job 与 commit status，并可按 `job_id` 获取 Actions job 的日志末尾。Fine-grained token 没有 Checks 权限，所以第三方 CI app 发布的 check run 不可见。
- `github_review_reply` 在单个 inline review thread 中回复。
- `github_read` 读取对话所属仓库的 PR 状态、变更文件、review、issue 与评论。
- `github_issue`（能力 `triage`）管理 label、assignee 与关闭／重新打开。Lock、delete 与 transfer 不在其 action set 中。

## 限制

- 漏掉的 webhook 推送不会补发。
- REST API 不支持文件上传；`uploadFile` 会改发一条指引评论。
- 只有 summary 正文提到账号、没有 inline comment 的 PR review 不会触发。请改为请它 review，或另外评论。
