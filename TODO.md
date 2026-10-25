# Nexus Project TODO List

## ✅ 2026-06-14: Daemon + MCP Architecture Refactor (DONE, history)

> History only: this TypeScript daemon was later replaced by the Go host (`host/`, `n2n-nexus-host`). `src/daemon/` no longer exists; see `docs/ARCHITECTURE.md` for the current design.

**Objective**: Replace the flawed Host/Guest election mechanism with a standalone daemon as the single source of truth.

**Root problem solved**: The old election model assumed all AI instances shared the same `localhost` namespace. This breaks across Windows/WSL/VM environments and when the "Host" IDE is closed.

### Completed
- [x] `src/daemon/server.ts` — Full REST API server with all 20 tool definitions + handlers
- [x] `src/client/nexus-client.ts` — Stateless HTTP client (`fetchTools` + `callTool`)
- [x] `src/server/nexus.ts` — Pure MCP proxy: fetches tools from daemon, forwards all calls
- [x] `src/index.ts` — Clean `daemon` / `mcp` entry points
- [x] `src/config/index.ts` — Removed election config, reads `NEXUS_ROOT` env
- [x] Deleted: `src/network/`, `src/auth/`, `src/tools/`, `src/resources/`
- [x] All 17 tests passing
- [x] All documentation updated

---

## Backlog

### Near-term
- [ ] winget: N2NS.n2n-nexus-host 0.9.0 is submitted (microsoft/winget-pkgs#460226); once merged, change "coming soon" in README / README_zh to `winget install N2NS.n2n-nexus-host`, and submit later versions from the `winget-manifests.zip` of each release
- [ ] Boot check of `service install` on Windows: the scheduled task's AtStartup trigger has not been tried with a reboot (install, restart and supervisor restart were checked on 2026-10-23)
- [ ] LAN test from a second machine — discovery, firewall rules (TCP and UDP 5688) and direct messages across machines; so far everything ran on one Windows machine
- [ ] Codex messages left waiting after Codex restarts — the background wait ends with the Codex app and `codex queue` only starts a turn for a conversation loaded in the app, so messages wait until the user prompts that conversation; consider a per-machine waker that loads the conversation through the app-server
- [ ] Hide Codex background sessions (e.g. `codex@memories`) from peers and the SessionStart introduction; they never answer
- [ ] Readable session names (conversation title instead of `codex@n2n-bridge#3`)
- [ ] Tell automatic turns apart from user prompts by content instead of the one-minute window (see ARCHITECTURE known limits)
- [ ] A woken turn announces the same message again on UserPromptSubmit and can count one extra automatic turn
- [ ] Sessions marked offline after 30 minutes without activity do not notify their notifyWhenIdle subscribers
- [ ] `uninstall` runs `<client> --version` first (`src/cli/install.ts`) and fails when the client is not on PATH, leaving our hook entries in its config file; clean the config files even when the client cannot be run

### Future
- [ ] Code signing for the Go host binaries — the first releases ship unsigned (Windows SmartScreen / Defender warnings; macOS avoided with a Homebrew formula built from source). Windows: apply for free open-source signing at SignPath.io (n2n-nexus is Apache-2.0), or buy a Certum open-source code signing certificate; macOS notarization needs the Apple Developer Program ($99/year). Signing adds one release step and changes nothing else
- [ ] Authentication layer — API key for host access (production deployments)
- [ ] Cross-machine live sync — host-to-host bridge (beyond baseline scope)
- [ ] IDE sidebar integration — optional SSE endpoint for real-time message display
- [ ] Streaming task progress — periodic progress notifications

---

## Completed History

### ✅ 2026-01-14: Stability & Automation (v0.4.2)
- Lefthook integration (lint on commit, build+test on push)
- E2E test stability fixes

### ✅ 2026-01-08: Global Hub Architecture (v0.3.0)
- Auto Host election, SSE communication, heartbeat/watchdog
- (Superseded by daemon architecture in v0.5.0)

### ✅ 2026-01-01: Token Economy Optimization (v0.2.1)
- Hand-crafted tool definitions (-49% token reduction)
- Incremental read cursor for messages
- Context7-style progressive topology loading

### ✅ 2025-12-31: Task Primitive System (v0.2.0)
- Async task lifecycle (create/get/list/cancel)
- Meeting + Task separation
- Zod type safety

### ✅ 2025-12-30: Meeting Architecture (v0.1.8)
- SQLite WAL backend with JSON fallback
- Meeting lifecycle (start/end/archive/reopen)
- Read cursors per instance
