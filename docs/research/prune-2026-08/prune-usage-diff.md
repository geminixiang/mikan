# Usage authority 差異報告

依指示先鎖住現行 parent + subagent 情境的 observable usage summary；結果證實 presenter 與 harness 的 tally **不一致**，因此跳過 Finding 8，未修改 usage production code。

## 驗證方式

建立暫時性 Vitest（執行後已刪除），同時固定：

- presenter `RunnerSessionState.totalUsage`：parent completion 用量
- `MikanAgentSession.getLastRunStats()`：parent + subagent 合併用量
- `reportUsageSummary()` 實際送給 responder 的 diagnostics 文字

執行：

```text
npm test -- src/test/prune-usage-authority-diagnostic.test.ts
```

結果：1 file / 1 test passed，證實目前 observable summary 使用 presenter 的 parent-only tally，而不是 harness 的 combined tally。

## 精確差異

測試固定 parent usage：

```json
{
  "input": 100,
  "output": 20,
  "cacheRead": 30,
  "cacheWrite": 5,
  "totalTokens": 155,
  "cost": {
    "input": 1,
    "output": 2,
    "cacheRead": 0.3,
    "cacheWrite": 0.05,
    "total": 3.35
  }
}
```

harness 在 fold subagent 後的 combined usage：

```json
{
  "input": 140,
  "output": 30,
  "cacheRead": 35,
  "cacheWrite": 7,
  "totalTokens": 212,
  "cost": {
    "input": 1.4,
    "output": 3,
    "cacheRead": 0.35,
    "cacheWrite": 0.07,
    "total": 4.82
  }
}
```

現行 `reportUsageSummary()` observable output：

```text
_Usage Summary_
Input: 100 tokens · 30 cached · CH 22.2%
Output: 20 tokens
Cost: $1.0000 in + $0.3000 cache + $2.0000 out = *$3.3500*
```

若改以 harness 為單一 authority，observable output 會變為：

```text
_Usage Summary_
Input: 140 tokens · 35 cached · CH 19.2%
Output: 30 tokens
Cost: $1.4000 in + $0.3500 cache + $3.0000 out = *$4.8200*
```

此外 `llmCallCount` 也不同：presenter 為 parent calls（例：1），harness stats 為 parent session/compaction calls 且 external subagent usage fold 不增加 parent llmCalls；具體產品語義需要另行決定，不能以純剪枝名義無聲改變。

## 原因

- `src/agent/presenter.ts` 只在 parent assistant `message_end` 累加 usage。
- `src/harness/runner.ts` 除 parent assistant/compaction 外，還由 `captureExternalUsageSink()` fold subagent usage。
- 因此目前平台 usage summary 與 `agent.run.*` metrics 是 parent-only；harness budget tally 是 parent + subagent spend。

依本次規則，發現數字不一致後停止 usage authority 收斂。要繼續需先確認產品契約：usage summary/metrics 是否應包含 subagent spend，以及 `llm_calls` 應表示 parent calls 還是整個 agent tree calls。
