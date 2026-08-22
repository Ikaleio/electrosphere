# Electrosphere

面向 AI 编程代理的沙箱编排守护进程。Electrosphere 创建隔离的执行环境（Docker 容器或 Firecracker 微虚拟机），在其中运行 shell 命令，并通过内容寻址快照管理工作区状态。

## 架构

```
┌────────────────────────────────────────────────┐
│                  守护进程 (Bun)                  │
├────────────┬───────────────┬───────────────────┤
│  REST API  │   MCP 服务    │    会话管理器      │
├────────────┴───────────────┴───────────────────┤
│                 沙箱服务                         │
├─────────────────────┬──────────────────────────┤
│    Docker 后端      │    Firecracker 后端      │
└─────────────────────┴──────────────────────────┘
         │                        │
    ┌────┴────┐             ┌────┴────┐
    │  容器   │             │  微虚拟机│
    │  Agent  │             │  Agent  │
    └─────────┘             └─────────┘
```

守护进程运行在 Bun 上，对外暴露两个接口：

- **REST API**（`/v1/*`）：管理工作区和实例的生命周期。
- **MCP 端点**（`/mcp`）：供 AI 代理调用 `shell` 工具。

每个沙箱内运行一个静态链接的 Rust 代理程序（`electrosphere-agent`），通过 Unix socket 或 vsock 执行命令并返回结果。

## 核心概念

| 概念 | 说明 |
|------|------|
| **Thread** | 由 harness 管理的一组连续 turn。Durable thread 独占一个持久工作区。 |
| **Turn** | 一次由 harness 控制的 runtime 生命周期。工具只能访问当前 turn 绑定的 runtime。 |
| **Instant 模式** | 每个 turn 创建一个空白 runtime，不读取或写入 thread 工作区。Harness 可选择 `docker` 或 `firecracker`，默认使用 `firecracker`。 |
| **Durable 模式** | Turn 开始时物化 thread head commit，turn 结束时发布一个新 commit。 |
| **Backend** | 隔离技术：`docker` 或 `firecracker`。 |
| **Commit** | 工作区目录树的不可变内容寻址 CFS 快照。 |

## 前置条件

- [Bun](https://bun.sh) >= 1.1
- Docker（用于 `docker` 后端）
- Firecracker + jailer（用于 `firecracker` 后端，可选）
- Rust 工具链，需包含 `x86_64-unknown-linux-musl` target（编译 agent 用）

## 安装

```bash
# 安装依赖
bun install

# 编译沙箱内的 agent
bun run agent:build

# 构建运行时容器镜像（Docker 后端）
docker build -t electrosphere-runtime -f runtime/Dockerfile .
```

## 配置

所有配置通过环境变量设定：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ELECTROSPHERE_DATA_DIR` | *（必填）* | 绝对路径，存放 SQLite 数据库、CFS 对象和实例状态。 |
| `ELECTROSPHERE_HOST` | `127.0.0.1` | 监听地址，必须为回环地址。 |
| `ELECTROSPHERE_PORT` | `8787` | 监听端口。 |
| `ELECTROSPHERE_DEFAULT_BACKEND` | `docker` | Durable turn 未指定 `backend` 时使用的后端。 |
| `ELECTROSPHERE_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker 守护进程 socket 路径。 |
| `ELECTROSPHERE_FIRECRACKER_BIN` | — | Firecracker 二进制路径。 |
| `ELECTROSPHERE_JAILER_BIN` | — | jailer 二进制路径。 |
| `ELECTROSPHERE_AGENT_ARTIFACT` | — | 预编译 agent 二进制路径。 |
| `ELECTROSPHERE_RUNTIME_IMAGE` | — | 沙箱容器的 Docker 镜像名。 |
| `ELECTROSPHERE_FIRECRACKER_KERNEL` | — | Firecracker VM 的 Linux 内核路径。 |
| `ELECTROSPHERE_FIRECRACKER_ROOTFS` | — | Firecracker VM 的根文件系统路径。 |
| `ELECTROSPHERE_MAX_OUTPUT_BYTES` | `1048576` | 单次执行的最大输出字节数（默认 1 MiB）。 |
| `ELECTROSPHERE_AUTH_TOKEN` | — | Harness 路由和 MCP 请求必须使用的 Bearer token。`/healthz` 不需要认证。 |

## 运行

```bash
# 开发模式（自动重载）
ELECTROSPHERE_DATA_DIR=/tmp/electrosphere bun run dev

# 生产模式
ELECTROSPHERE_DATA_DIR=/var/lib/electrosphere bun run start
```

启动成功后，守护进程输出监听地址：

```
electrosphere listening on http://127.0.0.1:8787
```

## API

### REST 端点

| 方法 | 路径 | 功能 |
|------|------|------|
| `GET` | `/healthz` | 返回存储和后端探测状态。 |
| `POST` | `/v1/harness/threads/:threadId/turns/:turnId` | 启动 Instant 或 Durable turn。 |
| `POST` | `/v1/harness/threads/:threadId/turns/:turnId/finish` | 结束 turn。Durable 模式发布 commit；Instant 模式只销毁 runtime。 |
| `POST` | `/v1/harness/threads/:sourceThreadId/forks/:destinationThreadId` | 从 Durable thread 当前 head 或 main 历史中的 commit 创建 fork。 |

启动请求 body 为 `{ "mode": "instant" | "durable", "backend"?: "docker" | "firecracker", "network"?, "resourceProfile"? }`。

- Instant 模式支持两个后端。未指定 `backend` 时使用 Firecracker。
- Durable 模式未指定 `backend` 时使用 `ELECTROSPHERE_DEFAULT_BACKEND`。
- Harness 必须在 `finally` 中调用 `finish`。

### MCP 工具

`/mcp` 端点按以下顺序暴露工具：

`shell`、`read`、`write`、`edit`、`glob`、`grep`、`move`、`remove`、`artifact_export`、`artifact_materialize`。

每个 `tools/call` 请求必须包含 `Authorization`、`Electrosphere-Thread-Id` 和 `Electrosphere-Turn-Id`。模型不能通过工具参数选择 thread、workspace、commit、backend 或 runtime。

## 开发

```bash
# 类型检查
bun run typecheck

# 运行测试
bun test

# 生成数据库迁移
bun run db:generate
```

## 项目结构

```
src/
├── daemon/          HTTP 服务、配置、启动逻辑
├── domain/          核心业务逻辑（SandboxService、SessionManager）
├── backends/        Docker 和 Firecracker 后端实现
├── storage/         SQLite schema、CFS、仓库层
└── mcp/             MCP 服务（shell 工具）
agent/               Rust 沙箱内 agent
runtime/             容器镜像定义
test/                集成和单元测试
drizzle/             数据库迁移文件
```

## 许可证

私有项目。
