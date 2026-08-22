# Electrosphere

A sandbox orchestration daemon for AI coding agents. Electrosphere creates isolated execution environments (Docker containers or Firecracker microVMs), runs shell commands inside them, and manages workspace state through content-addressed snapshots.

## Architecture

```
┌────────────────────────────────────────────────┐
│                   Daemon (Bun)                  │
├────────────┬───────────────┬───────────────────┤
│  REST API  │  MCP Server   │  Session Manager  │
├────────────┴───────────────┴───────────────────┤
│               Sandbox Service                   │
├─────────────────────┬──────────────────────────┤
│   Docker Backend    │   Firecracker Backend    │
└─────────────────────┴──────────────────────────┘
         │                        │
    ┌────┴────┐             ┌────┴────┐
    │Container│             │ microVM │
    │  Agent  │             │  Agent  │
    └─────────┘             └─────────┘
```

The daemon runs on Bun and exposes two interfaces:

- **REST API** on `/v1/*` for workspace and instance lifecycle operations.
- **MCP endpoint** on `/mcp` for AI agent tool use (the `shell` tool).

Each sandbox runs a statically-linked Rust agent (`electrosphere-agent`) that executes commands and reports results over a Unix socket or vsock.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Thread** | A harness-owned sequence of turns. A Durable thread owns one persistent workspace. |
| **Turn** | One harness-controlled runtime lifetime. Tools can only access the runtime bound to the current turn. |
| **Instant mode** | Creates a clean runtime for each turn. It never reads or writes a thread workspace. The harness can select `docker` or `firecracker`; the default is `firecracker`. |
| **Durable mode** | Materializes the thread head commit at turn start and publishes a new commit at turn finish. |
| **Backend** | The isolation technology: `docker` or `firecracker`. |
| **Commit** | An immutable content-addressed CFS snapshot of a workspace tree. |

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- Docker (for the `docker` backend)
- Firecracker + jailer (for the `firecracker` backend, optional)
- Rust toolchain with `x86_64-unknown-linux-musl` target (to build the agent)

## Setup

```bash
# Install dependencies
bun install

# Build the in-guest agent
bun run agent:build

# Build the runtime container image (Docker backend)
docker build -t electrosphere-runtime -f runtime/Dockerfile .
```

## Configuration

All configuration uses environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ELECTROSPHERE_DATA_DIR` | *(required)* | Absolute path for SQLite database, CFS objects, and instance state. |
| `ELECTROSPHERE_HOST` | `127.0.0.1` | Listen address. Must be a loopback address. |
| `ELECTROSPHERE_PORT` | `8787` | Listen port. |
| `ELECTROSPHERE_DEFAULT_BACKEND` | `docker` | Backend for Durable turns when the start request omits `backend`. |
| `ELECTROSPHERE_DOCKER_SOCKET` | `/var/run/docker.sock` | Path to the Docker daemon socket. |
| `ELECTROSPHERE_FIRECRACKER_BIN` | — | Path to the Firecracker binary. |
| `ELECTROSPHERE_JAILER_BIN` | — | Path to the jailer binary. |
| `ELECTROSPHERE_AGENT_ARTIFACT` | — | Path to the prebuilt agent binary. |
| `ELECTROSPHERE_RUNTIME_IMAGE` | — | Docker image name for sandbox containers. |
| `ELECTROSPHERE_FIRECRACKER_KERNEL` | — | Path to the Linux kernel for Firecracker VMs. |
| `ELECTROSPHERE_FIRECRACKER_ROOTFS` | — | Path to the root filesystem for Firecracker VMs. |
| `ELECTROSPHERE_MAX_OUTPUT_BYTES` | `1048576` | Maximum output bytes per execution (1 MiB default). |
| `ELECTROSPHERE_AUTH_TOKEN` | — | Bearer token required by harness routes and MCP requests. `/healthz` does not require it. |

## Run

```bash
# Development (auto-reload)
ELECTROSPHERE_DATA_DIR=/tmp/electrosphere bun run dev

# Production
ELECTROSPHERE_DATA_DIR=/var/lib/electrosphere bun run start
```

The daemon logs its listen address on startup:

```
electrosphere listening on http://127.0.0.1:8787
```

## API

### REST Endpoints

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/healthz` | Return storage and backend probe status. |
| `POST` | `/v1/harness/threads/:threadId/turns/:turnId` | Start an Instant or Durable turn. |
| `POST` | `/v1/harness/threads/:threadId/turns/:turnId/finish` | Finish the turn. Durable mode publishes a commit; Instant mode only destroys the runtime. |
| `POST` | `/v1/harness/threads/:sourceThreadId/forks/:destinationThreadId` | Fork a Durable thread from its current head or a commit in its main history. |

The start body is `{ "mode": "instant" | "durable", "backend"?: "docker" | "firecracker", "network"?, "resourceProfile"? }`.

- Instant mode accepts both backends. If `backend` is absent, it uses Firecracker.
- Durable mode uses `ELECTROSPHERE_DEFAULT_BACKEND` when `backend` is absent.
- The harness must call `finish` in a `finally` block.

### MCP Tools

The `/mcp` endpoint exposes these tools in order:

`shell`, `read`, `write`, `edit`, `glob`, `grep`, `move`, `remove`, `artifact_export`, `artifact_materialize`.

Every `tools/call` request must include `Authorization`, `Electrosphere-Thread-Id`, and `Electrosphere-Turn-Id`. The model cannot select a thread, workspace, commit, backend, or runtime through tool arguments.

## Development

```bash
# Type check
bun run typecheck

# Run tests
bun test

# Generate database migrations
bun run db:generate
```

## Project Structure

```
src/
├── daemon/          HTTP server, config, startup
├── domain/          Core business logic (SandboxService, SessionManager)
├── backends/        Docker and Firecracker backend implementations
├── storage/         SQLite schema, CFS, repository
└── mcp/             MCP server (shell tool)
agent/               Rust in-guest agent
runtime/             Container image definition
test/                Integration and unit tests
drizzle/             Database migrations
```

## License

Private.
