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
- `/login` は引き続き credential を `state-dir/vaults` に保存できます

適している用途：

- ローカル開発
- mikan に vault credential を host command process へ渡してほしくない場合
