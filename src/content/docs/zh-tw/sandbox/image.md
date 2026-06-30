---
title: Image sandbox
description: 使用 mikan 管理的 per-conversation Docker container 與 vault 隔離。
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

如果你想自行客製 image，也可以本地 build：

```bash
docker build -f docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

特性：

- mikan 會為每個 conversation 建立一個獨立 vault 與 container
- 每個 container 會綁定自己的 Docker bridge network，彼此預設互相隔離
- 建立 managed container 時會加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 與 `--pids-limit=1024`
- container 內只會看到 `/workspace/MEMORY.md`、`/workspace/skills`、`/workspace/events` 與當前 conversation 目錄
- vault env 會在執行時注入
- vault file credential 會依 target path 自動 bind mount 進 container
- 閒置 container 會自動 stop；下次需要時再 start 或 recreate

vault key 選擇邏輯：

1. 直接使用 conversation ID 作為 vault key，例如 `d123`
2. 該 conversation 的 credentials / mounts / env 都寫入這個 vault
3. 對應的 managed container 會使用同一個 key，例如 `mikan-sandbox-d123`

適合：

- 多使用者共用一個 mikan instance
- 需要 per-conversation env/file credential isolation
- 想比 shared container 更安全，但又不想直接上 Firecracker

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
- `/pi-sandbox` 會顯示目前 conversation 的有效限制
- `/pi-sandbox boost` 會把目前 conversation 暫時升級到 `sandbox.boost` 規格；boost 狀態跟著 container，container stop 後就結束
- agent 可用內建 `sandbox` tool 查詢或暫時設定目前 conversation 的 CPU / memory limit；這類 override 也會在 container stop 後清除
