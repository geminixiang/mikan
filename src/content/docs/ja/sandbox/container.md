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

## Vault key

vault key は container 名から導出されます。可読な prefix にその名前の短い digest を付けたもので、
`--sandbox=container:mikan-tools` は `~/.mikan/vaults/mikan-tools-<digest>/` を使用します。`/pi-login`
が認証情報を書き込むとき、mikan が正確な directory を生成します。digest 導入前に書かれた vault
directory（`container-<name>`）も引き続き読み取られます。

いずれの場合も意味は **one container one vault** です：

- container ごとに別の vault があります
- 複数ユーザーが同じ container を共有すると、同じ container vault を共有します

conversation スコープのモードとは異なり、この key は conversation に依存しません。したがって container
vault は conversation ごとの認証情報の境界ではありません。

## Door policy

`container:*` は conversation スコープの workspace projection を強制できません。`docker exec` は
mikan が作成していない container に mount を追加できないためです。そのため、既定の `isolated`
door policy では実行を拒否します。グローバルな `settings.json` または admin portal で trusted な policy
を明示的に選び（`/pi-sandbox` チャットコマンドは管理型 sandbox 専用です）、container を作成する際に
workspace は自分で mount してください。

## 制限

- mikan は `docker exec` 時にのみ env を注入します
- `docker exec` では bind mount を追加できないため、**file credential は無視されるのではなく拒否されます**。この container の vault に `env` 以外のファイルが 1 つでもあると、実行は `Sandbox type "container" does not support vault file mounts` で失敗します。ここでは認証情報を `env` に留めてください
- mikan はこの container の lifecycle、リソース制限、`/pi-sandbox boost` を管理しません
