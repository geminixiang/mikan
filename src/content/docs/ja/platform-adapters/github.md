---
title: GitHub 接続
description: 紐付けた GitHub アカウントと webhook による駆動、issue/PR conversation、制限設定、comment による応答。
---

1 つの GitHub issue または pull request が 1 つの mikan conversation になります。mikan は紐付けた通常の GitHub アカウントとして動作するため、チームメイトと同じように、オートコンプリートで @ メンションし、issue や PR を assign し、review を依頼できます。何が起きたかは署名付き webhook で mikan に届きます。理由は [ADR 0015](https://github.com/geminixiang/mikan/blob/main/docs/adr/0015-github-agent-account-and-webhooks.md) を参照してください。

conversation id は `GH_<owner>_<repo>_<number>` で、owner と repo は小文字化されます。id は 1 つの path segment としてそのまま使われ、docker の `-v source:target` 構文にも入るため、`/` と `:` を避けています。また `-` ではなく `_` で区切るのは、GitHub の owner が `-` を含み得る（それでは owner/repo の境界が曖昧になる）一方で `_` は含まないためです。他のすべてのプラットフォームと同じく、生 id は GitHub API の境界に留まります。ディスク上では、この conversation は office key で命名された office directory に存在します。

## 主なコード

| ファイル                            | 役割                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot の中核：トリガー判定、権限確認、conversation への投入。                                                  |
| `src/adapters/github/activity.ts`   | webhook payload を検証し、1 つの activity 形式に正規化します。                                                      |
| `src/adapters/github/policy.ts`     | 制限設定を解析して適用します。                                                                                      |
| `src/adapters/github/webhook.ts`    | 署名を検証し、GitHub に応答し、重複配信を捨てます。                                                                 |
| `src/adapters/github/github-ops.ts` | 各 `github_*` tool の host 側 backend。                                                                             |
| `src/adapters/github/client.ts`     | アカウントの token で認証する最小限の REST client。                                                                 |
| `src/adapters/github/context.ts`    | GitHub の `ConversationResponder` を作成し、完成した応答を 1 つの comment として投稿します（streaming edit なし）。 |
| `src/adapters/github/ids.ts`        | `rc-<id>` review-comment ts。`GH_<owner>_<repo>_<number>` の文法は `src/office/index.ts` にあります。               |
| `src/adapters/github/tool-pack.ts`  | host 側 tools を main から注入される platform tool pack にまとめます。                                              |
| `src/adapters/github/tools/`        | agent 向け tools：`github_pr`、`github_checks`、`github_review_reply`、`github_read`、`github_issue`。              |

## 必要なもの

- **agent アカウント**：mikan 用の通常の GitHub ユーザーアカウントで、作業する repository へのアクセス権を持つもの。各 repository でのロールが外側の上限になります。会話だけなら read、branch を push するなら write です。
- **そのアカウントの fine-grained personal access token**：resource owner は organization、repository permissions は **Contents**、**Issues**、**Pull requests** が read & write、**Actions** と **Commit statuses** が read。organization が承認を求める場合は owner が承認します。
- **webhook**：`<LINK_URL>/github/webhook` 宛てで secret を設定し、**Issues**、**Issue comments**、**Pull requests**、**Pull request review comments** を購読します。organization webhook が最も簡単です。GitHub App の webhook でも動作し、mikan は App の認証情報を使いません。
- **link server**（`LINK_PORT` と公開された `LINK_URL`）。webhook を受け取ります。

## 設定

| 環境変数                | 用途                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `GITHUB_AGENT_TOKEN`    | アカウントの fine-grained PAT（必須）。GitHub が拒否すると起動に失敗します。     |
| `GITHUB_WEBHOOK_SECRET` | webhook の secret（必須）。                                                      |
| `GITHUB_REPOS`          | カンマ区切りの `owner/repo` または `owner/*`（必須）。それ以外には応答しません。 |
| `GITHUB_PUBLIC_REPOS`   | `true` で public repository にも応答します（既定 `false`）。                     |
| `GITHUB_USERS`          | トリガーできるログインのカンマ区切りリスト（既定：必要な権限を持つ全員）。       |
| `GITHUB_MIN_PERMISSION` | トリガーに必要な repository 権限：`write`（既定）、`maintain`、`admin`。         |
| `GITHUB_TRIGGERS`       | `mention`、`assign`、`review`、`followup` の任意の組み合わせ（既定はすべて）。   |
| `GITHUB_CAPABILITIES`   | コメント以外に許可する `triage` と `push`（既定はどちらもなし）。                |

不明な値があると起動に失敗します。

## トリガー

配信は次をすべて満たすときだけ実行を開始します。

1. 送信者が bot でも agent アカウント自身でもない。
2. repository が `GITHUB_REPOS` に一致し、`GITHUB_PUBLIC_REPOS=true` でない限り private である。
3. 有効なトリガーである：
   - `mention`：新しい issue、pull request、comment、inline review comment が `@<login>` をメンションした；
   - `assign`：issue または pull request がアカウントに assign された；
   - `review`：pull request でアカウントの review が依頼された；
   - `followup`：mikan がすでに参加している thread に新しい comment が来た。
4. `GITHUB_USERS` が設定されていれば、送信者がそこに含まれる。
5. 送信者が repository で `GITHUB_MIN_PERMISSION` 以上の権限を持つ。確認結果は 5 分間キャッシュされ、失敗時は拒否します。

それ以外は状態を作らずに無視します。メンション付きの `stop`（または `/stop`）comment は実行中の session を止めます。

配信はベストエフォートです。mikan はすぐに GitHub へ応答し、重複配信を無視し、配信記録を残しません。mikan が停止中または到達不能な間のイベントは失われるので、もう一度メンションしてください。

## ケイパビリティ

`GITHUB_CAPABILITIES` がなければ、mikan はコメント、リアクション、repository と CI 結果の読み取り、review thread への返信ができますが、label、assignee、コードは変更できません。

| ケイパビリティ | 追加されるもの                                                   |
| -------------- | ---------------------------------------------------------------- |
| `triage`       | `github_issue` tool：label、assignee、close と reopen。          |
| `push`         | `github_pr` tool と、branch の push と pull request 作成の説明。 |

無効なケイパビリティの tool と説明は agent に一切渡されませんが、認証情報は取り上げません。agent が sandbox から何を push できるかは、sandbox の GitHub token、アカウントの repository ロール、branch protection で決まります。default branch を保護し、agent の変更がレビュー済みの pull request 経由でしか入らないようにしてください。

write 権限以上を持つ collaborator だけが mikan をトリガーできるため、GitHub は `trustModel: "membership"` を報告します。そのため GitHub conversation も Slack と同様に `sandbox.defaultSharedVault` と settings で宣言した MCP servers を受け取ります。[Vault](/ja/sandbox/vault/) を参照してください。

## Session と返信

issue/PR 全体が 1 つの永続 session（`sessionKey === conversationId`）で、inline review thread もそこに平坦化されます。トリガーした review comment は `[PR review comment rc-<id> on <path>:<line>]` というタグ付きメッセージとして diff hunk とともに注入され、thread 途中の返信にはそれまでのやり取りも付きます。agent は `github_review_reply` tool でその thread に答えます。応答は GitHub Flavored Markdown で、完成後に投稿されます。comment 経由の初回接触では、issue のタイトルと本文を先に記録します。

## Repository アクセスと pull request

mikan は host で git を実行しません。agent は自分の sandbox 内で、sandbox の GitHub 認証情報を使って repository を scratch ディレクトリに clone し、`gh pr checkout` で pull request に切り替え、agent アカウントとして commit して push します。認証情報がなければ public repository にしかアクセスできません。

- `github_pr`（ケイパビリティ `push`）は agent がすでに push した branch の pull request（draft 可）を作成します。その branch に open な PR があればその PR を返します。push はせず、merge もできません。
- `github_checks` は push した branch または PR head の GitHub Actions job と commit status を読み、`job_id` で Actions job のログ末尾を取得します。fine-grained token には Checks 権限がないため、サードパーティ CI app の check run は見えません。
- `github_review_reply` は 1 つの inline review thread に返信します。
- `github_read` は conversation の repository の PR 状態、変更ファイル、review、issue、comment を読みます。
- `github_issue`（ケイパビリティ `triage`）は label、assignee、close/reopen を管理します。lock、delete、transfer はありません。

## 制限

- 取りこぼした webhook 配信は再送されません。
- REST API はファイル添付に対応しないため、`uploadFile` は案内 comment を投稿します。
- summary 本文だけでアカウントをメンションし inline comment がない PR review はトリガーしません。review を依頼するか、comment してください。
