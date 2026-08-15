---
title: Portal 認証と capability モデル
description: mikan の web dashboard と portal が使う、ブラウザー identity と scoped capability のモデル。
---

この設計の目的は、ユーザーが管理、ログイン、session 閲覧ページを手軽に開けるようにしつつ、「データを見る」「設定を変更する」「secret を書き込む」を同じ権限に混ぜないことです。

## 4 つの web authority

| 画面                  | ユーザーの取得方法                                                   | できること                                                                                                    | 有効期間 | Token は一回限りか |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- | ------------------ |
| Web dashboard session | `/login web` で bind し、その後 `/login` で GitHub にサインイン      | bind された正確な conversation を検出し、session-view capability で開く。                                     | 24 時間  | いいえ             |
| Admin portal          | `/admin` / `/pi-admin`                                               | conversations、model、sandbox、auto-reply、workspace previews、events を管理。session/login link も生成可能。 | 30 分    | いいえ             |
| Login / vault portal  | `/login` / `/pi-login`、または admin portal から生成                 | API keys を保存、または組み込み OAuth flow を完了し、credentials を vault に書き込む。                        | 15 分    | 書き込み時ははい   |
| Session view          | `session` / `/session` / `/pi-session`、または admin portal から生成 | session timeline を閲覧。interactive mode が利用できる場合は、Web からその session へメッセージ送信も可能。   | 24 時間  | いいえ             |

簡単に言うと：

```text
/login   → private chat binding 後に browser identity を確立
/admin   → 設定変更、workspace 閲覧、他の link 生成
/link    → vault secrets または OAuth credentials の書き込み
/session → session 閲覧；任意で session へメッセージ返信
```

React SPA はこれらのページを 1 つの site に表示しますが、authorization は意図的に相互利用できません。

## 権限境界

### Web dashboard session

`/login web` は private chat に短時間有効な binding code を作成します。この binding を完了すると、GitHub OAuth identity、platform user、正確な source conversation が記録されます。その後の GitHub サインインでは、その binding が存在する場合に限り、httpOnly の `mikan_session` cookie が発行されます。これは in-memory の 24 時間 web session です。binding がなければログインは拒否されます。

Dashboard session でできること：

- `/api/me` から自分の identity を読み取る。
- `/api/offices` から自分が正確に bind された office だけを一覧表示する。
- session file が存在する場合、その office の session-view URL を受け取る。
- `/api/logout` から自分自身を revoke する。

他の office を列挙したり、host filesystem path を受け取ったり、Admin API を認可したり、vault credentials を書き込んだりすることはできません。binding と browser session は in-memory なので、mikan を再起動すると binding とサインインをやり直す必要があります。

### Admin portal

Admin portal は control-plane access です。admin link を持つ人は、短時間だけ mikan の設定と conversation 状態を管理できます。

Admin portal でできること：

- 現在の user と conversation identity を確認する。
- workspace を走査するのではなく、office registry（永続的な raw-id ↔ office 対応）から conversations を一覧表示する。
- conversation model、thinking level、workspace の door policy と layout、auto-reply、Slack reply mode を読み取り・更新する。
- global model、sandbox の resource defaults、global door policy、Slack defaults を読み取り・更新する。
- 限定範囲の workspace files、skills、events metadata/files を閲覧し、どちらの level でも skill を作成・編集する。
- ある scope の package sources を一覧表示・変更する。
- session と conversation の使用状況を確認する。
- 選択した conversation の events を削除する。
- 対象 conversation 用の session view link または login/vault link を生成する。

Door policy はチャットからも `/pi-sandbox door` で設定できますが、agent 自身が設定することは決してできません。conversation settings が host 専用の state dir 配下にあるのは、まさに conversation directory が sandbox に読み書き可能で bind mount されるからです。mount 内の settings file は一度だけ移行され、その後は二度と読まれません。

Admin portal は secret values を直接書き込みません。admin portal から login link を生成した場合でも、実際の secret write は Login / vault portal の one-time token flow を通ります。

### Login / vault portal

Login / vault portal は、credentials を書き込めるため最もリスクの高い action capability です。

Login / vault portal でできること：

- 指定 vault の credential または OAuth onboarding form を表示する。
- 環境変数をその vault に書き込む。
- preset または OAuth flow に従い、対応ツールが必要とする設定 file などの credential files を書き込む。
- 対応 OAuth flow を完了し、access token、refresh token、credential file を保存する。
- 書き込み成功後、送信元 conversation に通知する。

Login token の重要な動作：

- `/link` page を開いても token は消費されない。
- OAuth を開始しても token は消費されない。
- credential POST または OAuth callback 完了時に token が消費される。
- 同じ platform user が新しい login token を作成すると、古い login token は無効になる。

追加保護：

- Credential POST route は `Content-Type: application/json` を要求する。
- `LINK_URL` / `MIKAN_LINK_URL` が設定されている場合、credential POST route は same-origin の `Origin` または `Referer` を確認する。
- OAuth state は login token から独立し、TTL は 10 分で、PKCE verifier を使う。
- Secret values は browser へ再 render されない。既存 vault summary は secret names と mount targets だけを表示する。

### Session view

Session view は session content access です。主な用途は structured session timeline の閲覧です。

Session view でできること：

- session timeline を render する。
- parent/thread session relationships をたどる。
- SSE 経由で live status と timeline updates を購読する。
- interactive wiring が利用できる場合、Web から選択中の session へメッセージを送る。

Session view は純粋な read-only ではありません。`/session/message` route が存在し、interactive wiring が利用できる場合、session view token は `session_view` event を送信して bot handler を呼び出せます。

Session view token は base session file に固定されます。`/session?session=<file.jsonl>` で移動する場合、同じ directory 内の session files にだけ切り替えられます。

## Route と token の対応

| Route                | Method | Authority         | 検証方法                                               | 備考                                                    |
| -------------------- | ------ | ----------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `/api/me`            | `GET`  | `mikan_session`   | `webSessionStore.getSessionFromCookie()`               | 現在の dashboard identity を返す。                      |
| `/api/logout`        | `POST` | `mikan_session`   | 一致する browser session を revoke                     | browser cookie を消去する。                             |
| `/api/offices`       | `GET`  | `mikan_session`   | 正確な session binding + office registry               | scoped office metadata と session-view URL を返す。     |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                               | Admin portal を render。                                |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                               | 未認可なら 403。                                        |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                               | 未認可なら 403。                                        |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                                | login/vault page を render；token は消費しない。        |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`                             | credentials を書き込み；token を消費。                  |
| `/api/oauth/start`   | `POST` | JSON body + mode  | Vault token、binding code、または dashboard login mode | OAuth redirect と one-shot state を作成する。           |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + 開始時に選択された authority             | binding、browser login、または vault OAuth を完了する。 |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`                         | session page を render。                                |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`                         | SSE stream を開く；interactive wiring が必要。          |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`                         | session message を送信；interactive wiring が必要。     |

## なぜ同じ token type を使わないのか

authority ごとにリスクが異なります：

- Web session：正確な conversation に bind された再利用可能な identity で、自分の session-view capability だけを mint できる。
- Admin token：再利用可能な短期管理権限。
- Login token：secret を書き込めるため寿命がより短く、書き込み時に消費される。
- Session view token：session の共有と見返しに便利なため長めに有効だが、権限は session view の範囲に限定される。

Dashboard identity はこれらの境界を一つにまとめません。Admin の変更と secret write にはそれぞれ専用の capability が必要であり、standalone session link は独立して共有できます。

## 実装場所

| 機能                 | 主要コード                                                        |
| -------------------- | ----------------------------------------------------------------- |
| Portal HTTP server   | `startWebServer()` in `src/web/server.ts`                         |
| Web dashboard login  | `src/web/login/portal.ts`、`src/web/login/session-store.ts`       |
| Admin portal         | `src/web/admin/portal.ts`、`src/web/admin/store.ts`               |
| Login / vault portal | `src/web/login/portal.ts`、`src/web/login/store.ts`               |
| Session view         | `src/web/session-view/portal.ts`、`src/web/session-view/store.ts` |
| 共通 token store     | `src/web/token-store.ts`                                          |
| React SPA            | `apps/web/`、`packages/web-client/`、`packages/ui-*`              |

`startWebServer()` の dispatch 順序：

1. `GET /health`
2. Agent event HTTP routes
3. Admin routes
4. Session view routes
5. Login、binding、authenticated office routes
6. Static SPA fallback、それ以外は `404`

Server は `LINK_PORT` / `MIKAN_LINK_PORT` を port として解析できる場合だけ起動します。`LINK_URL` / `MIKAN_LINK_URL` が設定され、port が設定されていない場合、mikan は既定 port `8181` を使います。

Capability stores、完了済み binding、browser session は現在 in-memory です。Process を再起動するとすべて無効になります。Capability stores は定期的に purge され、browser session は lookup 時にも遅延して expire します。

これらの URL は bearer capability です。query-string token は browser history、screenshots、コピーされた URL、proxy logs から漏洩する可能性があります。意図したユーザーとのみ共有し、chat channels や issue trackers には絶対に公開しないでください。
