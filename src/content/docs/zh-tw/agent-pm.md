---
title: agent-pm
description: 使用團隊營運 pipeline —— 它會帶什麼給你、任務怎麼處理，以及你的回答如何改變它下一次的判斷。
---

agent-pm 會盯著團隊周邊發生的事，只把**需要人來判斷的**那些帶到你面前。它是一個
extension：有人把它裝進某個對話，之後你就用平常跟 mikan 說話的方式跟它互動。

這頁是講怎麼用。如果你是負責安裝的人，直接看
[給部署的人](#給部署的人)。

## 你身處的那個循環

所有發生的事 —— 一則訊息、一次 repository 變更、一個整點 —— 都會被記成一筆
**event**。叫做 **workflow** 的規則逐一檢視每筆 event，判斷是否有後續動作。當某件事
需要只有人才有的判斷時，workflow 會建立一筆 **task** 送給你。

接著是真正關鍵的部分：你關閉 task 時要說明它**怎麼結束的**，那個答案就是
**feedback**。這不是行政流程。把 task 關成 `no_action_needed`，等於告訴那個 workflow
它本來就不該問，而這個判斷會改變它下次遇到類似 event 的行為。隨手關掉的 task，教會
它的是錯的東西。

## 你會看到什麼

Task 會以一般訊息的形式出現在擁有這條 pipeline 的對話裡。沒有另一個你得記得去查的
獨立工具。

如果 pipeline 跑在 **test 模式**，每則訊息都會被導到單一對話，並標註它**原本**要送去
哪裡。那是預設值，而且是刻意的 —— 一個會通知人的 extension，距離「通知所有人、而且
通知兩次」只差一個設定失誤。在測試頻道看到帶標註的訊息代表它正常運作，不是壞了。

## 兩個介面，而且不重疊

要用哪一個，取決於你在做什麼：

| 你想做的事                        | 方式                                |
| --------------------------------- | ----------------------------------- |
| 處理 task —— 查看、關閉、說明結果 | **跟 agent 說話。沒有對應的指令。** |
| 操作 pipeline —— 查狀態、立刻執行 | `/pm …`，不經過模型                 |

這個分工是刻意的。操作 pipeline 是機械性的，所以做成指令：精確、即時、不花錢。處理
task 是判斷，所以走 agent —— 只有它讀得懂「處理好了，那次部署修掉了」是什麼意思。

## 處理一筆 task

用你自己的話問 —— 這是**唯一**的方式，沒有對應的 `/pm` 指令：

> 現在還有哪些沒處理完？
>
> 給我看 task 12
>
> task 12 關掉，已經處理好了 —— 那次部署修掉了

關閉時請說明**實際發生了什麼**。共有四種結果，而它們對建立這筆 task 的 workflow 意義
各不相同：

| 結果               | 什麼時候用                                      |
| ------------------ | ----------------------------------------------- |
| `resolved`         | 這筆 task 提得對，而你把事情做了                |
| `no_action_needed` | task 有被提出，但實際上不需要做什麼             |
| `invalid`          | 這筆 task 根本不該存在 —— workflow 誤讀了 event |
| `superseded`       | 被別的事情取代了                                |

後兩個才是有價值的。`no_action_needed` 和 `invalid` 是 workflow 得知「自己問得太頻繁」
的唯一途徑，它們會被記成對該 workflow 的 feedback。如果你什麼都關成 `resolved`，這條
pipeline 永遠不會發現它正在浪費你的注意力。

## 查看狀態

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

怎麼讀：

- **delivery** —— `test` 表示訊息正被導流；`live` 表示它們會送到 workflow 本來設定的
  地方。
- **schedules owned by** —— pipeline 的排程只屬於**一個**對話。如果這裡顯示的是別的
  對話，代表排程在那邊跑；但指令和 task 工具在這裡仍然可用。
- **unmatched** —— 沒有任何 workflow 認領的 event。若看不到這個數字，「路由有缺口」和
  「今天很安靜」長得一模一樣 —— 所以它被記錄下來而不是丟掉。
- **failed runs** —— 執行出錯的 workflow。這裡持續累積的話，值得回報給部署的人。

## 立刻執行一次

```
/pm all
```

不等排程，立即跑完每個階段：收進新 event、拿去跟 workflow 比對、再掃一次逾期的 task。
`/pm ingest`、`/pm run`、`/pm sweep` 則各跑一個階段。

要確認某個東西接好了沒，用這個，不必等一小時後的下一次觸發。

:::note[在 Slack 上，指令前面要加一個空格]
Slack 客戶端會攔截所有 `/` 開頭的輸入，而且只送出登記在 Slack App 裡的指令，所以
`/pm` 根本離不開你的電腦。前面加一個空格打成 ` /pm status`，Slack 會當成一般訊息送出，
而 agent-pm 照樣讀得懂它是指令。Telegram、Discord 和 GitHub comment 沒有這種攔截。
:::

## 什麼都沒發生時

多數情況這是預期行為，不是壞掉：

- **控制對話還沒設定。** 在設定之前，任何排程都不會觸發。`/pm status` 會說明這點，而
  指令和 task 工具仍然可用。
- **沒有東西被匹配到。** 看 `unmatched` 的數字。有 event 進來但沒有匹配，代表缺一個
  workflow，不是 pipeline 卡住了。
- **預設只啟用一個 workflow。** 內建啟用的是一個心跳，用來證明整條路徑從頭到尾是通的。
  真正有意思的來源 —— 你的 repository、行事曆、聊天紀錄 —— 沒有包含在內，因為那些需要
  貴組織自己的憑證與身分資料。得由人補上，見下一節。

## 給部署的人

安裝後設定控制對話：

```sh
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --global
```

在該對話送出 `/pi-new` 以啟用，然後編輯
`<stateDir>/global/extension-data/agent-pm/config.json`：

```jsonc
{
  "controlConversationId": "C0EXAMPLE1", // 擁有排程，也是投遞目標
  "deliveryMode": "test", // 比對過輸出之後再改成 "live"
  "testConversationId": "C0EXAMPLE2",
  "heartbeatHour": null, // null = 當天第一次觸發，或指定一個 Asia/Taipei 小時
  "scheduleOverrides": {}, // 例如 {"run-workflows": "*/2 * * * *"}
}
```

在你完整看過一天的輸出並認同它之前，`deliveryMode` 請維持 `test`。切到 `live` 的那一刻，
就是一個路由錯誤的 workflow 開始打擾真人的時刻。

agent-pm 同時也是開發自己 extension 的參考範例 —— callback schedule、typed tool、自訂
指令、SQLite 持久化、主動送訊息、內建 skills，全部集中在一個地方。那一面請讀
[Extension 開發](/zh-tw/extension-development/)與
[原始碼](https://github.com/geminixiang/mikan/tree/main/deploy/examples/extensions/agent-pm)。
