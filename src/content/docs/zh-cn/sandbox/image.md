---
title: Image 沙箱
description: 使用 mikan 管理的按对话 Docker 容器和 vault 隔离。
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

如果要自行定制镜像，也可以在本地构建：

```bash
docker build -f docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

特性：

- mikan 为每个对话创建隔离的 vault 和容器
- 每个容器都有自己的 Docker bridge 网络，以隔离容器间的直接网络连接；出站网络访问仍保持启用
- 管理的容器使用 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 和 `--pids-limit=1024` 创建
- 容器内只能看到 `/workspace/MEMORY.md`、`/workspace/skills`、`/workspace/events` 和当前对话目录
- vault 环境变量在执行时注入
- vault 文件凭证会根据目标路径自动 bind mount 到容器中
- 每 10 分钟检查一次空闲容器，并在至少 10 分钟无活动后停止；根据扫描时间，停止大约发生在最后一次跟踪使用后的 10–20 分钟

Vault key 选择逻辑：

1. 将对话 ID 转为小写，把连续的非字母数字字符替换为 `-`，去除首尾短横线；如果没有剩余字符则使用 `unknown`
2. 将该对话的凭证、挂载和环境变量写入规范化后的 vault key
3. 管理的容器使用同一个规范化 key，例如 `mikan-sandbox-d123`

由于规范化可能使不同原始 ID 得到相同结果，请避免手动构造仅标点或大小写不同的平台 ID。

适用于：

- 多个用户共享一个 mikan 实例
- 按对话隔离环境变量/文件凭证
- 需要比共享容器更好的安全性，但不需要 Firecracker

## 容器资源限制

可以在 `settings.json` 中配置每个管理容器的 CPU 和内存限制：

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

| 字段                   | 说明                                    | 示例值           |
| ---------------------- | --------------------------------------- | ---------------- |
| `sandbox.cpus`         | CPU 核心限制（浮点数字符串）            | `"0.5"`, `"2"`   |
| `sandbox.memory`       | 内存限制（Docker memory 格式）          | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | `/pi-sandbox boost` 应用的临时 CPU 限制 | `"2"`, `"4"`     |
| `sandbox.boost.memory` | `/pi-sandbox boost` 应用的临时内存限制  | `"4g"`, `"8g"`   |

- 创建新容器时，限制直接添加到 `docker run`
- 运行中的容器会在下次 provision 时通过 `docker update` 立即获得新限制，无需重新创建
- `/pi-sandbox` 显示当前对话的有效限制
- `/pi-sandbox boost` 临时将当前对话升级到 `sandbox.boost` 规格；boost 状态跟随容器，并在容器停止时结束
- 代理可以使用内置 `sandbox` 工具检查或临时设置当前对话的 CPU/内存限制；这些覆盖也会在容器停止时清除
