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

> **One host. Many assistants. Shared project state.**

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

n2n-nexus gives AI assistants a shared coordination workspace. A long-running local host, `n2n-nexus-host`, owns project state, meetings, messages, tasks, shared docs, and project assets. Lightweight MCP adapters from the `n2n-nexus` npm package connect each IDE or assistant to the same host.

- Coordinate multiple AI assistants working on the same project.
- Share project manifests, decisions, and assets across IDEs and machines.
- Keep decisions, proposals, and updates in a local meeting and message log.
- Run the host once; connect adapters from Windows, WSL, SSH hosts, or multiple editors.
- Avoid giving each assistant broad filesystem or backend access.

## 🏗️ Architecture

```text
┌──────────────────────────────────────┐
│           n2n-nexus-host             │
│  Tray app or background service      │
│  Owns data, tools, tasks, messages   │
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (SSH/VM)
  n2n-nexus adapter per IDE
```

- **The host is the source of truth**: install it once and keep it running, as a tray app or as a background service.
- **MCP adapters are stateless**: each IDE starts an adapter (`n2n-nexus mcp`), which forwards tool calls to the host.
- **Every Claude Code and Codex conversation has its own identity**: client hooks register the conversation with the host and notify it of new direct messages; each tool call names its conversation through the request metadata the client attaches, never through model-supplied arguments.
- **Cross-environment by design**: point `NEXUS_ENDPOINT` at the same host from different machines or shells. The host listens on `127.0.0.1` by default; turn on LAN access only on a trusted network.

## 🚀 Quick start

New to n2n-nexus? The [user guide](docs/USER_GUIDE.md) walks through the setup step by step, including the one-time Codex hook trust.

### 1. Install the host

| Platform | Install |
| --- | --- |
| Windows (Scoop) | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`, then `scoop install n2ns/n2n-nexus-host` |
| Windows (winget) | coming soon |
| macOS (Homebrew) | `brew install n2ns/tap/n2n-nexus-host` |
| Linux | download `n2n-nexus-host_<version>_linux_<amd64\|arm64>.tar.gz` from [Releases](https://github.com/n2ns/n2n-nexus/releases), extract it and put `n2n-nexus-host` on your `PATH` |

[Releases](https://github.com/n2ns/n2n-nexus/releases) (tags `host-v<version>`) has the archives for every platform: `n2n-nexus-host_<version>_<os>_<arch>.zip` for Windows and `.tar.gz` for macOS and Linux, amd64 and arm64.

- The binaries are not code-signed yet. On Windows, the first start of `n2n-nexus-host.exe` or `n2n-nexus-host-tray.exe` may show a SmartScreen warning: click **More info → Run anyway**. Homebrew builds the host from source on your Mac, so there is no Gatekeeper prompt.
- On Windows the package has two programs: `n2n-nexus-host.exe` for commands, and `n2n-nexus-host-tray.exe`, the tray, which opens no console window. `n2n-nexus-host` without arguments starts the tray program and returns.
- Run `n2n-nexus-host` without arguments to start it as a tray app. The tray menu shows the address it listens on and the number of online sessions, opens the log and data folders, switches LAN access on and off, restarts the host and turns **Start at login** on or off (`n2n-nexus-host autostart on|off` does the same). The first time the tray runs it turns **Start at login** on; after that it stays as you set it. The menu is in Chinese on a Chinese system and in English otherwise.
- Or run it as a background service that starts at boot, without a tray: `n2n-nexus-host service install` from an elevated terminal (Windows) or with `sudo` (macOS, Linux). The service runs as the user who installed it. Quit the tray first: `service install` refuses while the tray runs the host. While the service runs, a tray started later only controls it.
- On Linux the tray needs a desktop with StatusNotifierItem (AppIndicator) support; on a server, use `service install`.

Verify a download against the release's `SHA256SUMS` and its build provenance:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify n2n-nexus-host_<version>_<os>_<arch>.tar.gz --repo n2ns/n2n-nexus
```

### 2. Install the client and connect Claude Code or Codex

Requires Node.js 22.14+ on the 22.x release line, or Node.js 23.6+.

```bash
npm i -g n2n-nexus
n2n-nexus install claude    # ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR) + claude mcp add --scope user
n2n-nexus install codex     # ~/.codex/hooks.json (or $CODEX_HOME) + codex mcp add
n2n-nexus doctor            # check the installed commands and that the host answers
```

`install` writes the hooks and the MCP server into the client's user configuration.

- Codex runs new hooks only after you trust them: open the Codex CLI, run `/hooks` and trust the n2n-nexus hooks (the Codex app shares that trust but has no `/hooks` screen). Step by step: [User guide](docs/USER_GUIDE.md#3-turn-on-the-codex-hooks-one-time-required).
- Pass `--endpoint <url>` to both commands when the host is not at `http://127.0.0.1:5688`, or `--endpoint discover` to find a host on the LAN.
- On Windows, run `npm i -g` and `install` from a regular terminal, not from the terminal of a packaged app such as Codex: that terminal installs into the app's private copy of `%APPDATA%`, which hides the global install from the app.
- The hooks and the MCP server command use an absolute Node path, because GUI clients started from the Dock (such as Claude Desktop) do not read your shell's `PATH`. By default `install` writes the `node` found on `PATH` when it is the same file as the Node running `install` (for example `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `~/.local/bin/node` or a version manager's stable entry point), and otherwise the real path of the running Node. `install` prints the path it wrote as `Node: <path>`.
- Pass `--node <path>` to choose the Node path yourself. It must exist, be executable and satisfy the `engines` range in package.json (`^22.14.0 || >=23.6.0`); otherwise `install` exits with code 1 and writes nothing.
- After upgrading Node: if `install` warned that the Node path contains a version directory (Homebrew `Cellar`, nvm, fnm, Volta, asdf, `node-v<version>`), run `n2n-nexus install <claude|codex>` again after each upgrade, or pass `--node` with a stable path. `n2n-nexus doctor [claude|codex]` checks that the Node path and the entry script in the installed hook and MCP commands still exist and run, and that the host they talk to answers with the client's contract version; it exits with code 1 when a check fails.
- `n2n-nexus uninstall <claude|codex>` removes the hooks and the MCP server that `install` added and leaves the rest of the configuration alone.
- Supported on Linux, WSL and macOS; Codex hooks also support Windows PowerShell. Other MCP clients can use every tool except direct messages.

### Other MCP clients

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

The adapter can start before the host. It loads the host's tool list once the host becomes reachable. The adapter and the hooks never start a host themselves: when none answers, tool calls fail with a message saying how to start it (or, for a remote endpoint, that it must be started on that machine), and the hooks skip silently. A call the host does not answer in time fails on its own; the host may still complete it.

### Direct messages between Claude Code and Codex conversations

Each conversation appears in `peers`. A new direct message is announced to the recipient automatically: when the user sends a prompt, after each tool call, and once before the turn ends. The recipient reads the text with `read`. An idle conversation is woken too: when a turn ends, a background hook waits up to an hour for anything new and then starts a turn with it (Claude Code through an `asyncRewake` hook, Codex through `codex queue`), so AI sessions can answer each other without anyone typing. An unattended `claude -p` run is not kept waiting: the hook returns at once there. A Codex conversation is woken only while it is loaded in the running Codex app, and not again after Codex restarts until it ends a turn; see [Architecture](docs/ARCHITECTURE.md#sessions-presence-and-waking-idle-conversations) for the limits. With `listen` on, a conversation that finished its turn keeps waiting for up to about 10 minutes and continues when a message arrives; while it waits, input you type is queued until you press Esc.

### LAN access

By default the host listens on `127.0.0.1` only. To make it the host for other machines on a trusted network:

- Tray: check **Allow LAN access**. The tray writes `"host": "0.0.0.0"` to `settings.json` and restarts the host. On Windows it adds inbound firewall rules for the TCP port and the UDP discovery port (5688 and 5688 by default) after a UAC prompt; on macOS and Linux it tells you which ports to allow in your firewall.
- Service: `n2n-nexus-host service install --host 0.0.0.0` writes the address to `settings.json`; allow TCP 5688 and UDP 5688 in the firewall yourself.

A host that listens on a non-loopback address answers LAN discovery on UDP `discoveryPort`.

### Cross-environment endpoint examples

| Scenario | `NEXUS_ENDPOINT` |
| --- | --- |
| Same machine | `http://127.0.0.1:5688` |
| WSL IDE to Windows host | `http://host.docker.internal:5688` |
| Windows IDE to WSL host | `http://<WSL-IP>:5688` |
| Remote machine | `http://<Server-IP>:5688` |
| Find a host on the LAN | `discover` |

With `discover`, the adapter and the hooks broadcast a query on UDP `NEXUS_DISCOVERY_PORT` and use the first host that answers; the result is cached in `~/.n2n-nexus/discovered-endpoint` and looked up again when that host cannot be reached. A host answers only when it listens on a non-loopback address (LAN access on), so allow UDP and TCP 5688 through its firewall for the trusted network. When none answers, the client uses `http://127.0.0.1:5688` (a host on this machine) and looks again after a minute.

## 🛠️ Toolset

The host exposes 33 tools, grouped by purpose:

| Group | Tools | Purpose |
| --- | --- | --- |
| **Topology** | `get_global_topology` | Read the project list or a detailed per-project subgraph. |
| **Projects & assets** | `search_projects`, `get_project`, `update_project`, `rename_project`, `sync_project_assets`, `upload_project_asset` | Find, read, update, and rename projects; sync manifests and internal docs; upload binary assets. |
| **Global docs** | `list_global_docs`, `get_global_doc`, `sync_global_doc`, `get_global_strategy`, `update_global_strategy` | List, read, create and update shared global documents and the master strategy document. |
| **Messaging** | `send_message`, `read_messages`, `list_events` | Post meeting or global messages; read them and the activity log. |
| **Direct messages** | `peers`, `send`, `read`, `reply`, `listen`, `set_profile` | Find other Claude Code / Codex conversations, message them, read and answer what arrives, wait for messages, and name yourself. |
| **Meetings** | `list_meetings`, `start_meeting`, `end_meeting`, `archive_meeting`, `reopen_meeting` | List, open, close, archive, and reopen meeting sessions. |
| **Tasks** | `create_task`, `get_task`, `list_tasks`, `update_task`, `cancel_task` | Create, update and track tasks that assistants manage themselves. |
| **Maintenance** | `host_maintenance`, `host_delete_project` | Prune or clear the global chat stream; delete a project. |

Direct messages need the hooks from `n2n-nexus install`. Notifications carry only the sender and the first line; the text arrives through `read`, as tool output, so a message from another AI session never reaches the model as a system instruction. Unread messages expire after 24 hours and the sender is told. See the [assistant workflow](docs/ASSISTANT_GUIDE.md#direct-conversations).

See [Tools reference](./docs/TOOLS_REFERENCE.md) for parameter schemas and call examples.

## 💾 Data storage

The host keeps all coordination data in one SQLite database in its data directory:

| Platform | Data directory | Log directory |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\n2n-nexus` | `%LOCALAPPDATA%\n2n-nexus\logs` |
| macOS | `~/Library/Application Support/n2n-nexus` | `~/Library/Logs/n2n-nexus` |
| Linux | `$XDG_DATA_HOME/n2n-nexus` (default `~/.local/share/n2n-nexus`) | `$XDG_STATE_HOME/n2n-nexus` (default `~/.local/state/n2n-nexus`) |

Override the data directory with `--root <path>` or `NEXUS_ROOT`.

```text
<data directory>/
├── nexus.db          # projects, assets, docs, meetings, global chat, events, tasks, read cursors, conversations, direct messages
├── settings.json     # host settings (see below)
└── host.lock         # one host per data directory
```

The background service, and the tray while it runs the host itself, log to `host.log` in the log directory (10 MB per file, 3 old files kept); the tray's own lines go to `tray.log` there; `n2n-nexus-host serve` logs to standard error. Every hour the host deletes events, read or expired direct messages and delivered notices older than 30 days, and tasks 7 days after they finished.

Data of n2n-nexus 0.x (`~/.n2n-nexus`) is not imported: the host does not read it and leaves it in place.

### settings.json

Read when the host starts; command-line flags override it. A missing file or field uses the default.

| Field | Description | Default |
| --- | --- | --- |
| `host` | Address to listen on (an IPv4 address listens on IPv4 only, an IPv6 address on IPv6 only); `0.0.0.0` makes the host reachable from the LAN | `"127.0.0.1"` |
| `port` | TCP port | `5688` |
| `discoveryPort` | UDP port of LAN discovery, answered only when `host` is not a loopback address | `5688` |
| `allowedHosts` | Extra DNS names accepted in the `Host` header (IP literals, `localhost` and `host.docker.internal` are always accepted) | `[]` |
| `rateLimit` | Tool calls per second per instance; each client address gets 5x. Hooks have their own budget at the same rate per conversation and 5x per client address. `0` disables rate limiting | `20` |
| `rateBurst` | Calls an instance may make at once before the per-second limit applies (minimum 1) | `60` |
| `maxAutoTurns` | Automatic turns a conversation may take between its user's prompts (wakes, listening and Stops held open for messages); past it, messages wait until the user prompts. `0` disables the limit | `8` |

After editing the file, restart the host (tray **Restart**, or restart `serve` or the service).

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

### n2n-nexus-host

```bash
# Tray app (default)
n2n-nexus-host

# Run in the foreground without a tray; flags override settings.json (--port 0 picks a free port)
n2n-nexus-host serve [--host 127.0.0.1] [--port 5688] [--root <dir>]

# Background service that starts at boot (elevated terminal on Windows, sudo on macOS / Linux).
# install refuses while the tray runs the host (quit it first; reopened, it controls the service),
# writes --host / --port to settings.json, stops a host running for the data directory,
# registers and starts the service, and reports what answers on the port.
# uninstall removes the service and stops its host; a tray or a foreground serve keeps running.
n2n-nexus-host service install [--host <addr>] [--port <port>] [--root <dir>]
n2n-nexus-host service uninstall [--root <dir>]
n2n-nexus-host service status [--host <addr>] [--port <port>] [--root <dir>]

# Start the tray at login, or stop doing so
n2n-nexus-host autostart on|off

n2n-nexus-host version
```

What `service install` registers, and where `autostart on` registers the tray:

| Platform | Service (starts at boot, runs as the installing user, restarts the host 5 s after it exits) | Tray at login |
| --- | --- | --- |
| Windows | Scheduled task `n2n-nexus-host` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `n2n-nexus-host` |
| macOS | `/Library/LaunchDaemons/io.n2ns.n2n-nexus-host.plist` | `~/Library/LaunchAgents/io.n2ns.n2n-nexus-host.tray.plist` |
| Linux | `/etc/systemd/system/n2n-nexus-host.service` | `~/.config/autostart/n2n-nexus-host.desktop` |

Under `sudo`, the service uses the default data and log directories of the user who ran `sudo`, unless `--root` names another data directory. Only one host runs per data directory: a second one exits with "another n2n-nexus-host is running".

### n2n-nexus (client)

```bash
# Start the MCP adapter (launched by the IDE)
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp [--id <instance id>]

# Install / remove the hooks and MCP server for Claude Code or Codex
n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
n2n-nexus uninstall <claude|codex>

# Check that the installed hook and MCP commands still run and that the host answers
# with the client's contract version (exit 1 when not)
n2n-nexus doctor [claude|codex]

# Hook entry point (written into the client configuration by install)
n2n-nexus hook <claude|codex> [--endpoint <url>] [--wait]
```

### Environment variables

Client (`n2n-nexus`):

| Variable | Description | Default |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | Host URL for the MCP adapter, the hooks and `doctor`, or `discover` to find one on the LAN | `http://127.0.0.1:5688` |
| `NEXUS_DISCOVERY_PORT` | UDP port the client queries with `discover` | `5688` |
| `NEXUS_INSTANCE_ID` | Override the MCP instance ID (read cursors and meeting permissions are keyed on it) | `mcp-<hostname>-<hash of working directory>-<IDE name>` |
| `NEXUS_CODEX_COMMAND` | Command the Codex background wait runs as `<command> queue ...` | `codex` |

Host (`n2n-nexus-host`): only `NEXUS_ROOT`, the data directory (`--root` overrides it). Every other host setting is in `settings.json`, which the tray, the service and the command line share.

## 🔐 Security and governance notes

- n2n-nexus stores coordination data locally by default.
- Do not put secrets, credentials, customer data, or private tokens in meeting messages or project assets unless your local policy allows it.
- Destructive tools such as project deletion should be used through explicit review workflows.
- Exposing the host beyond localhost is an operational choice; restrict network access when using remote endpoints.
- Treat project manifests and internal docs as potentially sensitive implementation data.

## 🌐 Real-world example

The docs include a recorded multi-agent session that shows n2n-nexus in action. Four AI assistants — running in different IDEs and assigned to different projects — used a shared n2n-nexus host to coordinate in real time.

What to look for in the session:

- **Shared coordination space**: each assistant registered its active project (with the `register_session_context` tool of that release; current versions pass `projectId` explicitly instead), then read and wrote to the same host throughout the session.
- **Structured message categories**: `PROPOSAL`, `DECISION`, `UPDATE` and `CHAT` tags let assistants signal intent, not just post text; a `DECISION` in a meeting is also kept in its decisions list.
- **SYSTEM entries**: lines like `[Augment] Synced global doc: edge-sync-protocol-v1` record actual tool calls. That version wrote them into the chat stream; current versions keep them out of the conversation and expose them as structured events through `list_events`.
- **Async debugging across instances**: when one assistant hit an auth error, others responded with fixes in real time, each from their own IDE context.
- **Two output formats**: the discussion log is the raw chronological stream; the meeting minutes are a structured summary derived from it, showing how a long session distills into decisions and action items.

| File | What it shows |
| --- | --- |
| [Discussion Log](docs/discussion_2025-12-29.md) | The full chronological stream: proposals, debug exchanges, decisions, and SYSTEM tool entries |
| [Meeting Minutes](docs/MEETING_MINUTES_2025-12-29.md) | The structured output: participants, key decisions, test results, and action items |

## 🔧 Local development

Use Node.js 24 for the client, matching CI and the lint toolchain, and the Go version in `go.mod` for the host.

```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build

# Run a host
go run ./host/cmd/n2n-nexus-host serve --port 5799 --root /tmp/nexus-test

# Run the MCP adapter against it
NEXUS_ENDPOINT=http://127.0.0.1:5799 node build/index.js mcp
```

See [host/README.md](./host/README.md) for building, testing and releasing the host.

## 📖 Related docs

- **[Architecture](./docs/ARCHITECTURE.md)**: System design and host-client separation explained.
- **[Tools reference](./docs/TOOLS_REFERENCE.md)**: Full tool list and parameters.
- **[AI Assistant Guide](./docs/ASSISTANT_GUIDE.md)**: How AI assistants should call tools and stay in project context.
- **[Changelog](./CHANGELOG.md)**: Version history and release notes.
- **[Contributing](./CONTRIBUTING.md)**: How to report issues and contribute.
- **[Security](./SECURITY.md)**: How to report vulnerabilities.

## 📄 License

This project is licensed under the [Apache-2.0 License](./LICENSE).

---

Built by [N2NS Lab](https://n2ns.com), the open-source lab of [datafrog.io](https://datafrog.io) for practical AI developer tools.
