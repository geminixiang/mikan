---
title: スキル
description: workspace-level と conversation-level skills の読み込み場所、sandbox path、tool 構造。
---

| レベル                             | 用途                                                     | Host path                                           | Sandbox 内 runtime path                            |
| ---------------------------------- | -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Workspace-level（global skills）   | workspace 全体のすべての conversations で使える共有 tool | `<workspace>/skills/<skill-name>/`                  | `/workspace/skills/<skill-name>/`                  |
| Conversation-level（local skills） | 単一の conversation / channel / DM だけで使う tool       | `<workspace>/<conversationId>/skills/<skill-name>/` | `/workspace/<conversationId>/skills/<skill-name>/` |

:::note
mikan は workspace-level skills を先に読み込み、その後 conversation-level skills を読み込みます。両方に同じ `name` がある場合、conversation-level skill が workspace-level skill を上書きします。
:::

## ディレクトリ構造

```text
<workspace>/
├── skills/
│   └── my-global-tool/
│       ├── SKILL.md
│       └── run.sh
└── <conversationId>/
    └── skills/
        └── my-local-tool/
            ├── SKILL.md
            └── run.sh
```

`SKILL.md` を含むディレクトリは 1 つの skill root として扱われ、再帰的には検索されません。mikan は設定された skills directory の直下にある単独の `.md` files も検出します。

ディレクトリ形式の skill は `SKILL.md` を使います：

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

`name` と `description` は必須です。skill directory からの相対 path、または上の表に示した runtime から見える絶対 path を使ってください。`{baseDir}` は自動展開されません。

## どちらのレベルを使うべきか

Workspace-level skills は共有 tool に適しています：会社 API、よく使う scripts、release helpers、reporting tools、または複数 conversations で使う能力。

Conversation-level skills はローカル tool に適しています：特定 channel workflow、一時的な helper、または他の conversations に出すべきではない tool。
