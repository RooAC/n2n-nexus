# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc → build/
npm run dev            # tsc -w (watch mode)
npm test               # vitest run (all tests)
npm run lint           # eslint src tests

# Run a single test file
npx vitest run tests/daemon_messages.test.ts

# Run daemon locally
node build/index.js daemon --root /tmp/nexus-test --port 5688

# Run MCP server locally
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

Pre-commit runs lint; pre-push runs `build && test` (via lefthook).

## Architecture

The daemon + MCP refactor is complete (v0.5.0). The rationale is recorded in `CHANGELOG.md` under 0.5.0.

### Entry point
`src/index.ts` routes to `runDaemon()` (`src/daemon/`) or `NexusServer().run()` (`src/server/nexus.ts`) based on the first CLI argument (`daemon` or default).

### Daemon (`src/daemon/`)
`tools.ts` — zod contract per tool (26 tools). `TOOL_DEFINITIONS` (JSON Schema for `GET /api/tools`) is generated from these schemas with `z.toJSONSchema`, and `parseToolArgs` validates every call. Add a tool here first, then its result contract in `tool-outputs.ts` (handlers are typed `Promise<ToolResult<"name">>`), then its handler and dispatcher case in `server.ts`. `tests/structured_output.test.ts` calls every tool through the MCP adapter and must cover a new one.

`server.ts` — plain `http.Server` with all REST endpoints, tool handler functions and the dispatcher. REST endpoints call the same handlers through `callTool`, so validation is identical on both paths. Routes: `GET /api/tools`, `POST /api/tools/call`, plus project/message/meeting/task/event/maintenance endpoints.

### MCP Server (`src/server/nexus.ts`)
Pure stateless proxy on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). On startup: serves stdio through `serveStdio(() => buildServer())` and fetches `GET /api/tools` in the background (the first `tools/list` waits up to 1 s for it). `serveStdio` answers both 2026-07-28 clients (per-request `_meta` envelope, `server/discover`) and 2025-era clients (`initialize`). If the daemon is unreachable, a 3-second retry loop runs; on connect it calls `sendToolListChanged()`. `tools/call` → `POST /api/tools/call`. Exits when stdin closes. No hardcoded tool names.

### Storage layer (`src/storage/`)
- `StorageManager` (`index.ts`) is the single access point; delegates to sub-modules
- `sqlite.ts` + `sqlite-meeting.ts` / `global-messages.ts` / `events.ts` / `tasks.ts` — SQLite with WAL mode for meetings, global chat, the activity event log, tasks, read cursors (SQLite is required; there is no JSON fallback)
- `registry.ts` / `projects.ts` / `docs.ts` — file-based storage for projects and global docs; all writes go through `fs-utils.ts` (daemon-wide write lock + atomic temp-file-and-rename)
- `paths.ts` — all file paths derived from `getRootPath()` which reads `NEXUS_ROOT` env or `~/.n2n-nexus`

Only the daemon process accesses SQLite directly. MCP processes go through HTTP.

### Key SDK patterns
```typescript
// Capability must declare listChanged for notifications to work
capabilities: { tools: { listChanged: true } }

// On daemon connect (routed to subscriptions/listen on 2026-07-28 connections):
server.sendToolListChanged();

// 2026-07-28 has no initialize: read client identity per request
ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY] ?? server.getClientVersion()
```

Tests in `tests/mcp_proxy.test.ts` run every proxy case against both a 2025-era client and a client pinned to 2026-07-28 (`@modelcontextprotocol/client`).

## TypeScript / Module Notes

- Project uses `"module": "NodeNext"` — all internal imports **must** use `.js` extension even for `.ts` source files
- Tests use `port: 0` for dynamic port allocation and write to `tests/tmp/` (cleaned per test)
- Test files run sequentially (`fileParallelism: false`) to avoid SQLite file conflicts
