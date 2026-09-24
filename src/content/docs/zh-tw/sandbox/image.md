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

受管容器由「映像」加上每個 office 一個的 home volume `mikan-home-<key>`（掛在 `/root`）組成。工作區掛載與
`/root`（npm/uv/pip 快取、`~/.local`、dotfiles）在升級後保留；其他寫進容器檔案系統的內容（`apt install`、
`/etc` 修改、`/tmp`）不保留。

1. 在主機上以 mikan 使用的 tag 拉取新映像（`docker pull …:latest`）。mikan 不會自行 pull；保留舊映像 ID 以便回滾。
2. 有 home volume 的容器會自動換上新映像：執行中的容器不會被中斷，閒置停止後，下一則訊息會以同一個 volume
   `docker rm` + `docker run` 取代它。
3. 在 home volume 之前建立的舊容器不會被自動處理。先停止 daemon，再小批次檢查並遷移：

```bash
mikan sandbox status --image ghcr.io/geminixiang/mikan-sandbox:latest
mikan sandbox diff <container-key> --image ghcr.io/geminixiang/mikan-sandbox:latest
mikan sandbox migrate <container-key>... --image ghcr.io/geminixiang/mikan-sandbox:latest
```

`status` 會標示每個容器是 `legacy`/`home-volume`、`current-image`/`stale-image`；`diff` 列出升級會丟棄的系統路徑；
`migrate` 先用容器目前的 `/root` 填入 home volume，再以目前映像重建容器。

回滾：把 tag 指回舊映像 ID，容器會再次被替換，home volume 原樣保留。`/login` 會重建容器但保留 home volume。

## Mount 與 conversation office

該對話的 office 目錄會以可讀寫的方式 bind mount 在 `/workspace/<office-key>`，其中 office key 就是 `v1-<platform>-<readable-id>-<hash>` 這段、同時也是宿主機上該目錄的名稱。isolated projection 只掛載這個目錄；trusted 的 `shared-support` layout 會再加上 workspace 全域的 `MEMORY.md`、`skills/` 與 `events/`。private visibility 會把全域記憶 bind 設為唯讀，public visibility 則維持讀寫；`trusted` / `full` 會把整個 workspace root 掛在 `/workspace`。

變更 door policy 會在下一則訊息時更新 mount。有 home volume 的 container 會用目前映像重建，保留 `/root` 與 workspace mount，但其他寫入 container 檔案系統的內容會消失。舊版、尚無 home volume 的 container 則會透過 snapshot 保留可寫層。開機時 layout 遷移所做的 office 目錄改名，也走同一條路徑。

## Vault key 與 container key

Credentials 以 **office key** 為 key：某個對話的 vault 目錄是 `~/.mikan/vaults/<office-key>/`。這個 key 由平台名稱與該平台的原始 conversation id 一起雜湊而來，因此就算兩個平台剛好使用相同的 raw id，也絕不可能解析到對方的憑證。在舊的 raw-id 機制下寫入的 conversation vault 目錄，會由開機時的遷移改名為 office key。

受管 container 名為 `mikan-sandbox-<resource-key>`，其 network 則是 `mikan-sandbox-net-<resource-key>`。resource key 仍由原始 conversation id 推導（一段清理過的前綴加上短 digest）——改動它會讓每一個已佈建的 container 都被翻攪，因此它是分開遷移的。這裡發生碰撞的代價是一次 container 重建，絕不會影響憑證存取。

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
