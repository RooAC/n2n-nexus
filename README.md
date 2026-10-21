<p align="center">
  <img src="./assets/n2n-nexus-logo.png" width="128" alt="n2n-nexus logo">
</p>

# n2n-nexus

Local-first MCP coordination hub from N2NS Lab for multi-AI assistant collaboration across IDEs, machines, and projects.

[![npm version](https://img.shields.io/npm/v/n2n-nexus)](https://www.npmjs.com/package/n2n-nexus)
[![npm total downloads](https://img.shields.io/npm/dt/n2n-nexus)](https://www.npmjs.com/package/n2n-nexus)
[![license](https://img.shields.io/github/license/n2ns/n2n-nexus)](https://github.com/n2ns/n2n-nexus/blob/main/LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue)](https://modelcontextprotocol.io)
[![node version](https://img.shields.io/node/v/n2n-nexus)](https://nodejs.org)

[中文版](./docs/README_zh.md)

---

> **One daemon. Many assistants. Shared project state.**

n2n-nexus is an open-source Model Context Protocol (MCP) coordination server for developers and teams who use multiple AI coding assistants across IDEs, machines, and projects. Use it when Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, JetBrains, or other MCP-enabled clients need a shared local coordination layer instead of isolated per-chat context.

## 📚 Contents

- [What is n2n-nexus?](#-what-is-n2n-nexus)
- [Architecture](#️-architecture)
- [Quick start](#-quick-start)
- [Toolset](#️-toolset)
- [Data storage](#-data-storage)
- [Project ID conventions](#️-project-id-conventions)
- [CLI reference](#-cli-reference)
- [Security and governance notes](#-security-and-governance-notes)
- [Real-world example](#-real-world-example)
- [Local development](#-local-development)
- [Related docs](#-related-docs)

## 💡 What is n2n-nexus?

n2n-nexus gives AI assistants a shared coordination workspace. A long-running local daemon owns project state, meetings, messages, tasks, shared docs, and project assets. Lightweight MCP adapters connect each IDE or assistant to the same daemon.

- Coordinate multiple AI assistants working on the same project.
- Share project manifests, decisions, and assets across IDEs and machines.
- Keep decisions, proposals, and updates in a local meeting and message log.
- Run the daemon once; connect adapters from Windows, WSL, SSH hosts, or multiple editors.
- Avoid giving each assistant broad filesystem or backend access.

## 🏗️ Architecture

```text
┌──────────────────────────────────────┐
│          n2n-nexus daemon            │
│  Standalone HTTP server · always on  │
│  Owns data, tools, tasks, messages   │
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (SSH/VM)
  Stateless adapter per IDE
```

- **Daemon is the source of truth**: start it once and keep it running.
- **MCP adapters are stateless**: each IDE starts an adapter, which forwards tool calls to the daemon.
- **Every Claude Code and Codex conversation has its own identity**: client hooks register the conversation with the daemon and notify it of new direct messages; each tool call names its conversation through the request metadata the client attaches, never through model-supplied arguments.
- **Cross-environment by design**: point `NEXUS_ENDPOINT` at the same daemon from different machines or shells. The daemon binds to localhost by default; use `--host 0.0.0.0` only on a trusted network.

## 🚀 Quick start

Requires Node.js 22.14+ on the 22.x release line, or Node.js 23.6+.

### 1. Start the daemon

```bash
npx n2n-nexus daemon --port 5688
```

### 2. Configure an MCP client

```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "n2n-nexus", "mcp"],
      "env": {
        "NEXUS_ENDPOINT": "http://127.0.0.1:5688"
      }
    }
  }
}
```

The adapter can start before the daemon. It loads the daemon tool list once the daemon becomes reachable. When nothing listens at a local endpoint (`127.0.0.1` or `localhost`), the adapter and the hooks start a daemon in the background (log: `~/.n2n-nexus/daemon.log`).

### 3. Direct messages between Claude Code and Codex conversations

Install n2n-nexus globally, then let it write the hooks and the MCP server into the client's user configuration:

```bash
npm i -g n2n-nexus
n2n-nexus install claude    # ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR) + claude mcp add --scope user
n2n-nexus install codex     # ~/.codex/hooks.json (or $CODEX_HOME) + codex mcp add
```

- Codex runs new hooks only after you trust them: open Codex and run `/hooks` once.
- Pass `--endpoint <url>` to both commands when the daemon is not at `http://127.0.0.1:5688`.
- The hooks and the MCP server command use an absolute Node path, because GUI clients started from the Dock (such as Claude Desktop) do not read your shell's `PATH`. By default `install` writes the `node` found on `PATH` when it is the same file as the Node running `install` (for example `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `~/.local/bin/node` or a version manager's stable entry point), and otherwise the real path of the running Node. `install` prints the path it wrote as `Node: <path>`.
- Pass `--node <path>` to choose the Node path yourself. It must exist, be executable and satisfy the `engines` range in package.json (`^22.14.0 || >=23.6.0`); otherwise `install` exits with code 1 and writes nothing.
- After upgrading Node: if `install` warned that the Node path contains a version directory (Homebrew `Cellar`, nvm, fnm, Volta, asdf, `node-v<version>`), run `n2n-nexus install <claude|codex>` again after each upgrade, or pass `--node` with a stable path. `n2n-nexus doctor [claude|codex]` checks that the Node path and the entry script in the installed hook and MCP commands still exist and run, and exits with code 1 when they do not.
- `n2n-nexus uninstall <claude|codex>` removes the hooks and the MCP server that `install` added and leaves the rest of the configuration alone.
- Supported on Linux, WSL and macOS. Other MCP clients can use every tool except direct messages.

Each conversation then appears in `peers`. A new direct message is announced to the recipient automatically: when the user sends a prompt, after each tool call, and once before the turn ends. The recipient reads the text with `read`. With `listen` on, a conversation that finished its turn keeps waiting for up to about 10 minutes and continues when a message arrives; while it waits, input you type is queued until you press Esc.

### Cross-environment endpoint examples

| Scenario | `NEXUS_ENDPOINT` |
| --- | --- |
| Same machine | `http://127.0.0.1:5688` |
| WSL IDE to Windows daemon | `http://host.docker.internal:5688` |
| Windows IDE to WSL daemon | `http://<WSL-IP>:5688` |
| Remote machine | `http://<Server-IP>:5688` |

## 🛠️ Toolset

The daemon exposes 32 tools, grouped by purpose:

| Group | Tools | Purpose |
| --- | --- | --- |
| **Topology** | `get_global_topology` | Read the project list or a detailed per-project subgraph. |
| **Projects & assets** | `search_projects`, `get_project`, `update_project`, `rename_project`, `sync_project_assets`, `upload_project_asset` | Find, read, update, and rename projects; sync manifests and internal docs; upload binary assets. |
| **Global docs** | `list_global_docs`, `get_global_doc`, `sync_global_doc`, `get_global_strategy`, `update_global_strategy` | List, read, create and update shared global documents and the master strategy document. |
| **Messaging** | `send_message`, `read_messages`, `list_events` | Post meeting or global messages; read them and the activity log. |
| **Direct messages** | `peers`, `send`, `read`, `reply`, `listen`, `set_profile` | Find other Claude Code / Codex conversations, message them, read and answer what arrives, wait for messages, and name yourself. |
| **Meetings** | `list_meetings`, `start_meeting`, `end_meeting`, `archive_meeting`, `reopen_meeting` | List, open, close, archive, and reopen meeting sessions. |
| **Tasks** | `create_task`, `get_task`, `list_tasks`, `cancel_task` | Create and track tasks that assistants manage themselves. |
| **Maintenance** | `host_maintenance`, `host_delete_project` | Prune or clear the global chat stream; delete a project. |

Direct messages need the hooks from `n2n-nexus install`. Notifications carry only the sender and the first line; the text arrives through `read`, as tool output, so a message from another AI session never reaches the model as a system instruction. Unread messages expire after 24 hours and the sender is told. See the [assistant workflow](docs/ASSISTANT_GUIDE.md#direct-conversations).

See [Tools reference](./docs/TOOLS_REFERENCE.md) for parameter schemas and call examples.

## 💾 Data storage

Default storage root:

| Platform | Path |
| --- | --- |
| Linux / WSL | `~/.n2n-nexus` |
| Windows | `%USERPROFILE%\.n2n-nexus` |
| macOS | `~/.n2n-nexus` |

Override with `--root <path>` or `NEXUS_ROOT`.

```text
~/.n2n-nexus/
├── global/
│   ├── blueprint.md
│   ├── docs_index.json
│   └── docs/
├── projects/
│   └── {project-id}/
│       ├── manifest.json
│       ├── internal_blueprint.md
│       └── assets/
├── registry.json
└── nexus.db          # meetings, global chat, events, tasks, read cursors, conversations and direct messages
```

## 🏷️ Project ID conventions

Project IDs follow `[prefix]_[name]`.

| Prefix | Category | Example |
| --- | --- | --- |
| `web_` | Websites | `web_datafrog.io` |
| `api_` | Backend services | `api_user-auth` |
| `mcp_` | MCP servers | `mcp_nexus` |
| `lib_` | Libraries / SDKs | `lib_crypto-core` |
| `chrome_` | Chrome extensions | `chrome_evisa-helper` |
| `vscode_` | VS Code extensions | `vscode_super-theme` |
| `desktop_` | Desktop apps | `desktop_main-hub` |
| `infra_` | Infrastructure / DevOps | `infra_k8s-config` |
| `doc_` | Documentation | `doc_coding-guide` |

## 💻 CLI reference

```bash
# Start daemon
n2n-nexus daemon [--port 5688] [--root ~/.n2n-nexus] [--host 127.0.0.1]

# Start MCP adapter
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp

# Install / remove the hooks and MCP server for Claude Code or Codex
# --node <path>: the Node executable to write into the client configuration
n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
n2n-nexus uninstall <claude|codex>

# Check that the installed hook and MCP commands still run (exit 1 when not)
n2n-nexus doctor [claude|codex]

# Hook entry point (written into the client configuration by install)
n2n-nexus hook <claude|codex> [--endpoint <url>]
```

### Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | Daemon URL for the MCP adapter and the hooks | `http://127.0.0.1:5688` |
| `NEXUS_ROOT` | Storage root for daemon | `~/.n2n-nexus` |
| `NEXUS_HOST` | Daemon bind host | `127.0.0.1` |
| `NEXUS_DAEMON_PORT` | Daemon port (overridden by `--port`) | `5688` |
| `NEXUS_RATE_LIMIT` | Tool calls per second per instance; each client address gets 5x. `0` disables rate limiting | `20` |
| `NEXUS_RATE_BURST` | Calls an instance may make at once before the per-second limit applies (minimum 1) | `60` |
| `NEXUS_ALLOWED_HOSTS` | Extra DNS names accepted in the `Host` header (IP literals, `localhost`, `host.docker.internal` are always accepted) | empty |
| `NEXUS_INSTANCE_ID` | Override MCP instance ID (read cursors and meeting permissions are keyed on it) | `mcp-<hostname>-<hash of working directory>-<IDE name>` |

## 🔐 Security and governance notes

- n2n-nexus stores coordination data locally by default.
- Do not put secrets, credentials, customer data, or private tokens in meeting messages or project assets unless your local policy allows it.
- Destructive tools such as project deletion should be used through explicit review workflows.
- Exposing the daemon beyond localhost is an operational choice; restrict network access when using remote endpoints.
- Treat project manifests and internal docs as potentially sensitive implementation data.

## 🌐 Real-world example

The docs include a recorded multi-agent session that shows n2n-nexus in action. Four AI assistants — running in different IDEs and assigned to different projects — used a shared n2n-nexus daemon to coordinate in real time.

What to look for in the session:

- **Shared coordination space**: each assistant registered its active project (with the `register_session_context` tool of that release; current versions pass `projectId` explicitly instead), then read and wrote to the same daemon throughout the session.
- **Structured message categories**: `PROPOSAL`, `DECISION`, `UPDATE`, and `MEETING_START` tags let assistants signal intent, not just post text.
- **SYSTEM entries**: lines like `[Augment] Synced global doc: edge-sync-protocol-v1` record actual tool calls. That version wrote them into the chat stream; current versions keep them out of the conversation and expose them as structured events through `list_events`.
- **Async debugging across instances**: when one assistant hit an auth error, others responded with fixes in real time, each from their own IDE context.
- **Two output formats**: the discussion log is the raw chronological stream; the meeting minutes are a structured summary derived from it, showing how a long session distills into decisions and action items.

| File | What it shows |
| --- | --- |
| [Discussion Log](docs/discussion_2025-12-29.md) | The full chronological stream: proposals, debug exchanges, decisions, and SYSTEM tool entries |
| [Meeting Minutes](docs/MEETING_MINUTES_2025-12-29.md) | The structured output: participants, key decisions, test results, and action items |

## 🔧 Local development

Use Node.js 24 for development, matching CI and the lint toolchain.

```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build

# Run daemon
node build/index.js daemon --root /tmp/nexus-test --port 5688

# Run MCP adapter
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

## 📖 Related docs

- **[Architecture](./docs/ARCHITECTURE.md)**: System design and daemon-adapter separation explained.
- **[Tools reference](./docs/TOOLS_REFERENCE.md)**: Full tool list and parameters.
- **[AI Assistant Guide](./docs/ASSISTANT_GUIDE.md)**: How AI assistants should call tools and stay in project context.
- **[Changelog](./CHANGELOG.md)**: Version history and release notes.
- **[Contributing](./CONTRIBUTING.md)**: How to report issues and contribute.
- **[Security](./SECURITY.md)**: How to report vulnerabilities.

## 📄 License

This project is licensed under the [Apache-2.0 License](./LICENSE).

---

Built by [N2NS Lab](https://n2ns.com), the open-source lab of [datafrog.io](https://datafrog.io) for practical AI developer tools.
