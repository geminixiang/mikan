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

- 標準 tool image には Node.js 24、Chromium、ffmpeg、および `jev_browser` が使用する固定版 `agent-browser` 0.38.1 runtime が含まれます
- image のツールは `/root` ではなく `/usr/local` と `/opt` にインストールされます。sandbox 内での `npm i -g`、`uv tool install`、`pip install --user` は `PATH` 上の `/root/.local` に入ります
- mikan は conversation ごとに独立した vault と container を作成します
- 各 container は専用の Docker bridge network に接続され、container 間の直接通信が分離されます。outbound network access は引き続き有効です
- managed container 作成時は `--cap-drop=ALL`、`--security-opt=no-new-privileges`、`--pids-limit=1024` を付けます
- container 内の workspace mount は明示的な設定または記録された Slack channel visibility に従います。public channel は shared memory を読み書きし、private channel は読み取り専用、DM・external・unknown conversation は isolated のままです
- vault env は実行時に注入されます
- vault file credential は、各ファイル名から推定される target に従って自動で container へ bind mount されます（[Vault](/ja/sandbox/vault/) を参照）
- idle containers は 10 分ごとに確認され、少なくとも 10 分間利用がないと停止します。scan timing により、最後に追跡された利用から約 10〜20 分後に停止します

## サンドボックスイメージの更新

管理コンテナはイメージと、office ごとの home volume `mikan-home-<key>`（`/root` にマウント）で構成されます。
ワークスペースのマウントと `/root`（npm/uv/pip のキャッシュ、`~/.local`、dotfiles）は更新後も残り、それ以外に
コンテナのファイルシステムへ書き込んだもの（`apt install`、`/etc` の編集、`/tmp`）は残りません。

1. mikan が使うタグで新しいイメージをホストに pull します（`docker pull …:latest`）。mikan 自身は pull しません。
   ロールバック用に旧イメージ ID を残してください。
2. home volume を持つコンテナは自動で新イメージに切り替わります。実行中のコンテナは中断されず、アイドル停止後の
   次のメッセージで同じ volume を使って `docker rm` + `docker run` で置き換えられます。
3. home volume 導入前に作られたコンテナは自動では変更されません。daemon を停止し、少しずつ確認・移行します：

```bash
mikan sandbox status --image ghcr.io/geminixiang/mikan-sandbox:latest
mikan sandbox diff <container-key> --image ghcr.io/geminixiang/mikan-sandbox:latest
mikan sandbox migrate <container-key>... --image ghcr.io/geminixiang/mikan-sandbox:latest
```

`status` は各コンテナの `legacy`/`home-volume` と `current-image`/`stale-image` を表示し、`diff` は更新で失われる
システムパスを列挙し、`migrate` は現在の `/root` で home volume を初期化してから現在のイメージで再作成します。

ロールバック：タグを旧イメージ ID に戻せば再度置き換えられ、home volume はそのまま残ります。`/login` はコンテナを
再作成しますが home volume は保持します。

## Mount と conversation office

conversation の office directory は `/workspace/<office-key>` に読み書き可能で bind mount されます。
office key は、host 上でもその directory を命名する `v1-<platform>-<readable-id>-<hash>` セグメント
です。isolated projection はこの directory だけを mount します。trusted な `shared-support` layout は
workspace 全体の `MEMORY.md`、`skills/`、`events/` を追加します。private visibility は global memory
bind を read-only にし、public visibility は read-write のままです。`trusted` / `full` は workspace root
全体を `/workspace` に mount します。

door policy を変更しても container はリセットされません。求められる mount が実行中の container と
一致しなくなると、mikan はそれを snapshot し、変換後の mount で再作成して再度起動します。そのため、
container 自身のファイルシステムにインストール・書き込みされたものは変更をまたいで保持されます。
起動時の layout migration による office directory の rename も、同じ経路でカバーされます。

## Vault key と container key

認証情報は **office key** で索かれます。ある conversation の vault directory は
`~/.mikan/vaults/<office-key>/` です。この key は platform 名とプラットフォームの生の conversation id
を一緒に hash して導出されるため、たまたま同じ生 id を使う 2 つのプラットフォームが互いの認証情報を
解決することは決してありません。古い生 id 方式で書かれた conversation の vault directory は、起動時の
migration によって office key へ rename されます。

管理下の container 名は `mikan-sandbox-<resource-key>`、その network は
`mikan-sandbox-net-<resource-key>` です。resource key は現在も生の conversation id から導出されます
（サニタイズ済みの prefix に短い digest を付けたもの）。これを rename するとプロビジョニング済みの
container がすべて作り直しになるため、別途 migration されます。そこでの衝突のコストは container の
作り直しであって、認証情報へのアクセスではありません。

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
- `/pi-sandbox` は現在の conversation の有効な制限に加えて、その door policy と layout を表示します
- `/pi-sandbox boost` は現在の conversation を一時的に `sandbox.boost` のスペックへ引き上げます。boost 状態は container に紐づき、container stop 後に終了します
- `/pi-sandbox door <default|isolated|shared|shared-private|full>` はこの office の door policy を切り替えます。container は次のメッセージで新しい mount とともに再作成され、内容は保持されます
- agent は組み込みの `sandbox` tool で現在の conversation の CPU / memory limit を確認または一時設定できます。この種の override も container stop 後に消去されます
