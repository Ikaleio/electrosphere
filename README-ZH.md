# Electrosphere

[English](README.md)

Electrosphere 是面向 AI 编程代理的本地沙箱编排守护进程。可信 harness 管理 thread 和 turn 生命周期。模型只能使用当前 turn 绑定 runtime 的 shell、文件、搜索和 artifact 工具。

Electrosphere 支持 Docker 容器和 Firecracker 微虚拟机。Durable 工作区历史保存为内容寻址的 CFS 快照和 SQLite commit 链。

## 架构

```text
可信 harness
  ├─ POST /v1/harness/.../turns/...          启动 turn
  ├─ POST /v1/harness/.../turns/.../finish   结束 turn
  └─ POST /v1/harness/.../forks/...          fork Durable thread
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Electrosphere daemon（Bun）                                 │
│                                                             │
│ 鉴权 ─ TurnService ─ SessionManager ─ MCP 工具               │
│                    │                                        │
│              SandboxService                                 │
│              ├─ Docker backend ─ Unix socket ─ Rust agent   │
│              └─ Firecracker ─ vsock ──────── Rust agent     │
│                    │                                        │
│       SQLite 元数据 + 内容寻址 CFS + artifact store          │
└─────────────────────────────────────────────────────────────┘
```

Rust guest agent 强制使用工作区相对路径。它在 Linux 上使用 `openat2`，并实现原子文件替换、受限正则表达式、分块文件传输和分块 CFS 快照。

## Runtime 模式

### Instant

Instant turn 从 canonical empty commit 创建一个全新 runtime。

- Harness 可选择 `docker` 或 `firecracker`。
- 未指定 `backend` 时，Instant 使用 Firecracker。
- 同一 turn 内的调用复用同一个 runtime。
- `finish` 只销毁 runtime。
- Instant 不创建、不读取、也不更新 thread 工作区。
- 文件不会保留到下一 turn。

### Durable

Durable thread 独占一个持久工作区及其 `main` ref。

- Turn 开始时，将当前 head commit 物化到临时 runtime。
- 同一 turn 内的调用复用同一个 runtime。
- Turn 结束时，系统关闭活动 session、创建 CFS 快照、发布新 commit、通过 compare-and-swap 更新 `main`，然后销毁 runtime。
- 即使文件没有变化，turn 结束时也会创建一个 parent 指向旧 head 的新 commit。
- 请求未指定 `backend` 时，系统使用 `ELECTROSPHERE_DEFAULT_BACKEND`。

Harness 必须在 `finally` 中调用 `finish`。只有 daemon 崩溃时，活动 Durable turn 才不会发布 commit。Recovery 会将中断的 turn 标记为失败，且不会伪造 commit。

## 安全边界

- Daemon 只接受回环监听地址。
- Harness 路由和 MCP 请求必须包含 `Authorization: Bearer <token>`。
- `tools/call` 还必须包含可信的 `Electrosphere-Thread-Id` 和 `Electrosphere-Turn-Id` header。
- 模型不能通过工具参数选择 thread、workspace、commit、backend、instance 或 runtime。
- Artifact grant 以 thread 为作用域。其他 thread 即使知道 digest，也只会收到 `NOT_FOUND`。
- 工作区路径拒绝 `/workspace` 外的绝对路径、NUL、空组件、`.` 组件和 `..` 组件。
- `/healthz` 是唯一不需要鉴权的端点。

## 前置条件

### 通用

- Linux x86_64
- [Bun](https://bun.sh/)
- Rust 工具链及 `x86_64-unknown-linux-musl` target
- Clang，用于编译 guest agent 的静态 PCRE2 依赖

```bash
rustup target add x86_64-unknown-linux-musl
```

### Docker backend

- Docker daemon
- Docker socket 访问权限
- 不可变 Docker image ID 或 `image@sha256` 引用

### Firecracker backend

- `/dev/kvm` 访问权限
- 版本匹配的 Firecracker 和 jailer
- Linux kernel image
- ext4 root filesystem image
- 启用 `cpu`、`io`、`memory` 和 `pids` controller 的 cgroup v2
- 创建 Electrosphere cgroup 和 jailer 文件的权限；当前实现通常以 root 运行 Firecracker daemon

## 构建

```bash
bun install
bun run agent:build

docker build -f runtime/Dockerfile -t electrosphere-runtime:local .
docker image inspect electrosphere-runtime:local --format '{{.Id}}'
```

`bun run agent:build` 通过 `.cargo/config.toml` 为 musl C 依赖选择 Clang。环境变量可以覆盖该编译器配置。

## 配置

Electrosphere 启动时读取环境变量。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ELECTROSPHERE_DATA_DIR` | 必填 | SQLite 元数据、CFS 对象、artifact、staging 文件和 runtime 状态的绝对目录。 |
| `ELECTROSPHERE_HOST` | `127.0.0.1` | 监听地址。只能是 `127.0.0.1`、`localhost` 或 `::1`。 |
| `ELECTROSPHERE_PORT` | `8787` | 监听端口。 |
| `ELECTROSPHERE_AUTH_TOKEN` | 无 | Harness 路由和 MCP 必须使用的 Bearer token。 |
| `ELECTROSPHERE_DEFAULT_BACKEND` | `docker` | Durable turn 的默认 backend。 |
| `ELECTROSPHERE_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker daemon socket。 |
| `ELECTROSPHERE_RUNTIME_IMAGE` | 无 | 不可变 Docker image ID 或 `image@sha256` 引用。 |
| `ELECTROSPHERE_FIRECRACKER_BIN` | 无 | Firecracker 二进制文件。 |
| `ELECTROSPHERE_JAILER_BIN` | 无 | Jailer 二进制文件。 |
| `ELECTROSPHERE_AGENT_ARTIFACT` | 无 | 静态链接的 `electrosphere-agent`。 |
| `ELECTROSPHERE_FIRECRACKER_KERNEL` | 无 | Firecracker kernel image。 |
| `ELECTROSPHERE_FIRECRACKER_ROOTFS` | 无 | Firecracker ext4 root filesystem。 |
| `ELECTROSPHERE_MAX_OUTPUT_BYTES` | `1048576` | 命令输出缓冲区上限。范围为 1 KiB 到 16 MiB。 |

`.env` 示例：

```bash
ELECTROSPHERE_DATA_DIR=/var/lib/electrosphere
ELECTROSPHERE_HOST=127.0.0.1
ELECTROSPHERE_PORT=8787
ELECTROSPHERE_AUTH_TOKEN=replace-with-a-random-token
ELECTROSPHERE_DEFAULT_BACKEND=docker
ELECTROSPHERE_DOCKER_SOCKET=/var/run/docker.sock
ELECTROSPHERE_RUNTIME_IMAGE=sha256:replace-with-image-id

ELECTROSPHERE_FIRECRACKER_BIN=/opt/electrosphere/firecracker/firecracker
ELECTROSPHERE_JAILER_BIN=/opt/electrosphere/firecracker/jailer
ELECTROSPHERE_AGENT_ARTIFACT=/path/to/electrosphere-agent
ELECTROSPHERE_FIRECRACKER_KERNEL=/opt/electrosphere/firecracker/vmlinux
ELECTROSPHERE_FIRECRACKER_ROOTFS=/opt/electrosphere/firecracker/rootfs.ext4
```

使用前保护该文件：

```bash
chmod 600 .env
```

如果当前用户可以访问 Docker socket，可直接启动 Docker 模式：

```bash
set -a
source .env
set +a
bun run start
```

Firecracker 需要前文列出的 KVM、cgroup、文件系统和 jailer 权限。请使用具备这些权限的账号运行 daemon。

## Harness API

### Health

```text
GET /healthz
```

响应包含 SQLite readiness 以及 Docker 和 Firecracker 的 preflight 结果。该端点不需要鉴权。

### 启动 turn

```text
POST /v1/harness/threads/:threadId/turns/:turnId
Authorization: Bearer <token>
Content-Type: application/json
```

请求 body：

```json
{
  "mode": "instant",
  "backend": "docker",
  "network": "none"
}
```

`mode` 为 `instant` 或 `durable`。`backend` 为 `docker` 或 `firecracker`。`network` 为 `none` 或 `egress`。请求也可包含完整的 `resourceProfile`。

`resourceProfile` 包含 `memoryMiB`、`vcpus`、`diskMiB`、`pidsMax` 和 `timeoutMs`。`egress` network profile 需要已安装的 host network policy。缺少该 policy 时，backend 返回 `BACKEND_UNAVAILABLE`。

### 结束 turn

```text
POST /v1/harness/threads/:threadId/turns/:turnId/finish
Authorization: Bearer <token>
```

请求 body 必须为空。

### Fork Durable thread

```text
POST /v1/harness/threads/:sourceThreadId/forks/:destinationThreadId
Authorization: Bearer <token>
Content-Type: application/json
```

使用 `{}` fork 当前 head。使用 `{ "commitId": "sha256:..." }` fork source thread 的 `main` 历史中的 commit。Source thread 不能有活动 turn。

## MCP

MCP 端点为：

```text
POST /mcp
```

`initialize`、`server/discover` 和 `tools/list` 必须包含 Bearer token。`tools/call` 还必须包含：

```text
Electrosphere-Thread-Id: <thread-id>
Electrosphere-Turn-Id: <turn-id>
```

Electrosphere 按以下顺序暴露工具：

1. `shell`
2. `read`
3. `write`
4. `edit`
5. `glob`
6. `grep`
7. `move`
8. `remove`
9. `artifact_export`
10. `artifact_materialize`

文件工具始终操作当前 turn runtime。`read` 支持文本行、多范围、raw bytes、目录 listing 和 `artifact://sha256:...` URI。`edit` 必须使用 `read` 返回的 digest；文件已变化时返回 `HEAD_CONFLICT`。

`artifact_export` 将普通工作区文件流式写入内容寻址 artifact store。`artifact_materialize` 将当前 thread 已授权的 artifact 流式写入工作区。

### OMP 配置

在 OMP 工作目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "electrosphere": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "timeout": 30000,
      "headers": {
        "Authorization": "Bearer replace-with-token",
        "Electrosphere-Thread-Id": "example-thread",
        "Electrosphere-Turn-Id": "turn-1"
      }
    }
  }
}
```

每个 turn 必须创建新的 MCP client，或更新 turn header。不要将 thread ID 或 turn ID 放入模型工具参数。

## 开发

```bash
bun run db:generate
bun run db:check
bun run typecheck
bun test
cargo test --manifest-path agent/Cargo.toml
bun run agent:build
```

设置 `ELECTROSPHERE_RUNTIME_IMAGE` 后，测试套件会运行 Docker integration test。

## 项目结构

```text
src/
├── daemon/          配置、HTTP 信任边界、启动和停止
├── domain/          turn、sandbox、session 和 recovery 服务
├── backends/        Docker、Firecracker、agent transport、文件传输
├── storage/         SQLite repository、schema、CFS、artifact、migration
└── mcp/             绑定当前 turn 的模型工具
agent/               Rust guest agent 和文件隔离
runtime/             Docker runtime image
test/                单元、契约、recovery 和 integration 测试
drizzle/             生成的 SQLite migration
```

## 许可证

Electrosphere 使用 [MIT License](LICENSE)。
