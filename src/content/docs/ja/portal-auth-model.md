---
title: Portal の認証と capability モデル
description: Harness Web Client と独立した portal の認証・権限境界。
---

Mikan は、認証済みの完全な Web サイトと、互いに独立した 3 つの bearer-capability portal を提供します。同じ HTTP server を利用しますが、権限、ナビゲーション、frontend state は共有しません。

## 4 種類の Web 権限

| Surface             | アクセスの取得方法                                                           | 許可される操作                                                                                                                                                  | 有効期間／永続性                                                                                            |
| ------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Harness Web Client  | private chat で一度 `/login web` を実行し、`/login` から GitHub でサインイン | その GitHub principal が所有する `platform=web` Conversation office の作成・操作、transcript の閲覧、prompt、正確な run の cancel、model／thinking level の選択 | Cookie：24 時間、memory-only。完了済み admission binding：State dir の private `web-bindings.json` に永続化 |
| Admin portal        | `/admin` または `/pi-admin`                                                  | settings、models、sandbox policy、events、link 生成を含む deployment／conversation 管理                                                                         | 30 分の memory-only bearer token                                                                            |
| Login／vault portal | `/login`、`/pi-login`、または Admin が生成した link                          | API key または OAuth credential を 1 つの scoped vault に書き込む                                                                                               | 15 分の memory-only bearer token。credential の保存成功時に消費                                             |
| Session View portal | `session`、`/session`、または Admin が生成した link                          | 1 つの scoped Harness session と関連 session を表示。interactive wiring がある場合は、同じ session に message を送信                                            | 24 時間の memory-only bearer token                                                                          |

## Harness Web Client

Web サイトが所有する route は `/`、`/login`、`/conversations/:officeKey` です。Portal の外枠ではなく、daemon の完全な client です。

### Admission とログイン

1. private platform conversation で `/login web` を実行し、5 分間有効な proof code を取得します。
2. `/binding` で GitHub OAuth を完了し、不変の numeric principal を `github:<id>` として保存します。変更可能な GitHub login は表示名にのみ使用します。
3. 完了済み admission binding は `web-bindings.json` に永続化し、未完了の proof code は memory-only です。
4. 以後の GitHub login は admitted principal にのみ許可され、httpOnly、`SameSite=Lax` の `mikan_session` cookie を発行します。HTTPS response では `Secure` も付与します。

Admission に使った Slack、Discord、Telegram、GitHub office は Web サイトの authorization ではなく、Harness API から返されることもありません。既存の private conversation から OAuth principal が招待されたことだけを証明します。

### Web Conversation の所有権

Web サイト上の各 conversation は、第一級の `platform=web` Conversation office です。Raw id は random nonce と keyed owner digest から構成されます。Daemon は private `web-harness.key` と Office registry を使い、現在の principal が所有する office だけを列挙します。2 つ目の conversation inventory は作りません。Browser に返す OfficeKey の readable segment は random prefix のみで、stable owner digest や host path は含みません。

Browser mutation は daemon が発行した office key と完全な永続 Session UUID を毎回送ります。Cancel はさらに現在の run id を送るため、stale tab が置き換え後の session に書き込んだり、後続 run を停止したりできません。

### Browser protocol

| Route                    | Method      | 認証                                           | 目的                                                                                  |
| ------------------------ | ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/me`                | `GET`       | `mikan_session`                                | 現在の OAuth principal と expiry を返す                                               |
| `/api/logout`            | `POST` JSON | `mikan_session` + JSON／same-origin CSRF check | browser session を revoke し cookie を削除                                            |
| `/api/harness/bootstrap` | `GET`       | `mikan_session`                                | owned Conversation summary、選択中 transcript、models、run state、event cursor を返す |
| `/api/harness/command`   | `POST` JSON | `mikan_session` + JSON／same-origin CSRF check | Conversation 作成、prompt、正確な run の cancel、model／thinking level 変更           |
| `/api/harness/events`    | `GET` SSE   | `mikan_session`                                | epoch／sequence から principal-scoped ordered event を resume                         |

Browser は連続する event だけを一時的な live state に fold します。Sequence gap、期限切れ replay cursor、daemon restart が起きた場合は bootstrap をやり直します。Run settlement 後は streamed text を SessionStore の永続 transcript で置き換えます。

旧 `/api/offices` と cookie → Session View token bridge は削除済みです。不明な `/api/*` は SPA document ではなく JSON `404` を返します。

## Capability portals

Portal URL 自体が bearer capability です。Query token は browser history、スクリーンショット、URL のコピー、proxy log から漏れる可能性があります。意図した受信者以外には共有しないでください。

`/session`、`/admin`、`/link` prefix は static fallback より前に必ず登録され、Harness Web Client を表示しません。Website cookie を portal token として使うことも、portal token で Harness API を認証することもできません。

| Route family                                      | Token check                                  | Mutation の挙動                                                                                                  |
| ------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/admin`、`/admin/api/*`                          | `InMemoryAdminTokenStore.peek()`             | expiry まで再利用可能。Admin API は settings の変更や link の生成が可能                                          |
| `/link`、`/api/link/*`、vault-mode `/oauth/*`     | `InMemoryLinkTokenStore.peek()`／`consume()` | Credential JSON write は CSRF check が必須。保存成功時に token を消費                                            |
| `/session`、`/session/stream`、`/session/message` | `InMemorySessionViewTokenStore.peek()`       | View／SSE は再利用可能。Runtime／bot wiring がある場合だけ message を送信でき、token の session scope を超えない |
| `/binding`、`/api/binding/info`                   | 5 分間の pending binding code                | OAuth admission のみを完了し、office capability は付与しない                                                     |

## 権限を分離する理由

- Browser cookie は principal-owned Web Conversation 用の再利用可能な identity であり、operator 権限や secret-write 権限ではありません。
- Admin は deployment の挙動を変更できるため、明示的で短時間の capability のままにします。
- Login／vault link は secret を書き込めるため、成功時に one-time consume します。
- Session View link は独立して共有でき、message submission が有効でも 1 つの session に限定されます。

これらを統合すると、コピーされた session link が credential／Admin grant になったり、通常の Web login が ambient operator authority を継承したりします。

## 実装箇所

| 責任                                  | Code                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| Harness host、ownership、runs、replay | `src/web/harness/`                                          |
| Daemon／browser wire contract         | `packages/harness-web-contract/`                            |
| React-free browser runtime と UI      | `packages/web-client/`、`apps/web/`                         |
| Route ordering と static fallback     | `src/web/server.ts`、`packages/web-host/`                   |
| OAuth admission と browser sessions   | `src/web/login/portal.ts`、`binding.ts`、`session-store.ts` |
| Admin capability portal               | `src/web/admin/`                                            |
| Login／vault capability portal        | `src/web/login/`                                            |
| Session View capability portal        | `src/web/session-view/`                                     |
| 共通の短時間 token base               | `src/web/token-store.ts`                                    |

`startWebServer()` は health／webhook、Harness API、capability portal、binding route、unknown-API guard の順に登録し、最後に唯一の Vite static fallback を登録します。`LINK_PORT`／`MIKAN_LINK_PORT` が設定されると起動し、公開 link URL だけが設定されている場合は既定の `8181` を使用します。
