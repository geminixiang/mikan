---
title: Container sandbox
description: 既存の Docker container で mikan commands を実行し、container 名で vault を割り当てます。
---

```bash
docker run -d --name mikan-tools \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

mikan --sandbox=container:mikan-tools /path/to/workspace
```

特徴：

- mikan は `docker exec` で既存 container 内に command を実行します
- container 内の workspace は `/workspace` を想定しています
- container 作成時は `--cap-drop=ALL`、`--security-opt=no-new-privileges`、`--pids-limit=1024` を付け、container 内プロセスの追加権限取得を防ぎ、runaway process を制限することを推奨します
- vault key は次の形式です：

```text
container-<name>
```

例：

```bash
--sandbox=container:mikan-tools
```

次を使用します：

```text
~/.mikan/vaults/container-mikan-tools/
```

これは **one container one vault** です：

- container ごとに別の vault があります
- 複数ユーザーが同じ container を共有すると、同じ container vault を共有します

制限：

- mikan は `docker exec` 時にのみ env を注入します
- `docker exec` では bind mount を追加できません
- vault file credential は保存されますが、現時点では container 内の target path へ自動投影されません
