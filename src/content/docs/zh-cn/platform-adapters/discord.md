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

## 会话规则

mikan 使用 `resolveChatSessionKey()` 隔离共享对话：

| 场景             | 对话/会话身份                                                   |
| ---------------- | --------------------------------------------------------------- |
| DM               | 对话和会话都使用 DM 频道 ID                                     |
| Guild 顶层消息   | 对话使用频道 ID；触发的消息按消息 ID 限定范围                   |
| Discord 话题频道 | 对话使用父频道 ID；会话为 `<parentChannelId>:<threadChannelId>` |
| 共享频道中的回复 | 会话范围根据引用/根消息 ID 确定                                 |
| Slash command    | 根据 interaction 的频道/话题上下文解析                          |

这可防止不相关的 guild 消息和话题共享代理上下文。

## 回复和附件

Responder 支持 Discord Markdown、输入指示器、初始回复、增量消息编辑、回复目标、reaction 和文件上传。长输出以 1,900 个字符为目标拆分，保持低于 Discord 的消息限制。

入站附件会先使用经过清理的文件名下载到对话的 `attachments/` 目录，然后事件才会到达运行时。

Guild slash-command acknowledgement 通常是 ephemeral；DM 命令直接回复。

## 当前边界

mikan 不会将语音、embed、component、poll 或所有 Discord 媒体/事件类型视为代理输入。话题/频道可见性受 app 安装和频道权限限制。
