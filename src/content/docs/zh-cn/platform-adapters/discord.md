---
title: Discord 适配器
description: 配置 Discord gateway intents、权限、会话、命令、附件和回复行为。
---

## 设置

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 中创建 application 和 bot。
2. 在 **Bot → Privileged Gateway Intents** 下启用 **Message Content Intent**。mikan 会请求此 intent；没有它就无法检查普通消息文本。
3. 使用 `bot` 和 `applications.commands` scopes 安装 app。
4. 根据 bot 要服务的频道授予所需访问权限：View Channels、Send Messages、Read Message History、Add Reactions、Attach Files、Embed Links 和 Send Messages in Threads。
5. 设置 token 并启动 mikan：

```bash
export DISCORD_BOT_TOKEN="..."
mikan /path/to/workspace
```

频道权限覆盖仍然适用。成功安装并不保证能够访问每个 guild 频道或私有话题。

## 事件来源和触发方式

适配器处理：

- DM、guild 频道和 Discord 话题频道中的 `messageCreate`
- slash commands：`login`、`session`、`new`、`stop`、`model` 和 `sandbox`
- 消息附件

DM 会直接触发。Guild 消息通常需要提及、mikan 所处理的回复/话题上下文，或匹配的自动回复策略。停止命令会在正常触发 gate 之前检查。

## Slash command 注册

该适配器不维护自己的命令清单。连接时，它会通过 `application.commands.set()` 注册 `src/commands/manifest.ts` 中每一条标记为 Discord 的条目，命令名、描述和可选的字符串参数都直接取自该条目。因此添加命令意味着添加一条 manifest 条目，而不是修改适配器。

如果命令或选项描述超过 100 个字符，Discord 会拒绝该次注册，并且整个 `set()` 调用都会失败——这会让该 guild 的命令列表一直停留在旧状态，直到下次重启，且不会有任何提示。一项单元测试会对每条 manifest 描述强制执行 100 字符预算，让这类失败改为在测试时暴露。

## 会话规则

mikan 使用 `resolveChatSessionKey()` 隔离共享对话。Discord 传入 `persistentTopLevel: true`，因此频道的顶层对话保持一个持久会话，而不是为每条触发消息分叉出新会话：

| 场景               | 对话 id    | 会话密钥                              |
| ------------------ | ---------- | ------------------------------------- |
| DM                 | DM 频道 ID | 同一个 DM 频道 ID                     |
| Guild 顶层消息     | 频道 ID    | 同一个频道 ID                         |
| Discord 话题频道   | 父频道 ID  | `<parentChannelId>:<threadChannelId>` |
| Guild 频道中的回复 | 频道 ID    | `<channelId>:<referencedMessageId>`   |
| Slash command      | 同上       | 根据 interaction 的上下文解析         |

因此话题和回复会分叉出各自的会话，而普通的频道闲聊则延续该频道的持久会话。回复的范围限定在它直接引用的那条消息上，而不是 Discord 对普通频道回复并不提供的话题根。DM 回复是例外：DM 本身已经是私密对话，因此它保持在裸频道密钥上，不会按回复分叉。

## 回复和附件

Responder 支持 Discord Markdown、输入指示器、初始回复、增量消息编辑、回复目标、reaction 和文件上传。长输出以 1,900 个字符为目标拆分，保持低于 Discord 的消息限制。

入站附件会先以 `<timestamp>_<sanitized-name>` 的形式下载到该对话办公室的 `attachments/` 目录，然后事件才会到达运行时；使用的是与其他适配器相同的共享辅助函数。

Guild slash-command acknowledgement 通常是 ephemeral；DM 命令直接回复。

## 当前边界

mikan 不会将语音、embed、component、poll 或所有 Discord 媒体/事件类型视为代理输入。话题/频道可见性受 app 安装和频道权限限制。
