# Slack E2E 診斷與執行守則

Slack E2E 透過 Socket Mode 驅動真實 Slack App。它不是一般的 hermetic test：同一個 App 如果同時有多個 Socket Mode client，Slack 會把每個 event 交給其中一個 client，而不是廣播給全部 client。

## 執行前：確認唯一 event consumer

在觸發 GitHub Slack E2E 前，先確認本機與其他已知環境沒有使用同一個 QA Slack App：

```bash
pm2 jlist
pgrep -fl "dist/main.js|mikan"
```

若本機 PM2 `mikan` 使用相同 App，取得操作者明確同意後再停止：

```bash
pm2 stop mikan
```

不要假設另一個 client 只會造成一半失敗。Socket Mode routing 可能具有黏著性：同一個 client 可以連續取得所有 retry events。

## 為什麼綠燈也可能不可信

另一個 daemon 不只會讓 GitHub runner timeout，也可能替 GitHub 測試回覆訊息，使沒有 local-delivery assertion 的測試錯誤通過。因此：

- failure 可能是 GitHub runner 沒收到 event；
- success 也可能是另一個 daemon 代為回答；
- 只有確認唯一 consumer，真實平台 E2E 結果才可用來判斷 production regression。

## Missing event 的診斷順序

看到 reply timeout 時，不要先怪 LLM，也不要先增加 timeout。

1. 用唯一的 `QA_DELIVERY_*` 或測試 token 定位 GitHub Actions daemon log。
2. 確認訊息是否進入該 runner 的 conversation `log.jsonl`。
3. 如果 intake log 完全沒有訊息，先查其他 Socket Mode clients 與其 logs。
4. 若訊息已進 intake，但沒有 run，再檢查 trigger、queue 與 session routing。
5. 若 run 已開始但回覆不符，最後才檢查 model latency、instruction compliance 與 response rendering。

判讀原則：conversation history 在 intake、model run 之前寫入。若 runner 的 intake log 沒有該 event，問題位於 queue/session/model 之前。

## 用 token 做跨環境鑑識

每次 retry 的唯一 marker 是最可靠的證據。把 CI event 時間換算成其他環境的時區，再搜尋完全相同的 token：

```bash
rg "QA_DELIVERY_|QA_DM_CTX_|QA_ISOLATE_" <daemon-log>
```

如果另一個 daemon 在相同時間處理完全相同的測試 token 與 retry nonce，而 CI daemon 沒有 intake record，即可證明 event 被另一個 Socket Mode client 消費。不要用模糊時間接近或相似文案下結論。

## Timeout authority

本機 event delivery 與 LLM reply 是不同 latency domain：

- local delivery confirmation 只等待 `log.jsonl` 出現 event，使用固定、短、bounded timeout；
- model reply timeout 可依 CI 模型速度調整；
- outer Vitest timeout 必須大於所有合法 retry 與 reply waits 的總和，讓 helper 自己的描述性錯誤先發生。

不要把 `SLACK_QA_TIMEOUT_MS` 直接套到 local-delivery confirmation。提高模型 timeout 不應同步把每次 Socket Mode retry 放大。

## 收尾

E2E 完成後，如需恢復本機 daemon：

```bash
pm2 start mikan
```

重新啟動同樣是外部服務狀態變更，應取得操作者當次明確同意。

## 本地完整 E2E

先完成上面的唯一 consumer 檢查，且取得真實 Slack 測試授權。
`~/.mikan/mikan.env`（0600）需有 `SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN`、
`SLACK_QA_USER_TOKEN`；不要將 token 放進 shell history 或 repo。
本地模型沿用 `~/.mikan/settings.json` 與 mikan 的 models.json。

```bash
SLACK_QA_CHANNEL_ID=C_YOUR_QA_CHANNEL npm run test:e2e:slack:local
```

單一案例可傳檔案 filter：

```bash
SLACK_QA_CHANNEL_ID=C_YOUR_QA_CHANNEL npm run test:e2e:slack:local -- e2e/slack/thread-stop.e2e.ts
```

指令會 build、驗證 bot/user 同 workspace 且不同身分，在 private temp state
啟動 daemon，再執行 E2E；結束時停止 daemon，保留私有 `daemon.log` 與
`tests.log`。Artifacts 路徑會輸出到終端。測試使用 **host sandbox** 與 trusted/full
的拋棄式 workspace；這不是 OS 隔離，需信任測試與模型，不要與 production
共用憑證用途。其他平台與 telemetry 在測試程序中停用，不修改原 settings。

`SLACK_QA_CONFIG_DIR` 可指定包含 mikan.env/settings.json 的來源目錄；models.json
仍依 mikan 的模型載入規則。`SLACK_QA_WORKING_DIR` 指定既有 daemon 時，未明確
設定 `SLACK_QA_EVENTS_DIR` 則自動使用 workingDir/events，避免事件寫到錯的 workspace。

本地通過不代表 GitHub 上不同模型的間歇失敗已根治。多檔案案例會先確認 Slack
分享訊息與本機 intake，再等待模型答案；thread-stop 案例檢查 stop 在原 thread
完成且沒有 top-level 停止訊息。
