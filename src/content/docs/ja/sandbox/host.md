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
- `/pi-login` は引き続き credential を `~/.mikan/vaults` に、プラットフォームの user を key として保存できます。env エントリは単に使われないだけですが、その vault に _file_ credential があると実行は `Sandbox type "host" does not support vault file mounts` で失敗します
- bash command は mikan プロセス自身の working directory から開始します

## Private office は強制されません

`host` は private office の visibility（ADR 0008）を強制できません。mount する先が存在せず、tools は
host user が見えるもの（他の private office や共有の `MEMORY.md`、`skills/` を含む）をそのまま見ます。
mikan はそれらの conversation も実行し、office ごとに一度だけ次のログを記録します：

```text
Sandbox 'host' cannot enforce private office visibility for <office-key>
```

platform による導出により、これは DM、Slack private channel、外部共有および種別不明の conversation、
そしてすべての Telegram・Discord・GitHub の conversation に当てはまります。`/pi-sandbox` チャットコマンドは
host mode では利用できません。管理型の `image:*` sandbox 専用です。

適している用途：

- workspace 全体を任せられる、すでに信頼しているマシンでのローカル開発
- mikan に vault credential を host command process へ渡してほしくない場合

共有環境やマルチテナントのデプロイには適していません。host mode では、すべての conversation が mikan
自身と同じファイルシステムとプロセスの視界を持ちます。そうした環境では代わりに
[`image:<image>`](/ja/sandbox/image/) を使用してください。
