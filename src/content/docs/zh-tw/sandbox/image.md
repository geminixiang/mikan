---
title: Image sandbox
description: 使用 mikan 管理的 per-conversation Docker container 與 vault 隔離。
---

```bash
# Pull the prebuilt image from GHCR
# Only mikan releases publish the image: :<version>, :latest, :tools, and :beta for prereleases
docker pull ghcr.io/geminixiang/mikan-sandbox:latest

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest /path/to/workspace
```

如果你想自行客製 image，也可以本地 build：

```bash
docker build -f deploy/docker/mikan-sandbox.Dockerfile -t mikan-sandbox:latest .
mikan --sandbox=image:mikan-sandbox:latest /path/to/workspace
```

特性：

- 標準工具 image 內建 Node.js 24、Chromium、ffmpeg，以及供 `jev_browser` 使用並鎖定版本的 `agent-browser` 0.38.1 runtime
- image 內建工具安裝在 `/usr/local` 與 `/opt`，不放在 `/root`；在 sandbox 內執行 `npm i -g`、`uv tool install`、`pip install --user` 會裝到 `/root/.local`，且該目錄已在 `PATH` 中
- mikan 會為每個 conversation 建立一個獨立 vault 與 container
- 每個 container 都有自己的 Docker bridge network，隔離直接的 container-to-container networking；outbound network access 仍保持啟用
- 建立 managed container 時會加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 與 `--pids-limit=1024`
- container 內的 workspace mount 跟隨明確設定或已記錄的 Slack 頻道可見性：公開頻道讀寫共享記憶，私密頻道唯讀共享記憶，DM、外部及未知對話維持 isolated
- vault env 會在執行時注入
- vault file credential 會自動 bind mount 進 container，target 由每個檔案的名稱推斷（見 [Vault](/zh-tw/sandbox/vault/)）
- 每 10 分鐘檢查一次閒置 containers，至少閒置 10 分鐘後停止；視掃描時間而定，約在最後一次追蹤使用後 10–20 分鐘停止

## 升級沙盒映像

受管 container 可以隨時拋棄。只有它的 bind mount（conversation office、共享知識與 vault 檔案）會留下；寫在 container 其他位置的東西，包括 `/root`、安裝的套件與 `/etc` 的修改，都會在 container 被替換時消失。需要保留的東西請放在 workspace。

1. 在 host 上用 mikan 使用的 tag 拉取新映像（`docker pull …:latest`）。mikan 不會自行拉取；請保留前一個 image ID 以便回滾。
2. 執行中的 container 不會被中斷。container 因閒置而停止後，下一則訊息會用新映像替換它（`docker rm` + `docker run`）。

回滾：把 tag 指回前一個 image ID，讓 container 再被替換一次。

## Mount 與 conversation office

該對話的 office 目錄會以可讀寫的方式 bind mount 在 `/workspace/<office-key>`，其中 office key 就是 `v1-<platform>-<readable-id>-<hash>` 這段、同時也是宿主機上該目錄的名稱。isolated projection 只掛載這個目錄；trusted 的 `shared-support` layout 會再加上 workspace 全域的 `MEMORY.md`、`skills/` 與 `events/`。private visibility 會把全域記憶 bind 設為唯讀，public visibility 則維持讀寫；`trusted` / `full` 會把整個 workspace root 掛在 `/workspace`。

mount 改變時（例如 visibility 變更之後），下一則訊息會用目前映像替換 container。

## Vault key 與 container key

Credentials 以 **office key** 為 key：某個對話的 vault 目錄是 `~/.mikan/vaults/<office-key>/`。這個 key 由平台名稱與該平台的原始 conversation id 一起雜湊而來，因此就算兩個平台剛好使用相同的 raw id，也絕不可能解析到對方的憑證。`mikan migrate` 會把 0.5.3 以原始 conversation id 命名的 vault 目錄改名為 office key。

受管 container 名為 `mikan-sandbox-<office-key>`，其 network 則是 `mikan-sandbox-net-<office-key>`。

適合：

- 多使用者共用一個 mikan instance
- 需要 per-conversation env/file credential isolation

## 容器資源限制

在 `settings.json` 中可設定每個 managed container 的 CPU 與記憶體上限：

```json
{
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    }
  }
}
```

| 欄位                   | 說明                                       | 範例值           |
| ---------------------- | ------------------------------------------ | ---------------- |
| `sandbox.cpus`         | CPU 核心數上限（浮點數字串）               | `"0.5"`, `"2"`   |
| `sandbox.memory`       | 記憶體上限（Docker memory 格式）           | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | `/pi-sandbox boost` 暫時套用的 CPU 上限    | `"2"`, `"4"`     |
| `sandbox.boost.memory` | `/pi-sandbox boost` 暫時套用的 memory 上限 | `"4g"`, `"8g"`   |

- 建立新 container 時，限制直接加進 `docker run` 參數
- 已在執行的 container 會在下次 provision 時透過 `docker update` 立即套用新限制，不需重新建立
- `/pi-sandbox` 會顯示目前 conversation 的有效限制，以及它的 door policy 與 layout
- `/pi-sandbox boost` 會把目前 conversation 暫時升級到 `sandbox.boost` 規格；boost 狀態跟著 container，container stop 後就結束
- `/pi-sandbox door <default|isolated|shared|shared-private|full>` 可切換這個 office 的 door policy；container 會在下一則訊息時以新的 mount 重建，保留 `/root` 與 workspace mount
- agent 可用內建 `sandbox` tool 查詢或暫時設定目前 conversation 的 CPU / memory limit；這類 override 也會在 container stop 後清除
