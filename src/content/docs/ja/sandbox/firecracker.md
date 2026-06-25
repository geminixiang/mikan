---
title: Firecracker sandbox
description: 自分で管理する Firecracker VM に SSH で入り、commands を実行して vault env を注入します。
---

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace /home/mikan/workspace
```

完全な形式：

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

例：

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace:root:22 /home/mikan/workspace
```

特徴：

- mikan は SSH で VM に入り command を実行します
- VM 内の workspace は `/workspace` を想定しています
- vault env は SSH stdin 経由で注入され、secret がホストマシンの command line に現れることを避けます
- vault 選択ロジック：
  1. conversation ID をそのまま vault key として使います（例：`d123`）
  2. vault が見つからない場合は env を注入しません

制限：

- VM lifecycle は自分で管理します
- workspace mount は自分で管理します
- vault file credential は保存されますが、現時点では VM 内の target path へ自動投影されません
