---
title: Image sandbox
description: mikan 管理の per-conversation Docker container と vault 分離を使用します。
---

```bash
# Pull the prebuilt image from GHCR
# Only mikan releases publish the image: :<version>, :latest, :tools, and :beta for prereleases
docker pull ghcr.io/geminixiang/mikan-sandbox:latest

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest /path/to/workspace
```

image を自分でカスタマイズしたい場合は、ローカルで build することもできます：

```bash
docker build -f deploy/docker/mikan-sandbox.Dockerfile -t mikan-sandbox:latest .
mikan --sandbox=image:mikan-sandbox:latest /path/to/workspace
```

特徴：

- 標準 tool image には Node.js 24、Chromium、CJK フォント、ffmpeg、および `jev_browser` が使用する固定版 `agent-browser` 0.38.1 runtime が含まれます
- image のツールは `/root` ではなく `/usr/local` と `/opt` にインストールされます。sandbox 内での `npm i -g`、`uv tool install` は `PATH` 上の `/root/.local` に入ります。Python パッケージは uv で管理します（`uv run --with <パッケージ>`）。システムの pip はインストールを拒否します
- mikan は conversation ごとに独立した vault と container を作成します
- 各 container は専用の Docker bridge network に接続され、container 間の直接通信が分離されます。outbound network access は引き続き有効です
- managed container 作成時は `--cap-drop=ALL`、`--security-opt=no-new-privileges`、`--pids-limit=1024` を付けます
- container 内の workspace mount は office の visibility（ADR 0008）に従います。public office は共有の `MEMORY.md` と `skills/` に書き込み、private office はそれらを読み取るだけで、どの office も別の private office には到達できません
- vault env は実行時に注入されます
- vault file credential は、各ファイル名から推定される target に従って自動で container へ bind mount されます（[Vault](/ja/sandbox/vault/) を参照）
- idle containers は 10 分ごとに確認され、少なくとも 10 分間利用がないと停止します。scan timing により、最後に追跡された利用から約 10〜20 分後に停止します

## サンドボックスイメージの更新

管理下の container は使い捨てです。bind mount（conversation office、共有 knowledge、vault file）だけが残り、`/root`、インストールしたパッケージ、`/etc` の変更など container 内のそれ以外の場所に書いたものは、container が置き換えられると消えます。残したいものは workspace に置いてください。

1. mikan が使う tag で新しいイメージを host に pull します（`docker pull …:latest`）。mikan が自分で pull することはありません。rollback に備えて以前の image ID を残しておきます。
2. 実行中の container が中断されることはありません。idle で停止した container は、次のメッセージで新しいイメージから置き換えられます（`docker rm` + `docker run`）。

Rollback: 以前の image ID を tag し直し、container をもう一度置き換えさせます。

## Mount と conversation office

conversation の office directory は `/workspace/<office-key>` に読み書き可能で bind mount されます。
office key は、host 上でもその directory を命名する `v1-<platform>-<readable-id>-<hash>` セグメント
です。すべての office は workspace 全体の `MEMORY.md` と `skills/`（public office では読み書き可能、
private office では read-only）と、他のすべての public office を `/workspace/public/<office-key>` 配下に
read-only で受け取ります。workspace root 全体を mount するものはなく、スケジュールされた event は host
専用のままです。

mount が変わると（たとえば visibility の変更後）、次のメッセージで container が現在のイメージから置き換えられます。

## Vault key と container key

認証情報は **office key** で索かれます。ある conversation の vault directory は `~/.mikan/vaults/<office-key>/` です。この key は platform 名とプラットフォームの生の conversation id を一緒に hash して導出されるため、たまたま同じ生 id を使う 2 つのプラットフォームが互いの認証情報を解決することは決してありません。`mikan migrate` が、生の conversation id を使っていた 0.5.3 の vault directory を office key へ rename します。

管理下の container 名は `mikan-sandbox-<office-key>`、その network は `mikan-sandbox-net-<office-key>` です。

適している用途：

- 複数ユーザーで 1 つの mikan instance を共有する場合
- per-conversation の env/file credential isolation が必要な場合

## コンテナリソース制限

`settings.json` で managed container ごとの CPU とメモリ上限を設定できます：

```json
{
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    }
  }
}
```

| フィールド             | 説明                                           | 例               |
| ---------------------- | ---------------------------------------------- | ---------------- |
| `sandbox.cpus`         | CPU コア数上限（浮動小数字列）                 | `"0.5"`, `"2"`   |
| `sandbox.memory`       | メモリ上限（Docker memory 形式）               | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | `/pi-sandbox boost` が一時適用する CPU 上限    | `"2"`, `"4"`     |
| `sandbox.boost.memory` | `/pi-sandbox boost` が一時適用する memory 上限 | `"4g"`, `"8g"`   |

- 新しい container 作成時、制限は `docker run` 引数へ直接追加されます
- 実行中の container は次回 provision 時に `docker update` で新しい制限が即時適用され、再作成は不要です
- `/pi-sandbox` は現在の conversation の有効な制限に加えて、その office visibility を表示します
- `/pi-sandbox boost` は現在の conversation を一時的に `sandbox.boost` のスペックへ引き上げます。boost 状態は container に紐づき、container stop 後に終了します
- `/pi-sandbox visibility <private|default>` は public channel を private office に狭めるか、その上書きを解除します。container は次のメッセージで新しい mount とともに再作成され、workspace と vault のファイルは保持されます
- agent は組み込みの `sandbox` tool で現在の conversation の CPU / memory limit を確認または一時設定できます。この種の override も container stop 後に消去されます
