# Architecture & Standards

## 🏛️ System Architecture

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus daemon                    │
│  Standalone HTTP server · started by the user,   │
│  or at boot by `n2n-nexus install host`          │
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
MCP-A  MCP-B  MCP-C      hooks (Claude Code / Codex)
(Win)  (WSL)  (VM)       POST /api/hook per client event
Lightweight protocol adapter, one per MCP connection
```

### Core Principles

1. **Daemon is the single source of truth** — all reads/writes, business logic, and tool definitions live in the daemon.
2. **MCP is stateless** — no hardcoded tool names, no local persistent data and no session of its own; conversations and direct messages live in the daemon.
3. **Daemon decides tool capability** — MCP fetches `GET /api/tools` at startup and reconnect.
4. **No local fallback** — if the daemon is unreachable, the MCP reports an error and retries every 3 s. No split-brain degradation. A tool call the daemon rejects (validation, not found, permission) is returned to the IDE as an error result (`isError: true`) and does not affect the connection; an unknown tool name is a JSON-RPC `-32602` error.
5. **Plain HTTP between MCP, hooks and daemon** — the client's hooks report conversation events and carry new-message notifications back to the model; the model reads the text with a tool.

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
  ├─ Nothing answers: say how to start the daemon (install host / daemon); never start one
  │
  ├─ If the daemon was down: retry loop (every 3 s)
  │     └─ GET /api/tools succeeds → cache tool list
  │           → notifications/tools/list_changed → IDE re-fetches
  │
  └─ stdin closes → stop retrying, close, exit
```

The adapter's instance ID (read cursors, meeting permissions) uses the first client name seen on the connection, from the request's `io.modelcontextprotocol/clientInfo` (2026-07-28) or from `initialize` (2025 era), unless `NEXUS_INSTANCE_ID` / `--id` pins it.

### Conversations and hooks

Each Claude Code or Codex conversation is one session, `claude:<session id>` or `codex:<session id>`, using the ID the client itself assigns. `n2n-nexus install <claude|codex>` writes hooks that run `n2n-nexus hook <client>` on SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd (and, for Claude Code, PreToolUse on the n2n-nexus tools). The hook command forwards the event's identifying fields to `POST /api/hook` and prints the daemon's answer; on any error it exits 0 without output, so a missing daemon never blocks the client.

```
Client event ──▶ n2n-nexus hook ──▶ POST /api/hook ──▶ session status, notifications
                                                        │
UserPromptSubmit / PostToolUse ◀── additionalContext ◀──┤  "2 unread direct messages ..."
Stop                           ◀── decision: block   ◀──┘  once per stop, or on arrival while listening
```

Tool calls name their conversation outside the model's arguments. The adapter reads it from the request's `_meta`: Claude Code sends `claudecode/toolUseId`, which the PreToolUse hook bound to the conversation just before the call (verified: the call waits for the hook); Codex sends `sessionId`. The adapter forwards it as `caller` in `POST /api/tools/call`. Because the identity is the conversation, not the adapter process, an adapter restart, a resumed conversation and a sub-agent all keep it, and one adapter can serve several Codex conversations.

Notifications carry the sender and the first line only; the text reaches the model through `read`, as tool output rather than injected context. A listening Stop hook is held open for up to 590 s and answered as soon as a message arrives; the client killing the hook (the user pressing Esc) or the daemon shutting down ends the wait. This remains a trusted local daemon, not an authentication boundary: every process of the same operating-system user is trusted and could act as any conversation, and agents that must be isolated run as different users with their own daemons (see the local trust model in [SECURITY.md](../SECURITY.md)). See [tool reference](TOOLS_REFERENCE.md#direct-messages-between-conversations).

### Sessions, presence and waking idle conversations

A new conversation's SessionStart hook prints an introduction: its own name and ID, the other sessions that are not offline (up to five) and how to use `peers`, `send` and `read`. The adapter also sends MCP server instructions with the same guidance. Clients do not always report the end of a conversation, so an `idle` or `working` session without activity for 30 minutes counts as `offline` until its next event.

An idle conversation is not running, so hooks alone can only reach it when its user acts. To let AI sessions answer each other without anyone typing, `install` adds a second Stop hook, `n2n-nexus hook <client> --wait`, that starts a background wait when a turn ends:

```
turn ends ──▶ Stop hook (announces unread, or listens)
          └─▶ Stop hook --wait ──▶ POST /api/hook {BackgroundWait}  (up to 590 s per request, repeated for up to 1 h)
                                     │  session shows as "listening"
                                     ├─ new message ─▶ { wake: notification }
                                     │     Claude Code: asyncRewake hook exits 2, the notification starts a turn
                                     │     Codex: detached process runs `codex queue --thread <id> --message <notification>`
                                     ├─ any other event of the session ─▶ null (wait ends)
                                     └─ time runs out ─▶ { timeout: true } (ask again)
```

The wait never delivers while the session is `working` or while a listening Stop hook is waiting, so a message is announced once. Verified on Windows with the Claude desktop app and the Codex desktop app (2026-10-23): both directions wake an idle conversation within seconds. Known limits:

- Codex starts a queued turn only for a conversation loaded in the running Codex app. After Codex restarts, a conversation is loaded once the user opens it.
- The Codex background wait ends when the Codex app quits, and starts again only when the conversation ends a turn. Messages sent meanwhile stay unread in the daemon (not in Codex's own queue) until the user next prompts that conversation.
- A Claude Code conversation is reachable for an hour after its last turn (the hook timeout).
- Every AI reply wakes the recipient again. To stop two sessions waking each other forever, the daemon counts automatic turns (wakes, listening Stops, Stops held open for messages) since the user's last prompt and stops after `NEXUS_MAX_AUTO_TURNS` (default 8); a prompt within a minute of a wake is the woken turn starting and keeps the count. Messages past the limit wait until the user prompts.
- The automatic turn count tells the woken turn from the user by time alone. If a wake does not start a turn (a Codex conversation not loaded) and the user prompts within that minute, that prompt keeps the count; the user's next prompt resets it. If a woken turn starts more than a minute late (a Codex conversation the user opens later), its prompt resets the count. Neither loses a message or lets sessions loop without a user.

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
└── nexus.db                # SQLite database (meetings, global chat, events, tasks, cursors, conversations, direct messages)
```

**SQLite WAL mode**: Only the daemon process opens the database. MCP adapters never touch it — they go through HTTP.

**File-store access**: HTTP requests are handled concurrently, so every mutation of `registry.json`, manifests and the docs index holds one daemon-wide read-write lock alone and is written atomically (temp file + rename); reads share the lock, so a rename or update is never observed half-done. A write orders its files so that `registry.json` goes last and restores what it had already written when a later step fails.

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
  ├─ n2n-nexus install host   Run the daemon as a service that starts at boot (Windows).
  ├─ n2n-nexus mcp       IDE starts automatically via npx. Stateless proxy.
  ├─ n2n-nexus hook      Run by Claude Code / Codex on each hook event.
  ├─ n2n-nexus install   Write the hooks and MCP server into a client's user configuration.
  └─ n2n-nexus doctor    Check that the installed hook and MCP commands still run.
```

**Daemon** (run as a boot service with `n2n-nexus install host`, or started by the user; the adapter and the hooks never start one, they report that none answers):
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

**Standalone host on a LAN**: run one daemon with `--host 0.0.0.0` as a service (`n2n-nexus install host --host 0.0.0.0` on Windows, a systemd unit or a launchd agent elsewhere), independent of any IDE, and allow TCP and UDP 5688 from the local subnet. Each client machine then needs only the client side: `n2n-nexus install <claude|codex> --endpoint discover` writes the MCP server and the hooks, which find the host by UDP broadcast. On Windows, run `npm install -g` from a regular terminal: a terminal inside a packaged (MSIX) app such as Codex installs into that app's private copy of `%APPDATA%`, which only that app sees and which hides a later global install from it.

**No required startup order**: start the IDE before the daemon — tools appear automatically once the daemon comes up. Daemon restarts are transparent; MCP reconnects and notifies the IDE.

---

## 📡 REST API

### Tool capability (MCP-facing)
```
GET  /api/tools              Return full tool definition list (JSON Schema)
POST /api/tools/call         Execute tool call { tool, args, instanceId, caller? }
POST /api/hook               Client hook event { client, input } → { output }; the BackgroundWait event is the background wait
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
- No cross-machine live sync by default — point `NEXUS_ENDPOINT` at a reachable host for that, or set it to `discover` to find a daemon bound to `0.0.0.0` on the LAN through a UDP broadcast.
- Single daemon node; no built-in clustering.
- No authentication layer in the open-source baseline.
