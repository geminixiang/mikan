---
title: Host sandbox
description: ホストマシン上で直接 commands を実行します。ローカル開発や vault env を注入しない場面に適しています。
---

```bash
mikan --sandbox=host /path/to/workspace
```

特徴：

- commands はホストマシン上で直接実行されます
- vault env は注入されません
- `/pi-login` は引き続き credential を `state-dir/vaults` に、プラットフォームの user を key として保存できます。env エントリは単に使われないだけですが、その vault に _file_ credential があると実行は `Sandbox type "host" does not support vault file mounts` で失敗します
- bash command は mikan プロセス自身の working directory から開始します

## Door policy の要件

`host` は conversation スコープの workspace projection を強制できません。mount する先が存在せず、
tools は host user が見えるものをそのまま見ます。そのため mikan は、office の door policy が
`isolated`（これが既定です）の場合、次のように実行を拒否します：

```text
Sandbox 'host' cannot provide an isolated conversation office; use image:* or gondolin:default,
or explicitly choose trusted workspace policy
```

host mode を使うには、trusted な policy を明示的に選びます。グローバルには
`<state-dir>/settings.json` で：

```json
{
  "sandbox": {
    "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
  }
}
```

conversation ごとに設定するなら admin portal からです。`/pi-sandbox` チャットコマンドは host mode
では利用できません。管理型の `image:*` と `gondolin:*` sandbox 専用です。

適している用途：

- workspace 全体を任せられる、すでに信頼しているマシンでのローカル開発
- mikan に vault credential を host command process へ渡してほしくない場合

共有環境やマルチテナントのデプロイには適していません。host mode では、すべての conversation が mikan
自身と同じファイルシステムとプロセスの視界を持ちます。そうした環境では代わりに
[`image:<image>`](/ja/sandbox/image/) を使用してください。
