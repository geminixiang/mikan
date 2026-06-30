---
title: スキル
description: workspace-level と conversation-level skills の読み込み場所、sandbox path、tool 構造。
---

| レベル                             | 用途                                                     | Host path                                                  | Sandbox 内 runtime path                                   |
| ---------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Workspace-level（global skills）   | workspace 全体のすべての conversations で使える共有 tool | `<workspace>/.mikan/skills/<skill-name>/`                  | `/workspace/.mikan/skills/<skill-name>/`                  |
| Conversation-level（local skills） | 単一の conversation / channel / DM だけで使う tool       | `<workspace>/<conversationId>/.mikan/skills/<skill-name>/` | `/workspace/<conversationId>/.mikan/skills/<skill-name>/` |

:::note
mikan は workspace-level skills を先に読み込み、その後 conversation-level skills を読み込みます。両方に同じ `name` がある場合、conversation-level skill が workspace-level skill を上書きします。
:::

## ディレクトリ構造

```text
<workspace>/
├── .mikan/skills/
│   └── my-global-tool/
│       ├── SKILL.md
│       └── run.sh
└── <conversationId>/
    └── .mikan/skills/
        └── my-local-tool/
            ├── SKILL.md
            └── run.sh
```

各 skill ディレクトリには `SKILL.md` が必要です：

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` と `description` は必須です。skill ディレクトリ内のファイルを説明で参照する場合は `{baseDir}` を使ってください。mikan がその skill の runtime path に置き換えます。

## どちらのレベルを使うべきか

Workspace-level skills は共有 tool に適しています：会社 API、よく使う scripts、release helpers、reporting tools、または複数 conversations で使う能力。

Conversation-level skills はローカル tool に適しています：特定 channel workflow、一時的な helper、または他の conversations に出すべきではない tool。
