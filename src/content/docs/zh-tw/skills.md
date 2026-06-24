---
title: 技能
---

# 技能

mikan 會從 workspace-level 或 conversation-level 的 `skills/` 目錄載入自訂 CLI tools。

```text
skills/my-tool/
├── SKILL.md      # name + description frontmatter, usage docs
└── run.sh
```

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

可跨對話重複使用的 tools 請放在 workspace-level skills；頻道專用 tools 則使用 conversation-level skills。
