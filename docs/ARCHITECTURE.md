# Architecture & Standards

## 🏛️ System Architecture

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus daemon                    │
│  Standalone HTTP server · User starts manually   │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  REST API    │  │  Storage Layer           │  │
│  │  /api/tools  │  │  SQLite (WAL) + JSON FS  │  │
│  │  /api/tools  │  │                          │  │
│  │    /call     │  │  Single writer — no lock │  │
│  └──────┬───────┘  └──────────────────────────┘  │
│  All business logic, tool definitions, data I/O  │
└─────────┼────────────────────────────────────────┘
          │ HTTP  (NEXUS_ENDPOINT — cross-env capable)
   ┌──────┼──────┐
   ▼      ▼      ▼
MCP-A  MCP-B  MCP-C
(Win)  (WSL)  (VM)
Lightweight protocol adapter, one per MCP connection
```

### Core Principles

1. **Daemon is the single source of truth** — all reads/writes, business logic, and tool definitions live in the daemon.
2. **MCP holds connection identity only** — no hardcoded tool names or local persistent data; sessions and inboxes live in the daemon.
3. **Daemon decides tool capability** — MCP fetches `GET /api/tools` at startup and reconnect. Session inboxes require both the session-aware adapter and daemon; legacy clients can continue using the existing shared-message APIs.
4. **No local fallback** — if the daemon is unreachable, the MCP reports an error and retries every 3 s. No split-brain degradation. A tool call the daemon rejects (validation, not found, permission) is returned to the IDE as an error result (`isError: true`) and does not affect the connection; an unknown tool name is a JSON-RPC `-32602` error.
5. **Plain HTTP between MCP and daemon** — inboxes are pulled explicitly; heartbeats maintain presence but do not wake the model.

### MCP Startup Flow

```
Read NEXUS_ENDPOINT (default: http://127.0.0.1:5688)
  │
  ├─ Serve stdio (MCP TypeScript SDK v2, serveStdio) and GET /api/tools once;
  │  the first tools/list waits up to 1 s for that fetch
  │     ├─ 2026-07-28 clients: server/discover, per-request _meta envelope,
  │     │  list_changed delivered on subscriptions/listen
  │     └─ 2025-era clients: initialize handshake, unsolicited list_changed
  │
  ├─ If the daemon was down: retry loop (every 3 s)
  │     └─ GET /api/tools succeeds → cache tool list
  │           → notifications/tools/list_changed → IDE re-fetches
  │
  └─ stdin closes → stop retrying, close, exit
```

The adapter's instance ID (read cursors, meeting permissions) uses the first client name seen on the connection, from the request's `io.modelcontextprotocol/clientInfo` (2026-07-28) or from `initialize` (2025 era), unless `NEXUS_INSTANCE_ID` / `--id` pins it.

Each MCP connection also gets a random session ID, registered on its first tool request and refreshed every 20 seconds with a 60-second presence lease. Disconnect marks it offline; an adapter restart creates a new session, so pending messages for the old session are not transferred. Multiple host chats sharing a connection share its inbox. Project association is directory metadata, not an implicit target for project tools. Registration and disconnect use `POST /api/sessions/register` and `POST /api/sessions/disconnect`; direct tools receive session identity outside their model-supplied arguments. This remains a trusted local daemon, not an authentication boundary. See [tool reference](TOOLS_REFERENCE.md#session-directory-and-direct-inboxes).

---

## 💾 Data Persistence

All data lives under the daemon's storage root (default `~/.n2n-nexus`):

```
~/.n2n-nexus/
├── global/
│   ├── blueprint.md        # Master strategy document
│   ├── docs_index.json     # Global docs index
│   └── docs/               # Shared markdown documents
├── projects/
│   └── {project-id}/
│       ├── manifest.json          # Project metadata
│       ├── internal_blueprint.md  # Internal technical docs
│       └── assets/                # Binary assets (images, PDFs)
├── registry.json           # Global project index
└── nexus.db                # SQLite database (meetings, global chat, events, tasks, cursors)
```

**SQLite WAL mode**: Only the daemon process opens the database. MCP adapters never touch it — they go through HTTP.

**File-store writes**: HTTP requests are handled concurrently, so every mutation of `registry.json`, manifests and the docs index is queued behind one daemon-wide lock and written atomically (temp file + rename).

**Activity log**: state changes made through the daemon (project sync/rename/delete, meeting start/end, doc sync, ...) are recorded as structured events in SQLite and read with `list_events` / `GET /api/events`; they are not mixed into chat streams.

**Self-healing**: `registry.json` is auto-repaired if corrupted or missing.

---

## 🏷️ Project ID Conventions

All project IDs must follow the `[prefix]_[name]` format:

| Prefix | Category | Example |
|--------|----------|---------|
| `web_` | Websites | `web_datafrog.io` |
| `api_` | Backend services | `api_user-auth` |
| `mcp_` | MCP servers | `mcp_nexus` |
| `lib_` | Libraries / SDKs | `lib_crypto-core` |
| `chrome_` | Chrome extensions | `chrome_evisa-helper` |
| `vscode_` | VSCode extensions | `vscode_super-theme` |
| `android_` | Android apps | `android_client-app` |
| `ios_` | iOS apps | `ios_client-app` |
| `flutter_` | Flutter apps | `flutter_unified-app` |
| `desktop_` | Desktop apps | `desktop_main-hub` |
| `bot_` | Bots | `bot_auto-moderator` |
| `infra_` | Infrastructure / DevOps | `infra_k8s-config` |
| `doc_` | Documentation | `doc_coding-guide` |

---

## 🌐 Deployment Model

One npm package, two commands:

```
n2n-nexus
  │
  ├─ n2n-nexus daemon    Start once, keep running. Owns all data.
  │
  └─ n2n-nexus mcp       IDE starts automatically via npx. Stateless proxy.
```

**Daemon** (user starts manually):
```bash
npx n2n-nexus daemon --port 5688
# or with explicit root
npx n2n-nexus daemon --root ~/.n2n-nexus --port 5688
```

**MCP** (IDE configuration):
```json
{
  "mcpServers": {
    "n2n-nexus": {
      "command": "npx",
      "args": ["-y", "n2n-nexus", "mcp"],
      "env": { "NEXUS_ENDPOINT": "http://127.0.0.1:5688" }
    }
  }
}
```

**No required startup order**: start the IDE before the daemon — tools appear automatically once the daemon comes up. Daemon restarts are transparent; MCP reconnects and notifies the IDE.

---

## 📡 REST API

### Tool capability (MCP-facing)
```
GET  /api/tools              Return full tool definition list (JSON Schema)
POST /api/tools/call         Execute tool call { tool, args, instanceId, sessionId? }
```

### System
```
GET  /health                 Health status + version
```

### Projects
```
POST /api/projects/sync
POST /api/projects/update
POST /api/projects/rename
POST /api/projects/delete
GET  /api/projects/search
GET  /api/projects/topology
GET  /api/projects/:projectId
```

### Messages & Global
```
POST /api/messages/send
GET  /api/messages/unread
GET  /api/events
GET  /api/global/docs
GET  /api/global/docs/:docId
POST /api/global/docs/:docId
GET  /api/global/strategy
POST /api/global/strategy
```

### Meetings
```
GET  /api/meetings
POST /api/meetings/start
POST /api/meetings/end
POST /api/meetings/archive
POST /api/meetings/reopen
GET  /api/meetings/:meetingId
```

### Tasks
```
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/update
POST /api/tasks/:taskId/cancel
```

### Maintenance
```
POST /api/maintenance/logs
```

---

### Request guards

The daemon rejects browser-originated requests (`Origin` header or cross-site `Sec-Fetch-Site`: 403), `Host` names that are neither IP literals nor local/allow-listed names (403, prevents DNS rebinding), non-JSON POST bodies (415) and bodies above 16 MB (413). Tool calls are rate limited per instance and per client address (429 with `Retry-After`). See `SECURITY.md`.

## Scope Boundaries

- No cloud bridge by default.
- No cross-machine live sync by default — point `NEXUS_ENDPOINT` at a reachable host for that.
- Single daemon node; no built-in clustering.
- No authentication layer in the open-source baseline.
