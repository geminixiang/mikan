---
title: GitHub 接続
description: GitHub adapter の GitHub App polling、issue/PR conversations、watermark dedup、comment-based responses。
---

1 つの GitHub issue または pull request が 1 つの mikan conversation になります。adapter は GitHub App installation として GitHub API を poll します。webhook endpoint は不要で、mikan の proactive model を維持します。

## 主要コード

| ファイル                            | 用途                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot 本体：poll loop、watermark dedup、mention/participation triggering、tool backends。                          |
| `src/adapters/github/client.ts`     | GitHub App として認証する最小 REST client（RS256 JWT → installation tokens）。                                          |
| `src/adapters/github/cloudbuild.ts` | `github_checks` 用の Cloud Build log 取得（host 側の GCP credentials）。                                                |
| `src/adapters/github/context.ts`    | GitHub 版 `ConversationResponder` を作成し、完成した response を 1 つの comment として投稿（streaming edits なし）。    |
| `src/adapters/github/ids.ts`        | `GH_<owner>_<repo>_<number>` conversation id の encode/parse。`rc-<id>` review-comment ts。                             |
| `src/adapters/github/tools/`        | agent 向けの tools：`github_pr`、`github_checks`、`github_review_reply`、`github_sync`、`github_read`、`github_issue`。 |
| `src/adapters/github/types.ts`      | GitHub adapter 固有の types と REST payload shapes。                                                                    |

## GitHub App の作成とインストール

1. 対象 repositories を所有する account または organization 用に GitHub App を作成します。
2. repository permissions を付与します：**Metadata: Read**、**Contents: Read & write**、**Issues: Read & write**、**Pull requests: Read & write**、**Checks: Read**、**Actions: Read**。Issues/PR write access は comments と reactions を対象とし、Contents/Pull requests write access は保護された `github_pr` tool だけが使用します。
3. mikan が poll してよい repositories に App をインストールします。
4. App ID と installation ID を記録し、private key を生成します。PEM は workspace の外に保管し、inline secret より `GITHUB_APP_PRIVATE_KEY_PATH` を優先してください。

App slug は、ユーザーが最初の接触を起動するために mention する名前です。

## 設定

| 環境変数                                                 | 用途                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                                          | GitHub App id（必須）。                                                                     |
| `GITHUB_INSTALLATION_ID`                                 | 動作主体となる installation id（必須）。                                                    |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` | App private key PEM。inline（`\n` escapes 付き）または file。                               |
| `GITHUB_REPOS`                                           | 任意の comma-separated `owner/repo` list。既定値は installation のすべての repositories。   |
| `GITHUB_POLL_INTERVAL`                                   | 任意の poll interval（秒、既定値 60）。                                                     |
| `GOOGLE_APPLICATION_CREDENTIALS`                         | 任意の GCP ADC JSON への path。`github_checks` の Cloud Build logs を有効化します（後述）。 |
| `GOOGLE_CLOUD_PROJECT`                                   | Cloud Build check が project を指定しない場合の任意の fallback GCP project。                |

## イベントソース

poll loop は監視対象 repo ごとに、incremental cursor 以降に更新された issues、issue/PR comments、inline PR review comments を取得し、ETag conditional requests を使用します（304 responses は rate limit を消費しません）。現在、各 endpoint は最大 100 records の 1 page だけを読み取ります。poll 間にそれを超える burst があると、cursor の前進時に見落とす可能性があります。利用の多い installations では `GITHUB_POLL_INTERVAL` を短くするか、`GITHUB_REPOS` を限定してください。

Dedup は `<state-dir>/github-sync.json` に永続化される watermark です（atomic write）：

- 初回実行は baseline を記録し、何も生成しません。履歴が trigger になることはありません。
- 処理済み comment/issue ids は再度 trigger にならず、編集でも再 trigger になりません。
- mikan 停止中に投稿された comments は再起動後に replay されます。

## Trigger

comment、inline review comment、または新しい issue body は、App slug を @mention するか、bot がすでにその issue conversation に参加している場合のみ run を起動します。commenter は repo で **write permission 以上**も保持している必要があります。public repos では誰でも comment できるため、write 未満のユーザーによる mentions は完全に無視されます（permission lookups は 5 分間 cache され、失敗時は拒否します）。その他は state を作成せずにすべて無視されます。mention 付きの `stop` comment は実行中の session を停止します。

## Sessions と返信

issue/PR 全体が 1 つの永続 session（`sessionKey === conversationId`）です。inline review threads も含まれ、sub-sessions に対応付けるのではなく session に flatten されます。trigger となった review comment は `[PR review comment rc-<id> on <path>:<line>]` と tag 付けされた message として注入され、diff hunk と、thread 途中への返信の場合はその thread の以前のやり取りを含みます。agent は `github_review_reply` tool でその thread に返信します（通常の response は普通の PR comment として投稿されます）。Responses は GitHub Flavored Markdown で、response 完了後に投稿されます。streaming edits は行わないため、API を頻繁に更新したり「edited」と表示したりしません。comment split threshold を超える output は continuation comments として投稿されます。system prompt は agent に conversation の issue/PR（owner/repo#number）を伝えます。comment から初めて接触した場合、その前に issue title/body を記録し、session が thread の内容を把握できるようにします。

## Repository access と pull requests

sandbox は credentials を一切保持しません。git は conversation-dir bind mount の両側にまたがって動作します：

- 初回接触時に repo は conversation dir（sandbox 内では `./repo`）へ shallow-clone されます。その repo と `contents:read` に限定した ephemeral token を git invocation ごとに渡し、`.git/config` には書き込みません。PR conversations では PR head が実際の branch 名で checkout されます（fork PR や lookup 失敗時は `pr-<n>` に fallback）。そのため head が `pi/*` branch の PR はその場で更新できます：その branch に commit して `github_pr` を呼べば同じ PR に push されます。
- agent は sandbox 内で通常の git を使って branch と commit を作成します（bot の author identity は事前設定済み）。sandbox からの push は設計上失敗します。
- `github_pr` tool は host 側で実行されます。その 1 repo 用の `contents:write` + `pull_requests:write` token を発行し、mount の host 側から agent の `pi/*` branch を push して、App として pull request（draft 対応）を開きます。同じ branch で再実行すると、既存 PR に新しい commits を push します。default branch の push、force-push、merge はできません。すべての PR は人が review、merge します。
- `github_checks` tool は push 済み branch（または PR head）の CI check runs を読み取り、失敗した run の log tail を取得できます。GitHub Actions runs には `job_id` を使用し（**Checks: Read** と **Actions: Read** が必要）、host に GCP credentials がある場合は Google Cloud Build runs に `build_id` を使用します（後述）。
- `github_sync` tool は `./repo` snapshot を origin から更新します。最新の PR head、base branch、または指定した branch です。ephemeral read token を使用し、agent の作業を失う可能性がない場合のみ checkout を動かします（clean tree かつ agent commits なし。force-push された PR heads は sync されます）。それ以外の場合は `FETCH_HEAD` に fetch して報告し、agent が sandbox 内で merge または rebase できるようにします。
- `github_review_reply` tool は 1 つの inline review thread 内に返信を投稿します。numeric id は `rc-<id>` message から取得します。
- `github_read` tool は clone では見えない metadata を読み取ります。PR state と diff stats、changed files、open thread ids 付きの submitted reviews、issue metadata、直近の comments、filter 付きの issue/PR listing です。構造上、conversation の repo に限定されます。
- `github_issue` tool は conversation の repo 内の任意の issue に対して labels、assignees、close/reopen を管理します（triage 用）。Lock、delete、transfer は action set に含まれません。

これらの tools は setup section に記載した App permissions を使用します。mikan が強制する branch/default-branch guards を回避することはできません。

## Cloud Build logs（任意）

CI が Google Cloud Build で動作する場合、その check runs は GitHub 上で external CI として表示され、logs を GitHub API 経由で取得できません。**host** 側で `GOOGLE_APPLICATION_CREDENTIALS` に GCP Application Default Credentials JSON を設定すると — Workload Identity Federation の `external_account` file（file または url credential source）、service-account key、gcloud user ADC のいずれか — `github_checks` の summaries が `[build <uuid>]` handles を提示し、その logs を取得できるようになります（builds.get → build の logs bucket 内の `log-<uuid>.txt` object、tail-truncated）。

credential principal には project に対する `roles/cloudbuild.builds.viewer` と、logs bucket に対する `roles/storage.objectViewer` が必要です。`CLOUD_LOGGING_ONLY` で構成された builds は GCS log object を書き込まないため、tool は代わりに console URL を返します。credentials が sandbox に入ることはありません。credentials がない場合、Cloud Build checks は従来の guidance text に degrade します。

## 制限

- REST API は file uploads に対応していません。`uploadFile` は代わりに pointer comment を投稿します。
- summary body だけが bot に mention する PR review（inline comments が 0 件）は trigger になりません。repo 全体の "reviews since" endpoint が存在しないためです。代わりに通常の PR comment を投稿してください。
- `./repo` clone は初回接触時の snapshot として始まります。sandbox 自身は updates を fetch できないため、agent は `github_sync` を使用します。
