---
title: Telegram 适配器
description: 配置 BotFather 隐私、long polling、回复范围会话、命令、文件和 HTML 回复。
---

## 设置

1. 使用 [@BotFather](https://t.me/BotFather) 创建 bot 并复制其 token。
2. 决定 bot 是否必须接收普通群组消息。BotFather 隐私模式通常将群组投递限制为命令、提及和对 bot 的回复。只有群组范围的自动回复规则需要更广泛的输入时，才使用 `/setprivacy` 禁用隐私模式。
3. 将 bot 添加到每个群组，并只授予读取和发送消息或文件所需的群组/管理员权限。
4. 设置 token 并启动 mikan：

```bash
export TELEGRAM_BOT_TOKEN="..."
mikan /path/to/workspace
```

mikan 使用 long polling；不需要公开 Telegram webhook。

## 事件来源和触发方式

适配器处理：

- 私聊、群组和超级群组消息
- `/login`、`/session`、`/new`、`/stop`、`/model` 和 `/sandbox`
- 回复、照片和文档

私聊消息会直接触发。群组消息需要命令、提及、回复上下文或匹配的自动回复策略。Telegram 必须先将消息投递给 bot；隐私模式可能会阻止自动回复规则看到普通群组流量。

## 会话规则

Telegram 没有 Slack 风格的 `thread_ts`。mikan 根据直接回复关系推导范围：

| 场景               | 会话身份                         |
| ------------------ | -------------------------------- |
| 私聊               | chat ID                          |
| 触发的群组顶层消息 | `<chatId>:<messageId>`           |
| 回复               | `<chatId>:<referencedMessageId>` |

因此，嵌套回复会跟随所引用的消息 ID，而不是平台提供的持久话题根。Telegram 论坛话题 `message_thread_id` 目前不是单独记录的会话维度。

## 回复和附件

回复使用 Telegram HTML 模式。支持的格式包括 `<b>`、`<i>`、`<code>`、`<pre>` 和 `<a href="...">`。如果 Telegram 拒绝生成的 markup，mikan 会使用转义后的 HTML 重试。Responder 还支持输入状态、消息编辑、回复目标和文件上传。

入站照片和文档通过 Telegram 文件 API 下载到对话的 `attachments/` 目录。语音、音频、视频、贴纸和 poll 等其他媒体类型不会作为等效入站附件处理。

## 停止行为

`/stop` 和文本 `stop` 会在正常触发判断前处理。mikan 首先以当前限定范围的会话为目标；在群组中，如果只有一个当前运行的限定范围会话，也可以明确回退到该会话。
