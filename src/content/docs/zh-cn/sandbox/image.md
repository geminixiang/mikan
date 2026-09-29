---
title: Image 沙箱
description: 使用 mikan 管理的按对话 Docker 容器和 vault 隔离。
---

```bash
# Pull the prebuilt image from GHCR
# Only mikan releases publish the image: :<version>, :latest, :tools, and :beta for prereleases
docker pull ghcr.io/geminixiang/mikan-sandbox:latest

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest /path/to/workspace
```

如果要自行定制镜像，也可以在本地构建：

```bash
docker build -f deploy/docker/mikan-sandbox.Dockerfile -t mikan-sandbox:latest .
mikan --sandbox=image:mikan-sandbox:latest /path/to/workspace
```

特性：

- 标准工具镜像内置 Node.js 24、Chromium、中日韩字体、ffmpeg，以及供 `jev_browser` 使用并锁定版本的 `agent-browser` 0.38.1 runtime
- 镜像内置工具安装在 `/usr/local` 与 `/opt`，不放在 `/root`；在 sandbox 内执行 `npm i -g`、`uv tool install` 会装到 `/root/.local`，该目录已在 `PATH` 中；Python 包用 uv 管理（`uv run --with <包>`），因为系统 pip 会拒绝安装
- mikan 为每个对话创建隔离的 vault 和容器
- 每个容器都有自己的 Docker bridge 网络，以隔离容器间的直接网络连接；出站网络访问仍保持启用
- 管理的容器使用 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 和 `--pids-limit=1024` 创建
- 容器内的工作区挂载跟随显式设置或已记录的 Slack 频道可见性：公开频道读写共享记忆，私密频道只读共享记忆，DM、外部和未知对话保持 isolated
- vault 环境变量在执行时注入
- vault 文件凭证会自动 bind mount 到容器中，目标由每个文件的名称推断（参阅 [Vault](/zh-cn/sandbox/vault/)）
- 每 10 分钟检查一次空闲容器，并在至少 10 分钟无活动后停止；根据扫描时间，停止大约发生在最后一次跟踪使用后的 10–20 分钟

## 升级沙盒镜像

受管理的容器可以随时丢弃。只有它的 bind mount（对话办公室、共享知识和 vault 文件）会保留；写在容器其他位置的内容，包括 `/root`、安装的软件包和 `/etc` 的修改，都会在容器被替换时消失。需要保留的内容请放在工作区。

1. 在主机上用 mikan 使用的 tag 拉取新镜像（`docker pull …:latest`）。mikan 不会自行拉取；请保留上一个 image ID 以便回滚。
2. 运行中的容器不会被中断。容器因空闲而停止后，下一条消息会用新镜像替换它（`docker rm` + `docker run`）。

回滚：把 tag 指回上一个 image ID，让容器再被替换一次。

## 挂载与对话办公室

该对话的办公室目录以可读写方式 bind mount 到 `/workspace/<office-key>`，其中 office key 就是在主机上
同样命名该目录的 `v1-<platform>-<readable-id>-<hash>` 路径段。isolated 投影只挂载该目录；受信任的
`shared-support` 布局会额外加上工作区级的 `MEMORY.md`、`skills/` 和 `events/`。private visibility 会把
全局记忆 bind 标记为只读，public visibility 则维持读写；`trusted` / `full` 会把整个工作区根目录挂载到
`/workspace`。

mount 改变时（例如 visibility 变更之后），下一条消息会用当前镜像替换容器。

## Vault key 与容器 key

凭证按 **office key** 标识：某个对话的 vault 目录是 `~/.mikan/vaults/<office-key>/`。该 key 由平台名称与平台的原始对话 id 一起哈希派生，因此两个恰好使用同一原始 id 的平台永远无法解析到彼此的凭证。`mikan migrate` 会把 0.5.3 以原始对话 id 命名的 vault 目录重命名为 office key。

受管理的容器名为 `mikan-sandbox-<office-key>`，其网络为 `mikan-sandbox-net-<office-key>`。

适用于：

- 多个用户共享一个 mikan 实例
- 按对话隔离环境变量/文件凭证

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
- `/pi-sandbox` 显示当前对话的有效限制，以及它的门禁策略和布局
- `/pi-sandbox boost` 临时将当前对话升级到 `sandbox.boost` 规格；boost 状态跟随容器，并在容器停止时结束
- `/pi-sandbox door <default|isolated|shared|shared-private|full>` 切换本办公室的门禁策略；容器会在下一条消息时以新的 mount 重新创建，并保留其内容
- 代理可以使用内置 `sandbox` 工具检查或临时设置当前对话的 CPU/内存限制；这些覆盖也会在容器停止时清除
