---
title: Portal 認証と capability モデル
description: mikan admin、login、session portal が使う短期 capability token の権限モデル。
---

この設計の目的は、ユーザーが管理、ログイン、session 閲覧ページを手軽に開けるようにしつつ、「データを見る」「設定を変更する」「secret を書き込む」を同じ権限に混ぜないことです。

## 3 種類の portal link

| 画面                 | ユーザーの取得方法                                                   | できること                                                                                                      | Token 有効期間 | Token は一回限りか |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| Admin portal         | `/admin` / `/pi-admin`                                               | conversations、モデル、sandbox、auto-reply、workspace previews、events を管理。session/login links も生成可能。 | 30 分          | いいえ             |
| Login / vault portal | `/login` / `/pi-login`、または admin portal から生成                 | API keys を保存、または組み込み OAuth flow を完了し、credentials を vault に書き込む。                          | 15 分          | 書き込み時ははい   |
| Session view         | `session` / `/session` / `/pi-session`、または admin portal から生成 | session timeline を閲覧。interactive mode が利用できる場合は、Web からその session へメッセージ送信も可能。     | 24 時間        | いいえ             |

簡単に言うと：

```text
/admin   → 設定変更、workspace 閲覧、他の link 生成
/link    → vault secrets または OAuth credentials の書き込み
/session → session 閲覧；任意で session へメッセージ返信
```

この 3 つのページは同じ portal 外観を共有しますが、同じ authorization token は共有しません。

## 権限境界

### Admin portal

Admin portal は control-plane access です。admin link を持つ人は、短時間だけ mikan の設定と conversation 状態を管理できます。

Admin portal でできること：

- 現在のユーザーと conversation identity を確認する。
- working directory 内の conversations を一覧表示する。
- conversation model、thinking level、sandbox mount、auto-reply、Slack reply mode を読み取り・更新する。
- global model、sandbox defaults、Slack defaults を読み取り・更新する。
- 限定範囲の workspace files、skills、events metadata/files を閲覧する。
- 選択した conversation の events を削除する。
- 対象 conversation 用の session view link または login/vault link を生成する。

Admin portal は secret values を直接書き込みません。admin portal から login link を生成した場合でも、実際の secret write は Login / vault portal の one-time token flow を通ります。

### Login / vault portal

Login / vault portal は、credentials を書き込めるため最もリスクの高い action capability です。

Login / vault portal でできること：

- 指定 vault の credential または OAuth onboarding form を表示する。
- 環境変数をその vault に書き込む。
- preset または OAuth flow に従い、対応ツールが必要とする設定ファイルなどの credential files を書き込む。
- 対応 OAuth flow を完了し、access token、refresh token、credential file を保存する。
- 書き込み成功後、送信元 conversation に通知する。

Login token の重要な動作：

- `/link` ページを開いても token は消費されない。
- OAuth を開始しても token は消費されない。
- credential POST または OAuth callback 完了時に token が消費される。
- 同じ platform user が新しい login token を作成すると、古い login token は無効になる。

追加保護：

- Credential POST routes は `Content-Type: application/json` を要求する。
- `LINK_URL` / `MIKAN_LINK_URL` が設定されている場合、credential POST routes は same-origin の `Origin` または `Referer` を確認する。
- OAuth state は login token から独立し、TTL は 10 分で、PKCE verifier を使う。
- Secret values はブラウザーへ再 render されない。既存 vault summaries は secret names と mount targets だけを表示する。

### Session view

Session view は session content access です。主な用途は structured session timeline の閲覧です。

Session view でできること：

- session timeline を render する。
- parent/thread session relationships をたどる。
- SSE 経由で live status と timeline updates を購読する。
- interactive wiring が利用できる場合、Web から選択中の session へメッセージを送る。

Session view は純粋な read-only ではありません。`/session/message` route が存在し、interactive wiring が利用できる場合、session view token は `session_view` event を送信して bot handler を呼び出せます。

Session view token は base session file に固定されます。`/session?session=<file.jsonl>` で移動する場合、同じディレクトリ内の session files にだけ切り替えられます。

## Route と token の対応

| Route                | Method | Token ソース      | 検証方法                                 | 備考                                                  |
| -------------------- | ------ | ----------------- | ---------------------------------------- | ----------------------------------------------------- |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                 | Admin portal を render。                              |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                 | 未認可なら 403。                                      |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                 | 未認可なら 403。                                      |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                  | login/vault page を render；token は消費しない。      |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`               | credentials を書き込み；token を消費。                |
| `/api/oauth/start`   | `POST` | JSON body `token` | `linkTokenStore.peek()` + OAuth state    | OAuth redirect を作成；login token はまだ消費しない。 |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + `linkTokenStore.consume()` | OAuth 完了；OAuth state と login token を消費。       |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | session page を render。                              |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | SSE stream を開く；interactive wiring が必要。        |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`           | session message を送信；interactive wiring が必要。   |

## なぜ同じ token を使わないのか

この 3 種類の token はリスクが異なります。

- Admin token：再利用可能な短期管理権限。
- Login token：secrets を書き込めるため寿命がより短く、書き込み時に消費される。
- Session view token：session の共有と見返しを簡単にするため有効期間は長めだが、権限は session view の範囲に限定される。

将来 full dashboard を追加しても、これらの境界は維持すべきです。

- Dashboard identity は閲覧と設定操作を認可できる。
- Secret writes には、短命の一回限り capability、または同等の二次確認を要求し続けるべき。
- Standalone session links は、session viewing 用の capability links として引き続き使える。

## 実装場所

| 機能                 | 主要コード                                                        |
| -------------------- | ----------------------------------------------------------------- |
| Portal HTTP server   | `src/web/login/portal.ts` の `startLinkServer()`                  |
| Admin portal         | `src/web/admin/portal.ts`、`src/web/admin/store.ts`               |
| Login / vault portal | `src/web/login/portal.ts`、`src/web/login/store.ts`               |
| Session view         | `src/web/session-view/portal.ts`、`src/web/session-view/store.ts` |
| 共通 token store     | `src/web/token-store.ts`                                          |
| 共通 portal shell    | `src/portal-shell.ts`                                             |

`startLinkServer()` の dispatch 順序：

1. `GET /health`
2. Admin routes
3. Session view routes
4. Login / vault routes
5. `404`

Server は `LINK_PORT` / `MIKAN_LINK_PORT` を port として解析できる場合だけ起動します。`LINK_URL` / `MIKAN_LINK_URL` が設定され、port が設定されていない場合、mikan は既定 port `8181` を使います。

Token stores は現在すべて in-memory で、`src/main.ts` により 5 分ごとに期限切れ token が削除されます。Process を再起動すると、まだ期限切れでない web tokens もすべて無効になります。
