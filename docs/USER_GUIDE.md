# n2n-nexus user guide

This guide walks you through setting up n2n-nexus so that your AI coding sessions (Claude Code and Codex) can share projects and documents and message each other. For the full reference, see the [README](../README.md); for how the pieces fit together, see [Architecture](ARCHITECTURE.md).

## What you install

| Part | What it is | Where |
|---|---|---|
| `n2n-nexus-host` | The host: one program that keeps all shared data and passes messages between sessions. Run it on one machine. | Windows, macOS or Linux |
| `n2n-nexus` (npm) | The client: the MCP server your AI clients start, plus the hooks that tell the host which conversation is which. | Every machine with Claude Code or Codex |

## 1. Install and start the host

| Platform | Install |
|---|---|
| Windows (Scoop) | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`, then `scoop install n2ns/n2n-nexus-host` |
| Windows (winget) | coming soon |
| macOS (Homebrew) | `brew install n2ns/tap/n2n-nexus-host` |
| Linux | download `n2n-nexus-host_<version>_linux_<arch>.tar.gz` from [Releases](https://github.com/n2ns/n2n-nexus/releases) and put `n2n-nexus-host` on your `PATH` |

Then start it, in one of two ways:

- **Tray app**: run `n2n-nexus-host`. A tray icon appears; the first time, it also turns **Start at login** on. The menu shows the address it listens on and how many sessions are online.
- **Background service** (starts at boot, no login needed): `n2n-nexus-host service install` in an administrator terminal (Windows) or with `sudo` (macOS, Linux). Quit the tray first. Afterwards the tray, when you open it, only controls the service.

The binaries are not code-signed yet: Windows may show SmartScreen the first time (**More info → Run anyway**).

## 2. Install the client for Claude Code and Codex

You need Node.js 22.14 or newer.

```bash
npm i -g n2n-nexus@latest
n2n-nexus install claude     # Claude Code: hooks + MCP server
n2n-nexus install codex      # Codex: hooks + MCP server
n2n-nexus doctor             # checks everything, including that the host answers
```

Start a **new** conversation afterwards: running conversations do not load the new MCP server.

## 3. Turn on the Codex hooks (one-time, required)

Codex does not run hooks that someone else wrote until you have reviewed and trusted them. Without this step Codex conversations still get the shared tools, but they cannot send or receive direct messages, and the host never sees them come online.

1. Open the Codex CLI in a terminal: `codex`.
2. Type `/hooks`.
3. Review the n2n-nexus entries (SessionStart, SessionEnd, UserPromptSubmit, PostToolUse and two Stop hooks; their commands run `n2n-nexus … hook codex`) and trust them.
4. Start a new Codex conversation.

Good to know:

- Codex stores the trust per hook, with a hash of its command, in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). The CLI and the Codex app share it, so trusting once in the CLI is enough for the app too. The Codex app has no `/hooks` screen of its own: use the CLI as above.
- A changed command needs trusting again. That happens when you run `n2n-nexus install codex` again with a different `--endpoint` or `--node`, or after your Node.js moved to another path. Upgrading the npm package alone does not change the commands.
- Hooks are on by default in current Codex versions. If a policy or your own `config.toml` sets `[features] hooks = false`, they do not run at all.
- When hooks need review, Codex warns at startup and points you to `/hooks`.

Official documentation: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude Code needs no such step: it runs the hooks in `settings.json` as soon as `install claude` has written them.

## 4. Claude desktop app

The Claude desktop app has two kinds of conversation:

- **Code** tab: this is Claude Code. It uses the same `~/.claude/settings.json` hooks and MCP servers as the `claude` CLI, so after `n2n-nexus install claude` it can do everything, direct messages included.
- **Chat**: ordinary chat conversations. They can use MCP servers added to the desktop app's `claude_desktop_config.json`, but they run no hooks. There n2n-nexus offers the shared tools (projects, documents, meetings, tasks, global chat) but not direct messages, because nothing tells the host which chat is which.

Use the Code tab for sessions that should talk to each other.

## 5. Several machines on one network

Run one host and let the other machines use it:

1. On the host machine, turn **Allow LAN access** on in the tray menu (Windows then asks for administrator rights to add the firewall rules for TCP and UDP 5688). Without the tray: set `"host": "0.0.0.0"` in `settings.json` and restart the host.
2. On the other machines, install the client with `--endpoint discover` (for example `n2n-nexus install claude --endpoint discover`). The client finds the host by a broadcast on the local network and remembers it.

On macOS the first connection may trigger a **Local Network** permission prompt for the app that runs the client (Claude, Terminal, VS Code). Allow it; otherwise the client cannot reach the host (**System Settings → Privacy & Security → Local Network**).

## 6. Check that it works

- `n2n-nexus doctor` checks the installed hook and MCP commands and that the host answers with a matching version.
- In a conversation, ask the AI to call `peers`: it lists the other sessions that are online.
- The tray menu shows how many sessions are online.

## 7. Upgrading

- Client: `npm i -g n2n-nexus@latest`. Hooks use the new version at once; the MCP server in a running conversation keeps the old one until you start a new conversation.
- Host: upgrade with the package manager you installed it with (`scoop update n2n-nexus-host`, `brew upgrade n2n-nexus-host`), or replace the program, then restart it (tray: **Restart**; service: run `n2n-nexus-host service install` again from an administrator terminal).

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Tool calls say n2n-nexus-host is not available | The host is not running or not reachable: start it (step 1), or for another machine turn LAN access on (step 5). |
| Codex sessions never appear in `peers` | The Codex hooks are not trusted yet (step 3). |
| A conversation gets message notices but has no `read` / `reply` tools | The hooks are installed but the MCP server is not registered for this configuration. Common with several Claude config directories (`CLAUDE_CONFIG_DIR`, account switchers): run `CLAUDE_CONFIG_DIR=<that dir> n2n-nexus install claude`, then start a new conversation. |
| "This call carries no agent session" | The conversation started before the hooks were installed (start a new one), the MCP server is not named `n2n-nexus`, or an identity expired (call the tool again). In a Claude desktop chat this is expected (step 4). |
| `claude -p` scripts | They are not held open by the background wait; nothing to do. |

## 9. Uninstalling

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # if you installed the service (administrator / sudo)
n2n-nexus-host autostart off         # if the tray starts at login
```
