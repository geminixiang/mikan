---
title: Host sandbox
---

# Host sandbox

```bash
mikan --sandbox=host /path/to/workspace
```

特性：

- commands 直接在宿主機執行
- 不注入 vault env
- `/login` 仍可把 credential 存進 `state-dir/vaults`

適合：

- 本機開發
- 不希望 mikan 把 vault credential 放進 host command process
