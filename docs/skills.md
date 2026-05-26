# Skills

mikan loads custom CLI tools from workspace-level or conversation-level `skills/` directories.

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

Use workspace-level skills for reusable tools across conversations, and conversation-level skills for channel-specific tools.
