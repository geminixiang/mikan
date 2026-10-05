---
title: スキル
description: workspace-level と conversation-level skills の読み込み場所、sandbox path、tool 構造。
---

| レベル                             | 用途                                                     | Host path                                       | Sandbox 内 runtime path                        |
| ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Workspace-level（global skills）   | workspace 全体のすべての conversations で使える共有 tool | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`              |
| Conversation-level（local skills） | 単一の conversation / channel / DM だけで使う tool       | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/` |

office key は、mikan が各 conversation に対して導出する `v1-<platform>-<readable-id>-<hash>` という
directory 名です。手で組み立てるものではありません。admin portal の skills view は、入れ子の skill
directory を含めて両方のレベルを一覧表示し、どちらにも skill を作成でき、skill を有効・無効に切り替えられます。

:::note
mikan は workspace-level skills を先に読み込み、その後 conversation-level skills を読み込みます。両方に同じ `name` がある場合、conversation-level skill が workspace-level skill を上書きします。
:::

:::note[Private office は workspace-level skills を読み取ります]
すべての conversation が workspace-level skills を一覧表示し、読み取れます。private office（private
channel、DM、または Slack 以外の conversation）は `/workspace/skills/` を read-only で mount するため、
それらの skills を使えますが、自分の skill は自分の office 内に作成します。[Sandbox](/ja/sandbox/) を参照してください。
:::

## ディレクトリ構造

```text
<workspace>/
├── skills/
│   └── my-global-tool/
│       ├── SKILL.md
│       └── run.sh
└── v1-slack-c0123456789-<digest>/
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

Workspace-level skills は共有 tool に適しています：会社 API、よく使う scripts、release helpers、reporting tools、または複数 conversations で使う能力。書き込めるのは public office だけです。

Conversation-level skills はローカル tool に適しています：特定 channel workflow、一時的な helper、または他の conversations に出すべきではない tool。すべての office が書き込め、private office が書き込める唯一のレベルです。

## Skill を無効にする

すべての skill は既定で system prompt に列挙されます。global または conversation 設定の `skills` は Pi の
resource ルールで skill を除外し、admin portal の Skills ページでは workspace ごと、conversation ごとに切り替えられます。
[設定](/ja/configuration/#skills) を参照してください。除外された skill は prompt から外されるだけで、その files は sandbox 内で
引き続き読み取れます。
