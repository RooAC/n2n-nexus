# n2n-nexus user guide

This guide covers installing, configuring and running n2n-nexus so that your AI coding sessions (Claude Code and Codex) can share projects and documents and message each other. For how the pieces work inside, see [Architecture](ARCHITECTURE.md); for the tools, see the [Tools reference](TOOLS_REFERENCE.md).

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
| Linux | download `n2n-nexus-host_<version>_linux_<amd64\|arm64>.tar.gz` from [Releases](https://github.com/n2ns/n2n-nexus/releases), extract it and put `n2n-nexus-host` on your `PATH` |

[Releases](https://github.com/n2ns/n2n-nexus/releases) (tags `host-v<version>`) has the archives for every platform: `n2n-nexus-host_<version>_<os>_<arch>.zip` for Windows and `.tar.gz` for macOS and Linux, amd64 and arm64. Verify a download against the release's `SHA256SUMS` and its build provenance:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify n2n-nexus-host_<version>_<os>_<arch>.tar.gz --repo n2ns/n2n-nexus
```

Then start it, in one of two ways:

- **Tray app**: run `n2n-nexus-host` without arguments. The tray menu shows the address it listens on and the number of online sessions, opens the log and data folders, switches LAN access on and off, restarts the host and turns **Start at login** on or off (`n2n-nexus-host autostart on|off` does the same). The first time the tray runs it turns **Start at login** on; after that it stays as you set it. The menu is in Chinese on a Chinese system and in English otherwise.
- **Background service** (starts at boot, no login needed, no tray): `n2n-nexus-host service install` from an elevated terminal (Windows) or with `sudo` (macOS, Linux). The service runs as the user who installed it. Quit the tray first: `service install` refuses while the tray runs the host. While the service runs, a tray started later only controls it.

Good to know:

- The binaries are not code-signed yet. On Windows, the first start of `n2n-nexus-host.exe` or `n2n-nexus-host-tray.exe` may show a SmartScreen warning: click **More info → Run anyway**. Homebrew builds the host from source on your Mac, so there is no Gatekeeper prompt.
- On Windows the package has two programs: `n2n-nexus-host.exe` for commands, and `n2n-nexus-host-tray.exe`, the tray, which opens no console window. `n2n-nexus-host` without arguments starts the tray program and returns.
- On Linux the tray needs a desktop with StatusNotifierItem (AppIndicator) support; on a server, use `service install`.
- Where the service and the start-at-login entry are registered on each OS: [Architecture](ARCHITECTURE.md#tray-and-service-per-os).

## 2. Install the client for Claude Code and Codex

Requires Node.js 22.14+ on the 22.x release line, or Node.js 23.6+.

```bash
npm i -g n2n-nexus@latest
n2n-nexus install claude     # ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR) + claude mcp add --scope user
n2n-nexus install codex      # ~/.codex/hooks.json (or $CODEX_HOME) + codex mcp add
n2n-nexus doctor             # checks everything, including that the host answers
```

`install` writes the hooks and the MCP server into the client's user configuration. Start a **new** conversation afterwards: running conversations do not load the new MCP server.

- Pass `--endpoint <url>` to both commands when the host is not at `http://127.0.0.1:5688`, or `--endpoint discover` to find a host on the LAN (step 6).
- On Windows, run `npm i -g` and `install` from a regular terminal, not from the terminal of a packaged app such as Codex: that terminal installs into the app's private copy of `%APPDATA%`, which hides the global install from the app.
- The hooks and the MCP server command use an absolute Node path, because GUI clients started from the Dock (such as Claude Desktop) do not read your shell's `PATH`. By default `install` writes the `node` found on `PATH` when it is the same file as the Node running `install` (for example `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `~/.local/bin/node` or a version manager's stable entry point), and otherwise the real path of the running Node. `install` prints the path it wrote as `Node: <path>`.
- Pass `--node <path>` to choose the Node path yourself. It must exist, be executable and satisfy the `engines` range in package.json (`^22.14.0 || >=23.6.0`); otherwise `install` exits with code 1 and writes nothing.
- After upgrading Node: if `install` warned that the Node path contains a version directory (Homebrew `Cellar`, nvm, fnm, Volta, asdf, `node-v<version>`), run `n2n-nexus install <claude|codex>` again after each upgrade, or pass `--node` with a stable path.
- Supported on Linux, WSL and macOS; Codex hooks also support Windows PowerShell.

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

## 5. Other MCP clients

Other MCP clients can use every tool except direct messages:

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

## 6. Several machines and environments

By default the host listens on `127.0.0.1` only. To make it the host for other machines on a trusted network:

1. On the host machine, turn LAN access on:
   - Tray: check **Allow LAN access**. The tray writes `"host": "0.0.0.0"` to `settings.json` and restarts the host. On Windows it adds inbound firewall rules for the TCP port and the UDP discovery port (5688 and 5688 by default) after a UAC prompt; on macOS and Linux it tells you which ports to allow in your firewall.
   - Service: `n2n-nexus-host service install --host 0.0.0.0` writes the address to `settings.json`; allow TCP 5688 and UDP 5688 in the firewall yourself.
2. On the other machines, install the client with `--endpoint discover` (for example `n2n-nexus install claude --endpoint discover`), or with the host's address.

With `discover`, the adapter and the hooks broadcast a query on UDP `NEXUS_DISCOVERY_PORT` and use the first host that answers; the result is cached in `~/.n2n-nexus/discovered-endpoint` and looked up again when that host cannot be reached. A host answers only when it listens on a non-loopback address (LAN access on), so allow UDP and TCP 5688 through its firewall for the trusted network. When none answers, the client uses `http://127.0.0.1:5688` (a host on this machine) and looks again after a minute.

| Scenario | `--endpoint` / `NEXUS_ENDPOINT` |
| --- | --- |
| Same machine | `http://127.0.0.1:5688` |
| WSL IDE to Windows host | `http://host.docker.internal:5688` |
| Windows IDE to WSL host | `http://<WSL-IP>:5688` |
| Remote machine | `http://<Server-IP>:5688` |
| Find a host on the LAN | `discover` |

On macOS the first connection may trigger a **Local Network** permission prompt for the app that runs the client (Claude, Terminal, VS Code). Allow it; otherwise the client cannot reach the host (**System Settings → Privacy & Security → Local Network**).

## 7. Direct messages between conversations

Each conversation appears in `peers`. A new direct message is announced to the recipient automatically: when the user sends a prompt, after each tool call, and once before the turn ends. The recipient reads the text with `read`. An idle conversation is woken too: when a turn ends, a background hook waits up to an hour for anything new and then starts a turn with it (Claude Code through an `asyncRewake` hook, Codex through `codex queue`), so AI sessions can answer each other without anyone typing. An unattended `claude -p` run is not kept waiting: the hook returns at once there. A Codex conversation is woken only while it is loaded in the running Codex app, and not again after Codex restarts until it ends a turn; see [Architecture](ARCHITECTURE.md#sessions-presence-and-waking-idle-conversations) for the limits. With `listen` on, a conversation that finished its turn keeps waiting for up to about 10 minutes and continues when a message arrives; while it waits, input you type is queued until you press Esc.

## 8. Check that it works

- `n2n-nexus doctor [claude|codex]` checks that the Node path and the entry script in the installed hook and MCP commands still exist and run, and that the host they talk to answers with the client's contract version; it exits with code 1 when a check fails.
- In a conversation, ask the AI to call `peers`: it lists the other sessions that are online.
- The tray menu shows how many sessions are online.

## 9. Upgrading

- Client: `npm i -g n2n-nexus@latest`. Hooks use the new version at once; the MCP server in a running conversation keeps the old one until you start a new conversation.
- Host: upgrade with the package manager you installed it with (`scoop update n2n-nexus-host`, `brew upgrade n2n-nexus-host`), or replace the program, then restart it (tray: **Restart**; service: run `n2n-nexus-host service install` again from an administrator terminal).

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Tool calls say n2n-nexus-host is not available | The host is not running or not reachable: start it (step 1), or for another machine turn LAN access on (step 6). |
| Codex sessions never appear in `peers` | The Codex hooks are not trusted yet (step 3). |
| A conversation gets message notices but has no `read` / `reply` tools | The hooks are installed but the MCP server is not registered for this configuration. Common with several Claude config directories (`CLAUDE_CONFIG_DIR`, account switchers): run `CLAUDE_CONFIG_DIR=<that dir> n2n-nexus install claude`, then start a new conversation. |
| "This call carries no agent session" | The conversation started before the hooks were installed (start a new one), the MCP server is not named `n2n-nexus`, or an identity expired (call the tool again). In a Claude desktop chat this is expected (step 4). |
| `claude -p` scripts | They are not held open by the background wait; nothing to do. |

## 11. Uninstalling

`n2n-nexus uninstall <claude|codex>` removes the hooks and the MCP server that `install` added and leaves the rest of the configuration alone.

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # if you installed the service (administrator / sudo)
n2n-nexus-host autostart off         # if the tray starts at login
```

## 12. Reference

### n2n-nexus-host commands

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

Under `sudo`, the service uses the default data and log directories of the user who ran `sudo`, unless `--root` names another data directory. Only one host runs per data directory: a second one exits with "another n2n-nexus-host is running".

### n2n-nexus commands

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

### Data and logs

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
├── settings.json     # host settings (see above)
└── host.lock         # one host per data directory
```

The background service, and the tray while it runs the host itself, log to `host.log` in the log directory (10 MB per file, 3 old files kept); the tray's own lines go to `tray.log` there; `n2n-nexus-host serve` logs to standard error. What the host deletes and when: [Architecture](ARCHITECTURE.md#maintenance-and-retention).

Data of n2n-nexus 0.x (`~/.n2n-nexus`) is not imported: the host does not read it and leaves it in place.
