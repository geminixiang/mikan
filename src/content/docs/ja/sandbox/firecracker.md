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
- 認証情報は office key で索かれます。これは `image:*` が使うのと同じ conversation スコープの vault key です。一致する vault が存在しない場合、env は注入されません

起動時の検証では host の `PATH` に `fc-agent` または `firecracker` があることを要求し、設定された host path を確認します。VM status の確認は best-effort で、warning のみとなる場合があります。

制限：

- mikan は自分が管理していない VM 内で workspace projection を強制できないため、既定の `isolated` door policy では実行を拒否します。trusted な policy を明示的に選ぶ必要があります
- SSH は `StrictHostKeyChecking=no` を使用します。初回接続時に host identity が検証されないため、VM network を保護してください
- VM lifecycle は自分で管理します
- workspace mount は自分で管理します
- file credential は無視されるのではなく拒否されます。conversation の vault に `env` 以外のファイルが 1 つでもあると、実行は `Sandbox type "firecracker" does not support vault file mounts` で失敗します。ここでは認証情報を `env` に留めてください
- リソース制限、idle stop、`/pi-sandbox boost` は適用されません
