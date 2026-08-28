---
title: Cloudflare sandbox
description: 自分でデプロイした Cloudflare Worker bridge を使い、構築中の Cloudflare sandbox を実行します。
---

:::caution[構築中]
Cloudflare モードは mikan の sandbox 設定には存在しますが、完成したデプロイ先ではありません。管理された
workspace projection も、file credential の投影も、lifecycle やリソース管理もありません。isolated
projection や read-only shared memory を強制できないため、先に trusted read-write policy を明示的に
設定する必要があります。将来は外部委託の実行面として戻ってくる想定です。実運用には
[`image:<image>`](/ja/sandbox/image/) を使用してください。
:::

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特徴：

- runtime commands は `/workspace` を使用します
- mikan は remote sandbox id を `<base-sandbox-id>-<resource-key>` に派生させるため、各 conversation は bridge 上で自分の sandbox を指します
- vault env は各 `exec()` 時に bridge 経由で注入されます
- 認証情報は office key で索かれます。これは `image:*` が使うのと同じ conversation スコープの vault key です

制限：

- mikan はここでは isolated workspace projection や read-only shared memory を強制できません。trusted read-write policy を明示的に選ぶ必要があります
- リモートの `/workspace` はローカル作業ディレクトリを自動 mirror しません
- そのため `pwd` は `/workspace` を表示しますが、`ls` は空かもしれません。これは想定どおりで、ローカル repo を読んでいるわけではありません
- file credential は無視されるのではなく拒否されます。conversation の vault に `env` 以外のファイルが 1 つでもあると、実行は `Sandbox type "cloudflare" does not support vault file mounts` で失敗します。ここでは認証情報を `env` に留めてください
- container lifecycle、idle stop、リソース制限、`/pi-sandbox boost` は適用されません
- bridge Worker と対応する container image を自分でデプロイする必要があります

サンプル bridge をそのまま使用できます：

- [GitHub の Cloudflare sandbox bridge サンプル](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
