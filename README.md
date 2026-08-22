# Electrosphere

[中文文档](README-ZH.md)

Electrosphere is a local sandbox orchestration daemon for AI coding agents. A trusted harness controls thread and turn lifecycles. Models receive only shell, file, search, and artifact tools for the runtime bound to the current turn.

Electrosphere supports Docker containers and Firecracker microVMs. It stores Durable workspace history as content-addressed CFS snapshots and commit chains in SQLite.

## Architecture

```text
Trusted harness
  ├─ POST /v1/harness/.../turns/...          start turn
  ├─ POST /v1/harness/.../turns/.../finish   finish turn
  └─ POST /v1/harness/.../forks/...          fork Durable thread
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Electrosphere daemon (Bun)                                  │
│                                                             │
│ Auth gate ─ TurnService ─ SessionManager ─ MCP tools         │
│                    │                                        │
│              SandboxService                                 │
│              ├─ Docker backend ─ Unix socket ─ Rust agent   │
│              └─ Firecracker ─ vsock ──────── Rust agent     │
│                    │                                        │
│       SQLite metadata + content-addressed CFS + artifacts   │
└─────────────────────────────────────────────────────────────┘
```

The Rust guest agent enforces workspace-relative paths. It uses `openat2` on Linux, atomic file replacement, bounded regex execution, chunked file transfer, and chunked CFS snapshots.

## Runtime Modes

### Instant

An Instant turn creates a clean runtime from the canonical empty commit.

- The harness can select `docker` or `firecracker`.
- If `backend` is absent, Instant uses Firecracker.
- Calls in one turn reuse the same runtime.
- `finish` destroys the runtime.
- Instant never creates, reads, or updates a thread workspace.
- Files do not persist into the next turn.

### Durable

A Durable thread owns one persistent workspace and its `main` ref.

- Turn start materializes the current head commit into a temporary runtime.
- Calls in one turn reuse the same runtime.
- Turn finish closes active sessions, creates a CFS snapshot, publishes a new commit, advances `main` with compare-and-swap, and destroys the runtime.
- A turn with no file changes still produces a new commit whose parent is the prior head.
- `ELECTROSPHERE_DEFAULT_BACKEND` selects the backend when the request omits `backend`.

The harness must call `finish` in a `finally` block. A daemon crash is the only case in which an active Durable turn does not publish a commit. Recovery marks interrupted turns as failed and does not fabricate commits.

## Security Boundary

- The daemon only accepts loopback listen addresses.
- Harness routes and MCP requests require `Authorization: Bearer <token>`.
- `tools/call` also requires trusted `Electrosphere-Thread-Id` and `Electrosphere-Turn-Id` headers.
- The model cannot select a thread, workspace, commit, backend, instance, or runtime through tool arguments.
- Artifact access is granted per thread. A different thread receives `NOT_FOUND`, even when it knows the digest.
- Workspace paths reject absolute paths outside `/workspace`, NUL bytes, empty components, `.` components, and `..` components.
- `/healthz` is the only unauthenticated endpoint.

## Prerequisites

### Common

- Linux x86_64
- [Bun](https://bun.sh/)
- Rust toolchain with the `x86_64-unknown-linux-musl` target
- Clang for the static PCRE2 build used by the guest agent

```bash
rustup target add x86_64-unknown-linux-musl
```

### Docker backend

- Docker daemon
- Access to the Docker socket
- An immutable runtime image ID or `image@sha256` reference

### Firecracker backend

- `/dev/kvm` access
- Matching Firecracker and jailer binaries
- A Linux kernel image
- An ext4 root filesystem image
- cgroup v2 with `cpu`, `io`, `memory`, and `pids` controllers
- Permission to create the Electrosphere cgroup and jailer files; the current implementation normally runs the daemon as root for Firecracker

## Build

```bash
bun install
bun run agent:build

docker build -f runtime/Dockerfile -t electrosphere-runtime:local .
docker image inspect electrosphere-runtime:local --format '{{.Id}}'
```

`bun run agent:build` uses `.cargo/config.toml` to select Clang for the musl C dependency. Environment variables can override this compiler configuration.

## Configuration

Electrosphere reads environment variables at startup.

| Variable | Default | Description |
|---|---:|---|
| `ELECTROSPHERE_DATA_DIR` | required | Absolute directory for SQLite metadata, CFS objects, artifacts, staging files, and runtime state. |
| `ELECTROSPHERE_HOST` | `127.0.0.1` | Listen address. It must be `127.0.0.1`, `localhost`, or `::1`. |
| `ELECTROSPHERE_PORT` | `8787` | Listen port. |
| `ELECTROSPHERE_AUTH_TOKEN` | none | Bearer token required for harness routes and MCP. |
| `ELECTROSPHERE_DEFAULT_BACKEND` | `docker` | Default backend for Durable turns. |
| `ELECTROSPHERE_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker daemon socket. |
| `ELECTROSPHERE_RUNTIME_IMAGE` | none | Immutable Docker image ID or `image@sha256` reference. |
| `ELECTROSPHERE_FIRECRACKER_BIN` | none | Firecracker binary. |
| `ELECTROSPHERE_JAILER_BIN` | none | Jailer binary. |
| `ELECTROSPHERE_AGENT_ARTIFACT` | none | Static `electrosphere-agent` binary. |
| `ELECTROSPHERE_FIRECRACKER_KERNEL` | none | Firecracker kernel image. |
| `ELECTROSPHERE_FIRECRACKER_ROOTFS` | none | Firecracker ext4 root filesystem. |
| `ELECTROSPHERE_MAX_OUTPUT_BYTES` | `1048576` | Maximum buffered command output. Range: 1 KiB to 16 MiB. |

Example `.env`:

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

Protect the file before use:

```bash
chmod 600 .env
```

Start Docker-only development mode as a user that can access the Docker socket:

```bash
set -a
source .env
set +a
bun run start
```

Firecracker requires the KVM, cgroup, filesystem, and jailer permissions listed above. Run the daemon with an account that has those permissions.

## Harness API

### Health

```text
GET /healthz
```

The response reports SQLite readiness and the Docker and Firecracker preflight results. This endpoint does not require authentication.

### Start a turn

```text
POST /v1/harness/threads/:threadId/turns/:turnId
Authorization: Bearer <token>
Content-Type: application/json
```

Request body:

```json
{
  "mode": "instant",
  "backend": "docker",
  "network": "none"
}
```

`mode` is `instant` or `durable`. `backend` is `docker` or `firecracker`. `network` is `none` or `egress`. A request can also include a complete `resourceProfile`.

`resourceProfile` contains `memoryMiB`, `vcpus`, `diskMiB`, `pidsMax`, and `timeoutMs`. The `egress` network profile requires an installed host network policy. Without that policy, the backend returns `BACKEND_UNAVAILABLE`.

### Finish a turn

```text
POST /v1/harness/threads/:threadId/turns/:turnId/finish
Authorization: Bearer <token>
```

The request body must be empty.

### Fork a Durable thread

```text
POST /v1/harness/threads/:sourceThreadId/forks/:destinationThreadId
Authorization: Bearer <token>
Content-Type: application/json
```

Use `{}` to fork the current head. Use `{ "commitId": "sha256:..." }` to fork a commit in the source thread's `main` history. The source thread must not have an active turn.

## MCP

The MCP endpoint is:

```text
POST /mcp
```

`initialize`, `server/discover`, and `tools/list` require the Bearer token. `tools/call` also requires these headers:

```text
Electrosphere-Thread-Id: <thread-id>
Electrosphere-Turn-Id: <turn-id>
```

Electrosphere exposes these tools in order:

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

The file tools always use the current turn runtime. `read` supports text lines, multiple ranges, raw bytes, directory listings, and `artifact://sha256:...` URIs. `edit` requires the digest returned by `read` and returns `HEAD_CONFLICT` when the file changed.

`artifact_export` streams a regular workspace file into the content-addressed artifact store. `artifact_materialize` streams a thread-granted artifact into the current workspace.

### OMP configuration

Create `.mcp.json` in the OMP working directory:

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

Create a new MCP client or update the turn header for each turn. Do not put thread or turn IDs in model tool arguments.

## Development

```bash
bun run db:generate
bun run db:check
bun run typecheck
bun test
cargo test --manifest-path agent/Cargo.toml
bun run agent:build
```

The Docker integration test runs when `ELECTROSPHERE_RUNTIME_IMAGE` is set.

## Project Structure

```text
src/
├── daemon/          configuration, HTTP trust boundary, startup, shutdown
├── domain/          turn, sandbox, session, and recovery services
├── backends/        Docker, Firecracker, agent transport, file transport
├── storage/         SQLite repository, schema, CFS, artifacts, migrations
└── mcp/             bound-turn model tools
agent/               Rust guest agent and file isolation
runtime/             Docker runtime image
test/                unit, contract, recovery, and integration tests
drizzle/             generated SQLite migrations
```

## License

Electrosphere is licensed under the [MIT License](LICENSE).
