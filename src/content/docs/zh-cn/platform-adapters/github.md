---
title: GitHub 适配器
description: GitHub 适配器的 GitHub App 轮询、issue/PR 对话、水位线去重和基于评论的回复。
---

每个 GitHub issue 或 pull request 都是一个 mikan 对话。适配器以 GitHub App installation 身份轮询 GitHub API，不使用 webhook 端点，以保留 mikan 的主动模型。

## 主要代码

| 文件                             | 用途                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`     | GitHub bot 核心：轮询循环、水位线去重、提及/参与触发和评论。                          |
| `src/adapters/github/client.ts`  | 以 GitHub App 身份验证的最小 REST 客户端（RS256 JWT → installation tokens）。         |
| `src/adapters/github/context.ts` | 创建 GitHub `ConversationResponder`；将完成的回复作为一条评论发布（不进行流式编辑）。 |
| `src/adapters/github/ids.ts`     | `GH_<owner>_<repo>_<number>` 对话 ID 编码/解析。                                      |
| `src/adapters/github/types.ts`   | GitHub 适配器专用类型和 REST payload 结构。                                           |

## 创建并安装 GitHub App

1. 为拥有目标仓库的账号或组织创建 GitHub App。
2. 授予仓库权限：**Metadata: Read**、**Contents: Read & write**、**Issues: Read & write**、**Pull requests: Read & write**、**Checks: Read** 和 **Actions: Read**。Issues/PR 写入权限用于评论和 reaction；Contents/Pull requests 写入权限仅由受保护的 `github_pr` 工具使用。
3. 将 App 安装到 mikan 可以轮询的仓库。
4. 记录 App ID 和 installation ID，然后生成 private key。将 PEM 保存在工作区之外，并优先使用 `GITHUB_APP_PRIVATE_KEY_PATH`，而不是内联 secret。

App slug 是用户首次联系时提及的名称。

## 配置

| 环境变量                                                 | 用途                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `GITHUB_APP_ID`                                          | GitHub App id（必需）。                                            |
| `GITHUB_INSTALLATION_ID`                                 | 要以其身份操作的 installation id（必需）。                         |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` | App private key PEM，可内联（使用 `\n` 转义）或作为文件提供。      |
| `GITHUB_REPOS`                                           | 可选的逗号分隔 `owner/repo` 列表；默认为 installation 的所有仓库。 |
| `GITHUB_POLL_INTERVAL`                                   | 可选的轮询间隔（秒，默认 60）。                                    |

## 事件来源

轮询循环针对每个监视的仓库，使用 ETag 条件请求获取自增量游标以来更新的 issue 和 issue/PR 评论（304 响应不计入 rate limit）。目前每个端点读取一页、最多 100 条记录；如果两次轮询间发生更大规模的突发更新，游标推进后可能会漏掉记录。对于繁忙的 installation，请减小 `GITHUB_POLL_INTERVAL` 或缩小 `GITHUB_REPOS` 范围。

去重使用持久保存在 `<state-dir>/github-sync.json` 中的水位线（原子写入）：

- 首次运行只记录基线，不发出任何事件——历史记录永远不会触发运行。
- 已处理的评论/issue ID 永远不会再次触发，编辑也不会再次触发。
- mikan 停机期间发布的评论会在重启后重放。

## 触发方式

仅当评论（或新 issue 正文）@提及 app slug，或 bot 已参与该 issue 的对话时，才会触发运行。评论者还必须对仓库具有**写入权限或更高权限**——在公开仓库中任何人都可以评论，因此所有写入权限以下用户的提及都会被完全忽略（权限查询缓存五分钟，失败时默认拒绝）。其他所有内容都会被忽略，不创建任何状态。提及 bot 的 `stop` 评论会停止运行中的会话。

## 会话和回复

整个 issue/PR 是一个持久会话（`sessionKey === conversationId`）；PR review-line 话题尚未映射到子会话。回复使用 GitHub Flavored Markdown，并在回复完成后发布——不进行流式编辑，因此回复不会频繁调用 API 或显示为“edited”。超过评论拆分阈值的输出会作为后续评论发布。系统提示会告知代理对话对应的 issue/PR（owner/repo#number）。首次通过评论联系时，会先记录 issue 标题/正文，使会话了解话题内容。

## 仓库访问和 pull request

沙箱从不持有凭证；git 操作横跨对话目录 bind mount 的两侧：

- 首次联系时，仓库会被浅克隆到对话目录（沙箱内为 `./repo`），使用仅限该仓库和 `contents:read` 的临时 token。token 按 git 调用传入，绝不会写入 `.git/config`。PR 对话会签出 PR head，名称为 `pr-<n>`。
- 代理在沙箱中使用普通 git 创建分支和提交（bot 的 author identity 已预配置）；按设计，从沙箱 push 会失败。
- `github_pr` 工具在主机侧运行：它为该仓库生成 `contents:write` + `pull_requests:write` token，从挂载的主机侧推送代理的 `pi/*` 分支，并以 App 身份创建 pull request（支持 draft）；使用相同分支再次调用会将新提交推送到现有 PR。它不能推送默认分支、force-push 或 merge——每个 PR 都由人工 review 和 merge。
- `github_checks` 工具读取已推送分支（或 PR head）的 CI check run，并可以获取失败 job 的日志末尾，使代理能够诊断并迭代，直到 CI 通过。需要 App 权限 **Checks: Read** 和 **Actions: Read**（用于日志）。

这些工具使用设置部分列出的 App 权限，无法绕过 mikan 强制实施的分支/默认分支保护。

## 限制

- REST API 不支持文件上传；`uploadFile` 会改为发布指针评论。
- PR review 话题（diff-line 评论）已规划，但尚未轮询。
- `./repo` 克隆是首次联系时的快照；沙箱无法获取更新。
