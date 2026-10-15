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
`tools.ts` — zod contract per tool (26 tools). `TOOL_DEFINITIONS` (JSON Schema for `GET /api/tools`) is generated from these schemas with `z.toJSONSchema`, and `parseToolArgs` validates every call. Add a tool here first, then its handler and dispatcher case in `server.ts`.

`server.ts` — plain `http.Server` with all REST endpoints, tool handler functions and the dispatcher. REST endpoints call the same handlers through `callTool`, so validation is identical on both paths. Routes: `GET /api/tools`, `POST /api/tools/call`, plus project/message/meeting/task/event/maintenance endpoints.

### MCP Server (`src/server/nexus.ts`)
Pure stateless proxy. On startup: connects stdio transport, then tries `GET /api/tools`; if daemon unreachable, schedules 3-second retry loop. On connect: calls `server.sendToolListChanged()`. `CallTool` → `POST /api/tools/call`. No hardcoded tool names.

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

// On daemon connect:
server.sendToolListChanged(); // triggers IDE to re-fetch
```

## TypeScript / Module Notes

- Project uses `"module": "NodeNext"` — all internal imports **must** use `.js` extension even for `.ts` source files
- Tests use `port: 0` for dynamic port allocation and write to `tests/tmp/` (cleaned per test)
- Test files run sequentially (`fileParallelism: false`) to avoid SQLite file conflicts
