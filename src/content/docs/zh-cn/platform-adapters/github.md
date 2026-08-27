---
title: GitHub 适配器
description: GitHub 适配器的 GitHub App 轮询、issue/PR 对话、水位线去重和基于评论的回复。
---

每个 GitHub issue 或 pull request 都是一个 mikan 对话。适配器以 GitHub App installation 身份轮询 GitHub API，不使用 webhook 端点，以保留 mikan 的主动模型。

对话 id 为 `GH_<owner>_<repo>_<number>`，其中 owner 和 repo 都转为小写。它避开了 `/` 和 `:`，因为 id 会被原样用作一个路径段，也会用在 docker 的 `-v source:target` 语法中；它以 `_` 而非 `-` 分隔，是因为 GitHub owner 可能包含 `-`（那会让 owner/repo 的边界产生歧义），但绝不会包含 `_`。和所有平台一样，原始 id 只停留在 GitHub API 边界上：在磁盘上，该对话位于一个以 office key 命名的办公室目录中。

## 主要代码

| 文件                                | 用途                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot 核心：轮询循环、水位线去重、提及/参与触发。                                                              |
| `src/adapters/github/github-ops.ts` | 每个 `github_*` 工具背后的主机侧后端，独立于轮询循环。                                                              |
| `src/adapters/github/repo.ts`       | 主机侧 git：浅克隆、受保护的分支推送、保留工作的同步。                                                              |
| `src/adapters/github/client.ts`     | 以 GitHub App 身份验证的最小 REST 客户端（RS256 JWT → installation tokens）。                                       |
| `src/adapters/github/context.ts`    | 创建 GitHub `ConversationResponder`；将完成的回复作为一条评论发布（不进行流式编辑）。                               |
| `src/adapters/github/ids.ts`        | `GH_<owner>_<repo>_<number>` 对话 ID 编码/解析；`rc-<id>` review 评论 ts。                                          |
| `src/adapters/github/tool-pack.ts`  | 把主机侧工具打包为由 main 注入的平台工具包。                                                                        |
| `src/adapters/github/tools/`        | 面向代理的工具：`github_pr`、`github_checks`、`github_review_reply`、`github_sync`、`github_read`、`github_issue`。 |
| `src/adapters/github/types.ts`      | GitHub 适配器专用类型和 REST payload 结构。                                                                         |

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

轮询循环针对每个监视的仓库，使用 ETag 条件请求获取自增量游标以来更新的 issue、issue/PR 评论以及 PR 内联 review 评论（304 响应不计入 rate limit）。目前每个端点读取一页、最多 100 条记录；如果两次轮询间发生更大规模的突发更新，游标推进后可能会漏掉记录。对于繁忙的 installation，请减小 `GITHUB_POLL_INTERVAL` 或缩小 `GITHUB_REPOS` 范围。

去重使用持久保存在 `<state-dir>/github-sync.json` 中的水位线（原子写入）：

- 首次运行只记录基线，不发出任何事件——历史记录永远不会触发运行。
- 已处理的评论/issue ID 永远不会再次触发，编辑也不会再次触发。
- mikan 停机期间发布的评论会在重启后重放。

## 触发方式

仅当评论、内联 review 评论或新 issue 正文 @提及 app slug，或 bot 已参与该 issue 的对话时，才会触发运行。评论者还必须对仓库具有**写入权限或更高权限**——在公开仓库中任何人都可以评论，因此所有写入权限以下用户的提及都会被完全忽略（权限查询缓存五分钟，失败时默认拒绝）。其他所有内容都会被忽略，不创建任何状态。提及 bot 的 `stop`（或 `/stop`）评论会停止运行中的会话；该魔法词在所有平台上使用同一套语法。

由于任何人都可以在公开仓库上开 issue，GitHub 报告 `trustModel: "open-trigger"`。这会为 GitHub 对话禁用环境 `sandbox.defaultSharedVault` 复制：它们默认不获得任何凭证，管理员必须有意地为某个特定对话配置 vault。参阅 [Vault](/zh-cn/sandbox/vault/)。

## 会话和回复

整个 issue/PR 是一个持久会话（`sessionKey === conversationId`）——包括内联 review 话题，它们被展平合入该会话，而不是映射到子会话。触发运行的 review 评论会作为带有 `[PR review comment rc-<id> on <path>:<line>]` 标签的消息注入，携带对应的 diff hunk；如果是话题中途的回复，还会附带该话题此前的对话轮次。代理使用 `github_review_reply` 工具回复该话题（普通回复会作为常规 PR 评论发布）。回复使用 GitHub Flavored Markdown，并在回复完成后发布——不进行流式编辑，因此回复不会频繁调用 API 或显示为“edited”。超过评论拆分阈值的输出会作为后续评论发布。系统提示会告知代理对话对应的 issue/PR（owner/repo#number）。首次通过评论联系时，会先记录 issue 标题/正文，使会话了解话题内容。

## 仓库访问和 pull request

沙箱从不持有凭证；git 操作横跨办公室目录 bind mount 的两侧：

- 首次联系时，仓库会被浅克隆到该对话办公室的 `repo/` 目录——沙箱内为 `/workspace/<office-key>/repo`，代理的提示词中称之为 `./repo`——使用仅限该仓库和 `contents:read` 的临时 token。token 按 git 调用传入，绝不会写入 `.git/config`。PR 对话会以 PR head 的真实分支名签出（fork PR 或查询失败时回退为 `pr-<n>`），因此 head 为 `pi/*` 分支的 PR 可以原地更新：直接在该分支上提交并调用 `github_pr`，推送会回到同一个 PR。
- 代理在沙箱中使用普通 git 创建分支和提交（bot 的 author identity 已预配置）；按设计，从沙箱 push 会失败。
- `github_pr` 工具在主机侧运行：它为该仓库生成 `contents:write` + `pull_requests:write` token，从挂载的主机侧推送代理的 `pi/*` 分支，并以 App 身份创建 pull request（支持 draft）；使用相同分支再次调用会将新提交推送到现有 PR。它不能推送默认分支、force-push 或 merge——每个 PR 都由人工 review 和 merge。
- `github_checks` 工具读取已推送分支（或 PR head）的 CI check run，并可通过 `job_id` 获取 GitHub Actions job 的日志末尾（需要 **Checks: Read** 和 **Actions: Read** 权限）。外部 CI check 会保留摘要和 URL，但其日志无法通过 GitHub 获取。
- `github_sync` 工具从 origin 刷新 `./repo` 快照——最新的 PR head、base 分支或指定分支——使用临时只读 token。仅当不会丢失代理的工作时（工作树干净、没有代理提交；被 force-push 的 PR head 仍会同步），它才会移动检出；否则它只 fetch 到 `FETCH_HEAD` 并报告结果，由代理在沙箱内自行 merge 或 rebase。
- `github_review_reply` 工具在一个内联 review 话题内发布回复，数字 id 取自 `rc-<id>` 消息。
- `github_read` 工具读取克隆无法展示的元数据：PR 状态和 diff 统计、变更文件、已提交的 review 及未解决话题 id、issue 元数据、最近评论，以及经过滤的 issue/PR 列表。它在构造上就限定于对话所属的仓库。
- `github_issue` 工具管理对话所属仓库中任意 issue 的 label、assignee 和 close/reopen（triage）。lock、delete 和 transfer 不在其操作集内。

这些工具使用设置部分列出的 App 权限，无法绕过 mikan 强制实施的分支/默认分支保护。

## 限制

- REST API 不支持文件上传；`uploadFile` 会改为发布指针评论。
- 仅在摘要正文中提及 bot（没有任何内联评论）的 PR review 不会触发——不存在仓库级的 “reviews since” 端点。请改为发布普通 PR 评论。
- `./repo` 克隆是首次联系时的快照；沙箱自身无法获取更新——代理需使用 `github_sync` 来刷新。
- 缺失的克隆会在每次触发时重新尝试（一旦存在即为空操作），因此首次克隆失败——例如 App 权限是后来才授予的——会在下一次提及时自愈。
