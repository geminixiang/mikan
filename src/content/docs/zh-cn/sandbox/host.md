---
title: Host sandbox
description: 直接在宿主机执行 commands，适合本地开发与不注入 vault env 的场景。
---

```bash
mikan --sandbox=host /path/to/workspace
```

特性：

- commands 直接在宿主机执行
- 不注入 vault env
- `/login` 仍可把 credential 存进 `state-dir/vaults`

适合：

- 本地开发
- 不希望 mikan 把 vault credential 放进 host command process
