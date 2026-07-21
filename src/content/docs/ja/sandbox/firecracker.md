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
- vault 選択では、conversation ID を lowercase にし、英数字以外の連続部分を `-` に置換して正規化します。一致する vault が存在しない場合、env は注入されません

起動時の検証では host の `PATH` に `fc-agent` または `firecracker` があることを要求し、設定された host path を確認します。VM status の確認は best-effort で、warning のみとなる場合があります。

制限：

- SSH は `StrictHostKeyChecking=no` を使用します。初回接続時に host identity が検証されないため、VM network を保護してください
- VM lifecycle は自分で管理します
- workspace mount は自分で管理します
- vault file credential は保存されますが、現時点では VM 内の target path へ自動投影されません
