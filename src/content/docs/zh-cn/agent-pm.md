---
title: agent-pm
description: 使用团队运营 pipeline —— 它会带什么给你、任务怎么处理，以及你的回答如何改变它下一次的判断。
---

agent-pm 会盯着团队周边发生的事，只把**需要人来判断的**那些带到你面前。它是一个
extension：有人把它装进某个对话，之后你就用平常跟 mikan 说话的方式跟它互动。

这页是讲怎么用。如果你是负责安装的人，直接看
[给部署的人](#给部署的人)。

## 你身处的那个循环

所有发生的事 —— 一条消息、一次 repository 变更、一个整点 —— 都会被记成一条
**event**。叫做 **workflow** 的规则逐一检视每条 event，判断是否有后续动作。当某件事
需要只有人才有的判断时，workflow 会创建一条 **task** 发给你。

接着是真正关键的部分：你关闭 task 时要说明它**怎么结束的**，那个答案就是
**feedback**。这不是行政流程。把 task 关成 `no_action_needed`，等于告诉那个 workflow
它本来就不该问，而这个判断会改变它下次遇到类似 event 的行为。随手关掉的 task，教会
它的是错的东西。

## 你会看到什么

Task 会以普通消息的形式出现在拥有这条 pipeline 的对话里。没有另一个你得记得去查的
独立工具。

如果 pipeline 跑在 **test 模式**，每条消息都会被导到单一对话，并标注它**原本**要发去
哪里。那是默认值，而且是刻意的 —— 一个会通知人的 extension，距离「通知所有人、而且
通知两次」只差一个配置失误。在测试频道看到带标注的消息代表它正常运作，不是坏了。

## 处理一条 task

用你自己的话问就好。agent 有读取与关闭 task 的工具，你不需要记命令：

> 现在还有哪些没处理完？
>
> 给我看 task 12
>
> task 12 关掉，已经处理好了 —— 那次部署修掉了

关闭时请说明**实际发生了什么**。共有四种结果，而它们对创建这条 task 的 workflow 意义
各不相同：

| 结果               | 什么时候用                                      |
| ------------------ | ----------------------------------------------- |
| `resolved`         | 这条 task 提得对，而你把事情做了                |
| `no_action_needed` | task 有被提出，但实际上不需要做什么             |
| `invalid`          | 这条 task 根本不该存在 —— workflow 误读了 event |
| `superseded`       | 被别的事情取代了                                |

后两个才是有价值的。`no_action_needed` 和 `invalid` 是 workflow 得知「自己问得太频繁」
的唯一途径，它们会被记成对该 workflow 的 feedback。如果你什么都关成 `resolved`，这条
pipeline 永远不会发现它正在浪费你的注意力。

## 查看状态

```
/pm status
```

```
agent-pm — 2026-08-01 (Asia/Taipei)
delivery: test → C0EXAMPLE2
schedules owned by: this conversation
events: 5 total · 0 pending · 0 unmatched
tasks: 0 open · workflows: 1 enabled
deliveries sent: 1 · failed runs: 0
```

怎么读：

- **delivery** —— `test` 表示消息正被导流；`live` 表示它们会发到 workflow 本来设定的
  地方。
- **schedules owned by** —— pipeline 的调度只属于**一个**对话。如果这里显示的是别的
  对话，代表调度在那边跑；但命令和 task 工具在这里仍然可用。
- **unmatched** —— 没有任何 workflow 认领的 event。若看不到这个数字，「路由有缺口」和
  「今天很安静」长得一模一样 —— 所以它被记录下来而不是丢掉。
- **failed runs** —— 执行出错的 workflow。这里持续累积的话，值得反馈给部署的人。

## 立刻执行一次

```
/pm all
```

不等调度，立即跑完每个阶段：收进新 event、拿去跟 workflow 比对、再扫一次逾期的 task。
`/pm ingest`、`/pm run`、`/pm sweep` 则各跑一个阶段。

要确认某个东西接好了没，用这个，不必等一小时后的下一次触发。

:::note[在 Slack 上，命令前面要加一个空格]
Slack 客户端会拦截所有 `/` 开头的输入，而且只发出登记在 Slack App 里的命令，所以
`/pm` 根本离不开你的电脑。前面加一个空格打成 ` /pm status`，Slack 会当成普通消息发出，
而 agent-pm 照样读得懂它是命令。Telegram、Discord 和 GitHub comment 没有这种拦截。
:::

## 什么都没发生时

多数情况这是预期行为，不是坏掉：

- **控制对话还没配置。** 在配置之前，任何调度都不会触发。`/pm status` 会说明这点，而
  命令和 task 工具仍然可用。
- **没有东西被匹配到。** 看 `unmatched` 的数字。有 event 进来但没有匹配，代表缺一个
  workflow，不是 pipeline 卡住了。
- **默认只启用一个 workflow。** 内置启用的是一个心跳，用来证明整条路径从头到尾是通的。
  真正有意思的来源 —— 你的 repository、日历、聊天记录 —— 没有包含在内，因为那些需要
  贵组织自己的凭证与身份数据。得由人补上，见下一节。

## 给部署的人

安装后配置控制对话：

```sh
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --global
```

在该对话发送 `/pi-new` 以激活，然后编辑
`<stateDir>/global/extension-data/agent-pm/config.json`：

```jsonc
{
  "controlConversationId": "C0EXAMPLE1", // 拥有调度，也是投递目标
  "deliveryMode": "test", // 比对过输出之后再改成 "live"
  "testConversationId": "C0EXAMPLE2",
  "heartbeatHour": null, // null = 当天第一次触发，或指定一个 Asia/Taipei 小时
  "scheduleOverrides": {}, // 例如 {"run-workflows": "*/2 * * * *"}
}
```

在你完整看过一天的输出并认同它之前，`deliveryMode` 请维持 `test`。切到 `live` 的那一刻，
就是一个路由错误的 workflow 开始打扰真人的时刻。

agent-pm 同时也是开发自己 extension 的参考范例 —— callback schedule、typed tool、自定义
命令、SQLite 持久化、主动发消息、内置 skills，全部集中在一个地方。那一面请读
[Extension 开发](/zh-cn/extension-development/)与
[源码](https://github.com/geminixiang/mikan/tree/main/deploy/examples/extensions/agent-pm)。
