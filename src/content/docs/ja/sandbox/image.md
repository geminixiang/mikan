---
title: Image sandbox
description: mikan 管理の per-conversation Docker container と vault 分離を使用します。
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

image を自分でカスタマイズしたい場合は、ローカルで build することもできます：

```bash
docker build -f docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

特徴：

- mikan は conversation ごとに独立した vault と container を作成します
- 各 container は専用の Docker bridge network に接続され、デフォルトでは互いに分離されます
- managed container 作成時は `--cap-drop=ALL`、`--security-opt=no-new-privileges`、`--pids-limit=1024` を付けます
- container 内から見えるのは `/workspace/MEMORY.md`、`/workspace/.mikan/skills`、`/workspace/events`、現在の conversation directory だけです
- vault env は実行時に注入されます
- vault file credential は target path に従って自動で container へ bind mount されます
- idle container は自動的に stop され、次に必要になったとき start または recreate されます

vault key の選択ロジック：

1. conversation ID をそのまま vault key として使います。例：`d123`
2. その conversation の credentials / mounts / env はすべてこの vault に書き込まれます
3. 対応する managed container も同じ key を使います。例：`mikan-sandbox-d123`

適している用途：

- 複数ユーザーで 1 つの mikan instance を共有する場合
- per-conversation の env/file credential isolation が必要な場合
- shared container より安全にしたいが、Firecracker までは使いたくない場合

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
- `/pi-sandbox` は現在の conversation の有効な制限を表示します
- `/pi-sandbox boost` は現在の conversation を一時的に `sandbox.boost` のスペックへ引き上げます。boost 状態は container に紐づき、container stop 後に終了します
- agent は組み込みの `sandbox` tool で現在の conversation の CPU / memory limit を確認または一時設定できます。この種の override も container stop 後に消去されます
