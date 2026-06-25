---
title: Image sandbox
description: 使用 mikan 管理的 per-conversation Docker container 与 vault 隔离。
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

如果你想自行定制 image，也可以本地 build：

```bash
docker build -f docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

特性：

- mikan 会为每个 conversation 创建一个独立 vault 与 container
- 每个 container 会绑定自己的 Docker bridge network，彼此默认互相隔离
- 创建 managed container 时会加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 与 `--pids-limit=1024`
- container 内只会看到 `/workspace/MEMORY.md`、`/workspace/skills`、`/workspace/events` 与当前 conversation 目录
- vault env 会在执行时注入
- vault file credential 会按 target path 自动 bind mount 进 container
- 空闲 container 会自动 stop；下次需要时再 start 或 recreate

vault key 选择逻辑：

1. 直接使用 conversation ID 作为 vault key，例如 `d123`
2. 该 conversation 的 credentials / mounts / env 都写入这个 vault
3. 对应的 managed container 会使用同一个 key，例如 `mikan-sandbox-d123`

适合：

- 多用户共享一个 mikan instance
- 需要 per-conversation env/file credential isolation
- 想比 shared container 更安全，但又不想直接上 Firecracker

## 容器资源限制

在 `settings.json` 中可设置每个 managed container 的 CPU 与内存上限：

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

| 字段                   | 说明                                       | 示例值           |
| ---------------------- | ------------------------------------------ | ---------------- |
| `sandbox.cpus`         | CPU 核心数上限（浮点数字符串）             | `"0.5"`, `"2"`   |
| `sandbox.memory`       | 内存上限（Docker memory 格式）             | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | `/pi-sandbox boost` 临时应用的 CPU 上限    | `"2"`, `"4"`     |
| `sandbox.boost.memory` | `/pi-sandbox boost` 临时应用的 memory 上限 | `"4g"`, `"8g"`   |

- 创建新 container 时，限制直接加进 `docker run` 参数
- 正在执行的 container 会在下次 provision 时通过 `docker update` 立即应用新限制，无需重新创建
- `/pi-sandbox` 会显示当前 conversation 的有效限制
- `/pi-sandbox boost` 会把当前 conversation 临时升级到 `sandbox.boost` 规格；boost 状态跟随 container，container stop 后就结束
- agent 可用内置 `sandbox` tool 查询或暂时设置当前 conversation 的 CPU / memory limit；这类 override 也会在 container stop 后清除
