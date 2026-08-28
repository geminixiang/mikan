---
title: スキル
description: workspace-level と conversation-level skills の読み込み場所、sandbox path、tool 構造。
---

| レベル                             | 用途                                                     | Host path                                       | Sandbox 内 runtime path                          |
| ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Workspace-level（global skills）   | workspace 全体のすべての conversations で使える共有 tool | `<workspace>/skills/<skill-name>/`              | `/workspace/skills/<skill-name>/`                |
| Conversation-level（local skills） | 単一の conversation / channel / DM だけで使う tool       | `<workspace>/<office-key>/skills/<skill-name>/` | `/workspace/<office-key>/skills/<skill-name>/`   |
| Package skills                     | インストール済み package が同梱する skills               | state dir 配下の git checkout                   | `/mikan/packages/<slug>/skills/`（読み取り専用） |

office key は、mikan が各 conversation に対して導出する `v1-<platform>-<readable-id>-<hash>` という
directory 名です。手で組み立てるものではありません。admin portal の skills view は両方のレベルを
一覧表示し、どちらにも skill を作成できます。

:::note
mikan は workspace-level skills を先に読み込み、その後 conversation-level skills を読み込みます。両方に同じ `name` がある場合、conversation-level skill が workspace-level skill を上書きします。
:::

:::caution[Workspace-level skills には trusted な door が必要です]
`isolated` door policy では、conversation は自分の office しか見えないため、workspace-level
skills は mount されず、agent にも提示されません。prompt は代わりに自分の office 内に skills を
置くよう指示します。DM・external channel・unknown platform visibility は、admin の明示的な上書きがなければこの policy を導出します。workspace-level skills には trusted な `shared-support` または `full` layout が
必要です。[Sandbox](/ja/sandbox/) を参照してください。
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

Workspace-level skills は共有 tool に適しています：会社 API、よく使う scripts、release helpers、reporting tools、または複数 conversations で使う能力。これらには trusted な door policy が必要です。

Conversation-level skills はローカル tool に適しています：特定 channel workflow、一時的な helper、または他の conversations に出すべきではない tool。これらはどの door policy でも動作し、isolated な office が書き込める唯一のレベルです。

Package skills は、複数のインストールに skill セットを配布するためのものです。これらは `/workspace` の外に読み取り専用で mount されます。ホストがそれらのファイルを所有しているからです。その directory は git checkout であり、更新のたびにまるごと置き換えられるため、agent による編集は次の refresh で破棄されてしまいます。そうなる代わりに、ファイルシステムが書き込みを拒否します。
