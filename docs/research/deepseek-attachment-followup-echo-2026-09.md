# DeepSeek v4 Flash（OpenRouter）在附件追問時複讀上一輪答案

調查日期：2026-09-21
環境：本機 pm2 daemon（`~/.mikan`），Slack `geminixiang` workspace，`#qa-mama-test` 頻道，host sandbox。

## 結論

**已重現：`openrouter/deepseek/deepseek-v4-flash-0731` 在「上一輪剛結束、緊接著送出帶附件的新訊息」這個特定節奏下，至少一次完整跳過新訊息與附件，逐字複讀上一輪的 assistant 回覆，且未呼叫任何工具。** 換成 `macmini/claude-sonnet-5`（同一份 mikan 程式碼、同一套 attachment 路徑組裝方式）後，連續兩次用完全相同的節奏測試都正確讀取附件、答對異常值，不再重現。

**這把根因指向 provider/model 組合本身的行為異常，而非 mikan harness 組裝 prompt 的邏輯錯誤**：從 session JSONL 直接檢視送給模型的 user turn，內容本身完全正確（新問題文字 + `<slack_attachments>` 路徑一應俱全）；問題出在模型收到這個正確輸入後沒有依此生成新回應。兩次失敗的請求都伴隨異常高的 `cacheRead`（13568、14080 tokens），懷疑與 OpenRouter/DeepSeek 端的 prompt caching 命中錯誤有關，但這一點尚未定論，只是關聯觀察，不是已驗證的因果機制。

**這不是可下定論的「n=1 隨機模型失誤」，但樣本數也還不足以量化重現率**：本次只抓到 1 次失敗（2 次嘗試中 1 次），3 次緊接著送附件的正例都答對；換 provider 後 2/2 正確。屬於方向明確、複現率未量化的觀察，建議列為已知風險並持續觀察，而非視為已修復或已排除。

## 方法與證據等級

- **[L] 本地程式與 session 證據**：直接讀取本機 `~/.mikan/workspace/v1-slack-c0b4bl9ab6w-fdd225c4f0dc94eb/` 的 `log.jsonl` 與 `sessions/*.jsonl`，比對送進模型的 user turn 原始內容與模型實際輸出。
- **[E] 真實 Slack 互動**：透過瀏覽器在真實 Slack workspace 手動觸發，非 mock/單元測試；已先確認唯一 Socket Mode consumer（見 `docs/testing/slack-e2e.md`），排除事件被另一台機器的 mikan 進程吃掉的可能性。
- **[H] 推論**：cache 命中與複讀之間的關聯是觀察到的相關性，未做控制變因實驗（例如關閉 provider 端 cache）驗證因果。

## 測試設計

每組測試都設計成有客觀可驗證答案，避免只看「有沒有回覆」：

1. 準備一份 20 筆數值的 CSV，其中一筆刻意設為明顯離群值（例如 813.42 對比其餘 40～60 區間），先用 Python 獨立算出正確的 outlier `id`/`value`。
2. 在 Slack 頻道送出一則不相關的「暖身」問題（例如「1+1 等於多少？」），等待模型回覆完成。
3. **緊接著**（暖身回覆後幾秒內）在同一頻道貼上 CSV 附件並提出新問題：「請用工具實際讀取並計算，找出裡面的異常值 id 與 value」，回覆要求帶一個當次唯一的 token 以利比對。
4. 比對模型回覆的 token、id/value 是否正確，並回頭讀 session JSONL 確認：
   - 送給模型的 user turn 是否確實包含新問題文字與 `<slack_attachments>` 路徑；
   - assistant 回應是否有對應的 `bash`/`read` tool call；
   - 回應內容是否等同於「新問題的答案」還是「上一輪答案的複製品」。

## 觀察記錄

### DeepSeek v4 Flash（`openrouter/deepseek/deepseek-v4-flash-0731`，thinking off）

| Run | 節奏                                            | 結果                                                                         | 耗時 | 工具呼叫        |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ---- | --------------- |
| 1   | 附件+問題作為單獨一輪新訊息（無暖身）           | ✅ 正確（id 14, value 520.15）                                               | ~9s  | 有（bash 讀檔） |
| 2   | 先送暖身問題「1+1」，等回覆後立即送附件+新問題  | ❌ **複讀上一輪暖身問題的回覆**（`QA_R2_WARMUP_...` 的文字），完全未提及 CSV | 2.7s | **無**          |
| 3   | 附件+問題作為單獨一輪新訊息，等待 20 秒後才送出 | ✅ 正確（id 18, value 547.85）                                               | ~9s  | 有（bash 讀檔） |

Run 2 的 session JSONL（`sessions/2026-09-20T13-50-01-465Z_6b6237a0.jsonl`）顯示：

- 新一輪的 `role: user` entry 內容正確：`"...這個 CSV 有 20 筆 value 資料...\n\n<slack_attachments>\n.../attachments/..._qa_outlier_run2.csv\n</slack_attachments>"`。
- 對應的 `role: assistant` 回應是：`"QA_R2_WARMUP_1789924655145\n\n1+1 = **2**\n\n_Triggered by @f416720001_"`——與上一輪（暖身問題）的 assistant 輸出逐字相同。
- 該 run 的 `usage`：`input: 521, cacheRead: 14080`；上一輪暖身 run 的 `usage`：`input: 757, cacheRead: 13568`。兩者 cache 命中量都異常地高（相對於這輪對話的實際歷史長度）。
- 整個 run 從 `startedAt` 到 `endedAt` 僅 2.7 秒，遠低於正常「讀檔＋分析」所需時間（其餘正確案例都是 9 秒以上）。

此前（見本文件之前一輪測試上下文）也發生過一次類似模式：追問「把質數總和乘以 2」後，緊接著送出附件分析請求，模型同樣複讀了「乘以 2」那一輪的答案，完全忽略新問題與附件。兩次失敗共同點：**都是在上一輪剛結束、立刻送出下一則帶附件的新訊息**。

### macmini / Claude Sonnet 5（自訂 `openai-completions` 相容 provider，thinking off）

透過 `~/.mikan/models.json` 新增 `macmini` provider（`baseUrl: http://100.120.142.97:8317/v1`，模型 id `claude-sonnet-5`），`~/.mikan/settings.json` 切換 `llm.provider`/`llm.model`，以 `pm2 delete mikan && pm2 start ecosystem.config.cjs --only mikan` 重新載入生效（見 `.pi/skills/mikan-release/references/RELEASE.md` 的 PM2 重載注意事項）。

| Run | 節奏                                       | 結果                          | 耗時 | 工具呼叫   |
| --- | ------------------------------------------ | ----------------------------- | ---- | ---------- |
| A   | 質數計算（工具驗證，無附件）               | ✅ 正確（76127）              | 6s   | 有         |
| B   | 暖身問題「2+2」，等回覆後立即送附件+新問題 | ✅ 正確（id 8, value 813.42） | 3s   | 有（讀檔） |
| C   | 同上節奏，暖身後零延遲立即送附件+新問題    | ✅ 正確（id 4, value 1042.6） | 3s   | 有（讀檔） |

同一套 mikan 程式碼、同一個 Slack 頻道與 session 機制、同樣「暖身後立即追問」的節奏，Claude Sonnet 5 兩次都正確讀取新附件並給出對應答案，未重現複讀行為。

## 解讀與限制

- **範圍限定**：只測試了 `openrouter/deepseek/deepseek-v4-flash-0731`（thinking off）與 `macmini/claude-sonnet-5`（thinking off）兩個 provider/model 組合，且每個組合的樣本數很小（DeepSeek 2 次失敗嘗試中 1 次重現；Claude Sonnet 5 2/2 正確）。不足以量化真實重現率，也不能排除其他因素（例如 OpenRouter 當時的負載、特定 request 的 cache 狀態）。
- **不是 mikan harness 的 context 組裝問題**：session JSONL 直接證明 mikan 送給模型的 prompt 內容是對的（新問題文字、附件路徑都在），所以问题不在 `src/harness/prompt.ts`、attachment 路徑組裝或 session reload 邏輯，而是模型收到正確輸入後的生成行為異常。
- **與 cache 的關聯是觀察，非結論**：兩次失敗都有異常高的 `cacheRead`，但沒有做控制實驗（例如手動關閉 OpenRouter 的 prompt caching 或换一個不支援 cache 的等價 endpoint）驗證是否為因果。
- **不建議直接判定「DeepSeek v4 Flash 不能用」**：目前的證據只夠支持「這個 provider/model 在特定節奏下有間歇性複讀風險，需要更多樣本才能決定是否要下架或加防護」。

## 後續建議（僅供參考，未實作）

| 優先度 | 建議                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 擴大樣本：對 `deepseek/deepseek-v4-flash-0731` 用相同「暖身後立即追問+附件」節奏跑 10+ 次，量化實際重現率，並嘗試在其他 thinking level／不同前後文長度下複測。                                                            |
| P1     | 若重現率不低，考慮在 harness 層加一個「回應內容與上一輪 assistant 輸出逐字相同、但這一輪的 user 訊息內容不同」的偵測與自動重試（類似現有 e2e helper 裡「budget 模型偶爾漏 token，重試一次」的作法），而非只在測試裡繞過。 |
| P2     | 若要提報 upstream（OpenRouter 或 DeepSeek），需要更多獨立樣本與可重複的 request/response pair（含 request id）作為證據，目前的兩次觀察不足以構成一個可提報的 bug report。                                                 |

## 一手來源

- **[M1]** 本機 `~/.mikan/workspace/v1-slack-c0b4bl9ab6w-fdd225c4f0dc94eb/log.jsonl` — 對話歷史紀錄，含 Run 2 失敗與其餘正確 run 的完整文字。
- **[M2]** 本機 `~/.mikan/workspace/v1-slack-c0b4bl9ab6w-fdd225c4f0dc94eb/sessions/2026-09-20T13-50-01-465Z_6b6237a0.jsonl` — DeepSeek session 的原始 `user`/`assistant` entry 與 `usage`（含 `cacheRead`）數據。
- **[M3]** `docs/testing/slack-e2e.md` — 唯一 Socket Mode consumer 檢查方法，本次測試前已排除競爭 daemon 干擾。
- **[M4]** `.pi/skills/mikan-release/references/RELEASE.md` — PM2 env 重載注意事項，本次切換 provider 時依此用 `pm2 delete && pm2 start` 而非 `restart --update-env`。
