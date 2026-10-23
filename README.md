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
- [Real-world example](#-real-world-example)
- [Documentation](#-documentation)

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

1. Install and start the host, `n2n-nexus-host`, with Scoop, Homebrew or an archive from [Releases](https://github.com/n2ns/n2n-nexus/releases): [User guide, step 1](docs/USER_GUIDE.md#1-install-and-start-the-host).
2. Install the client and connect Claude Code or Codex (`npm i -g n2n-nexus@latest`, then `n2n-nexus install claude` or `n2n-nexus install codex`): [step 2](docs/USER_GUIDE.md#2-install-the-client-for-claude-code-and-codex).
3. Codex only: trust the n2n-nexus hooks once with `/hooks`: [step 3](docs/USER_GUIDE.md#3-turn-on-the-codex-hooks-one-time-required).

Other MCP clients, several machines, configuration and troubleshooting: see the [User guide](docs/USER_GUIDE.md).

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

See [Tools reference](./docs/TOOLS_REFERENCE.md) for parameter schemas and call examples.

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

## 📖 Documentation

- **[User guide](./docs/USER_GUIDE.md)**: Installing, configuring and running the host and the client; commands, environment variables, `settings.json`, data and logs.
- **[Architecture](./docs/ARCHITECTURE.md)**: System design and host-client separation explained.
- **[Tools reference](./docs/TOOLS_REFERENCE.md)**: Full tool list and parameters.
- **[AI Assistant Guide](./docs/ASSISTANT_GUIDE.md)**: How AI assistants should call tools and stay in project context.
- **[Host development](./host/README.md)**: Building, testing and releasing the host.
- **[Contributing](./CONTRIBUTING.md)**: Development setup, and how to report issues and contribute.
- **[Changelog](./CHANGELOG.md)**: Version history and release notes.
- **[Security](./SECURITY.md)**: Security model, and how to report vulnerabilities.

## 📄 License

This project is licensed under the [Apache-2.0 License](./LICENSE).

---

Built by [N2NS Lab](https://n2ns.com), the open-source lab of [datafrog.io](https://datafrog.io) for practical AI developer tools.
