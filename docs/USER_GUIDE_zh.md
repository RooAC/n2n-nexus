# n2n-nexus 使用指南

本指南介绍如何安装、配置和运行 n2n-nexus，让你的 AI 编程会话（Claude Code 和 Codex）共享项目和文档、互相发消息。内部如何工作见[架构说明](ARCHITECTURE_zh.md)，工具说明见[工具参考](TOOLS_REFERENCE.md)。

## 要安装什么

| 组件 | 是什么 | 装在哪 |
|---|---|---|
| `n2n-nexus-host` | host：保存所有共享数据、在会话之间传递消息的程序。只需在一台机器上运行。 | Windows、macOS 或 Linux |
| `n2n-nexus`（npm） | 客户端：AI 客户端启动的 MCP 服务器，以及告诉 host"这是哪个对话"的 hooks。 | 每台装了 Claude Code 或 Codex 的机器 |

## 1. 安装并启动 host

| 平台 | 安装 |
|---|---|
| Windows（Scoop） | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`，然后 `scoop install n2ns/n2n-nexus-host` |
| Windows（winget） | 即将提供 |
| macOS（Homebrew） | `brew install n2ns/tap/n2n-nexus-host` |
| Linux | 从 [Releases](https://github.com/n2ns/n2n-nexus/releases) 下载 `n2n-nexus-host_<版本>_linux_<amd64\|arm64>.tar.gz`，解压后把 `n2n-nexus-host` 放到 `PATH` 里 |

[Releases](https://github.com/n2ns/n2n-nexus/releases)（标签 `host-v<版本>`）里有各平台的压缩包：Windows 为 `n2n-nexus-host_<版本>_<os>_<arch>.zip`，macOS 和 Linux 为 `.tar.gz`，均有 amd64 和 arm64。用 Release 里的 `SHA256SUMS` 和构建证明校验下载的文件：

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify n2n-nexus-host_<版本>_<os>_<arch>.tar.gz --repo n2ns/n2n-nexus
```

然后用下面两种方式之一启动：

- **托盘程序**：不带参数运行 `n2n-nexus-host`。托盘菜单显示监听地址和在线会话数，可以打开日志目录和数据目录、切换局域网访问、重启 host、开关 **登录后自启**（`n2n-nexus-host autostart on|off` 效果相同）。托盘第一次运行时会自动打开 **登录后自启**，之后保持你的设置。中文系统显示中文菜单，其他系统显示英文。
- **后台服务**（开机即启动，不用登录，不带托盘）：在管理员终端（Windows）或用 `sudo`（macOS、Linux）执行 `n2n-nexus-host service install`。服务以安装它的用户身份运行。先退出托盘：托盘正在运行 host 时 `service install` 会拒绝执行。服务在运行时，之后启动的托盘只做控制界面。

需要知道的：

- 程序暂未做代码签名。Windows 上第一次运行 `n2n-nexus-host.exe` 或 `n2n-nexus-host-tray.exe` 可能弹出 SmartScreen 提示：点 **更多信息 → 仍要运行**。Homebrew 在你的 Mac 上从源码编译 host，所以不会有 Gatekeeper 提示。
- Windows 安装包里有两个程序：`n2n-nexus-host.exe` 用于命令，`n2n-nexus-host-tray.exe` 是托盘程序，不会打开控制台窗口。不带参数运行 `n2n-nexus-host` 会启动托盘程序后立即返回。
- Linux 上的托盘需要桌面环境支持 StatusNotifierItem（AppIndicator）；没有桌面的服务器请用 `service install`。
- 各系统上服务和登录后自启注册在哪里，见[架构说明](ARCHITECTURE_zh.md#各平台的托盘与服务)。

## 2. 为 Claude Code 和 Codex 安装客户端

运行环境要求 Node.js 22.x 中的 22.14.0 或更高版本，或 Node.js 23.6.0 及以上版本。

```bash
npm i -g n2n-nexus@latest
n2n-nexus install claude     # ~/.claude/settings.json（或 $CLAUDE_CONFIG_DIR）+ claude mcp add --scope user
n2n-nexus install codex      # ~/.codex/hooks.json（或 $CODEX_HOME）+ codex mcp add
n2n-nexus doctor             # 全面检查，包括 host 是否应答
```

`install` 把 hooks 和 MCP 服务写进客户端的用户级配置。装完后要**新开**对话：正在进行的对话不会加载新的 MCP 服务器。

- host 不在 `http://127.0.0.1:5688` 时，两条命令都加上 `--endpoint <url>`；要在局域网里自动查找 host，就用 `--endpoint discover`（第 6 步）。
- 在 Windows 上，`npm i -g` 和 `install` 要在普通终端里执行，不要在 Codex 这类打包应用自带的终端里执行：那里会装进该应用私有的 `%APPDATA%` 副本，并让应用看不到全局安装。
- hooks 和 MCP 服务的命令里写的是 Node 的绝对路径，因为从 Dock 启动的 GUI 客户端（如 Claude 桌面版）不读取 shell 的 `PATH`。默认情况下，`PATH` 上的 `node` 与运行 `install` 的 Node 是同一个文件时，`install` 写入 `PATH` 上的路径（例如 `/usr/local/bin/node`、`/opt/homebrew/bin/node`、`~/.local/bin/node` 或版本管理工具的稳定入口），否则写入当前运行的 Node 的真实路径。`install` 会打印一行 `Node: <path>` 显示实际写入的路径。
- 用 `--node <path>` 手动指定 Node 路径。路径必须存在、可执行，且版本满足 package.json 的 `engines`（`^22.14.0 || >=23.6.0`），否则 `install` 以退出码 1 退出，不写任何配置。
- 升级 Node 后：如果 `install` 提示 Node 路径位于带版本号的目录（Homebrew `Cellar`、nvm、fnm、Volta、asdf、`node-v<版本>`），每次升级 Node 后都要重新运行 `n2n-nexus install <claude|codex>`，或用 `--node` 指定稳定路径。
- 支持 Linux、WSL 和 macOS；Codex hooks 也支持 Windows PowerShell。

## 3. 启用 Codex 的 hooks（只需一次，必须做）

Codex 不会运行别人写的 hooks，除非你审阅并信任了它们。不做这一步，Codex 对话仍能用共享工具，但收发不了私信，host 也看不到它们上线。

1. 在终端里打开 Codex 命令行：`codex`。
2. 输入 `/hooks`。
3. 审阅 n2n-nexus 的几条 hook（SessionStart、SessionEnd、UserPromptSubmit、PostToolUse 和两条 Stop，命令都是 `n2n-nexus … hook codex`），然后信任它们。
4. 新开一个 Codex 对话。

需要知道的：

- Codex 按每条 hook 记录信任，连同它命令的哈希，存在 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）里。命令行和 Codex 桌面应用共用这份记录，所以在命令行里信任一次，桌面应用也生效。Codex 桌面应用没有自己的 `/hooks` 界面，请按上面的步骤用命令行。
- 命令变了就要重新信任。比如用不同的 `--endpoint` 或 `--node` 重新运行 `n2n-nexus install codex`，或者 Node.js 换了路径之后。只升级 npm 包不会改变命令。
- 当前版本的 Codex 默认开启 hooks。如果管理策略或你自己的 `config.toml` 里设置了 `[features] hooks = false`，hooks 就完全不会运行。
- 有 hooks 需要审阅时，Codex 启动时会给出提示，指向 `/hooks`。

官方文档：[Codex hooks](https://learn.chatgpt.com/docs/hooks)。

Claude Code 不需要这一步：`install claude` 写入 `settings.json` 后，hooks 立即生效。

## 4. Claude 桌面版

Claude 桌面版里有两种对话：

- **Code 标签页**：就是 Claude Code。它和 `claude` 命令行用同一份 `~/.claude/settings.json` 的 hooks 和 MCP 服务器，所以 `n2n-nexus install claude` 之后什么都能用，包括私信。
- **聊天**：普通的聊天对话。它能用加在桌面版 `claude_desktop_config.json` 里的 MCP 服务器，但不运行 hooks。在这里 n2n-nexus 只提供共享工具（项目、文档、会议、任务、全局聊天），不提供私信，因为没有东西告诉 host 这是哪个聊天。

需要互相发消息的会话，请在 Code 标签页里开。

## 5. 其他 MCP 客户端

其他 MCP 客户端可以使用除直接消息以外的全部工具：

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

适配器可以先于 host 启动。host 可访问后，适配器会加载工具列表。适配器和 hooks 从不自己启动 host：连不上时，工具调用会报错并说明如何启动（远程地址则提示需在那台机器上启动），hooks 则静默跳过。host 没有及时应答的调用只让这一次失败，host 可能仍会执行完。

## 6. 多台机器和多个环境

host 默认只监听 `127.0.0.1`。要让它成为可信网络里其他机器的 host：

1. 在 host 所在的机器上打开局域网访问：
   - 托盘：勾选 **允许局域网访问**。托盘把 `"host": "0.0.0.0"` 写进 `settings.json` 并重启 host。Windows 上会在 UAC 确认后添加 TCP 端口和 UDP 发现端口（默认都是 5688）的入站防火墙规则；macOS 和 Linux 上会提示需要在防火墙放行的端口。
   - 服务：`n2n-nexus-host service install --host 0.0.0.0` 把地址写进 `settings.json`；防火墙里的 TCP 5688 和 UDP 5688 需要自己放行。
2. 在其他机器上用 `--endpoint discover` 安装客户端（例如 `n2n-nexus install claude --endpoint discover`），或者直接写 host 的地址。

设为 `discover` 时，适配器和 hooks 在 UDP `NEXUS_DISCOVERY_PORT` 上广播查询，使用第一个应答的 host；结果缓存在 `~/.n2n-nexus/discovered-endpoint`，连不上该 host 时重新查找。只有监听非回环地址（开启了局域网访问）的 host 才应答，所以要在它的防火墙上对可信网络放行 UDP 和 TCP 5688。没有应答时，客户端使用 `http://127.0.0.1:5688`（本机的 host），一分钟后再查找。

| 场景 | `--endpoint` / `NEXUS_ENDPOINT` |
| --- | --- |
| 同一台机器 | `http://127.0.0.1:5688` |
| WSL IDE 连接 Windows host | `http://host.docker.internal:5688` |
| Windows IDE 连接 WSL host | `http://<WSL-IP>:5688` |
| 远程机器 | `http://<Server-IP>:5688` |
| 在局域网里自动查找 host | `discover` |

macOS 上第一次连接时，系统可能会为运行客户端的应用（Claude、终端、VS Code）弹出**本地网络**权限提示。请允许；否则客户端连不上 host（**系统设置 → 隐私与安全性 → 本地网络**）。

## 7. 对话之间的直接消息

每个对话都会出现在 `peers` 里。新消息会自动通知收件方：用户发来新消息时、每次工具调用后、本轮结束前一次。收件方用 `read` 读取正文。空闲的对话也会被叫醒：每轮结束时，一个后台 hook 最多等待一小时，有新消息就让对话开始新的一轮（Claude Code 通过 `asyncRewake` hook，Codex 通过 `codex queue`），AI 会话之间无需有人输入就能互相回复。无人值守的 `claude -p` 不会被它拖住：这时该 hook 立即返回。Codex 对话只有在运行中的 Codex 应用里已加载时才能被叫醒；Codex 重启后，要等该对话再结束一轮才会恢复，限制详见[架构说明](ARCHITECTURE_zh.md#会话在线状态与唤醒空闲对话)。开启 `listen` 后，对话结束一轮时会继续等待最多约 10 分钟，消息一到就接着处理；等待期间你输入的内容会排队，按 Esc 才会立即发出。

## 8. 检查是否正常

- `n2n-nexus doctor [claude|codex]` 检查已安装的 hook 命令和 MCP 命令里的 Node 路径与入口脚本是否仍然存在、能否运行，以及它们连接的 host 是否应答、协议版本是否与客户端一致，有检查失败时以退出码 1 退出。
- 在对话里让 AI 调用 `peers`：它会列出在线的其他会话。
- 托盘菜单里显示在线会话数。

## 9. 升级

- 客户端：`npm i -g n2n-nexus@latest`。hooks 立即用上新版本；正在进行的对话里的 MCP 服务器仍是旧版本，新开对话后才换。
- host：用当初安装它的包管理器升级（`scoop update n2n-nexus-host`、`brew upgrade n2n-nexus-host`），或直接替换程序，然后重启（托盘：**重启**；服务：在管理员终端里再运行一次 `n2n-nexus-host service install`）。

## 10. 常见问题

| 现象 | 原因和解决办法 |
|---|---|
| 工具调用提示 n2n-nexus-host 不可用 | host 没运行或连不上：启动它（第 1 步）；如果在另一台机器上，打开局域网访问（第 6 步）。 |
| `peers` 里一直看不到 Codex 会话 | Codex 的 hooks 还没被信任（第 3 步）。 |
| 对话能收到消息通知，却没有 `read` / `reply` 工具 | hooks 装了，但这个配置下没注册 MCP 服务器。多个 Claude 配置目录（`CLAUDE_CONFIG_DIR`、账号切换工具）时常见：运行 `CLAUDE_CONFIG_DIR=<那个目录> n2n-nexus install claude`，再新开对话。 |
| 提示"This call carries no agent session" | 对话是在安装 hooks 之前开的（新开一个）、MCP 服务器名不是 `n2n-nexus`，或者身份过期（再调用一次）。在 Claude 桌面版的聊天里这是正常的（第 4 步）。 |
| `claude -p` 脚本 | 不会被后台等待拖住，无需处理。 |

## 11. 卸载

`n2n-nexus uninstall <claude|codex>` 删除 `install` 写入的 hooks 和 MCP 服务，配置里的其他内容不动。

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # 如果装了服务（管理员终端 / sudo）
n2n-nexus-host autostart off         # 如果托盘设置了登录后自启
```

## 12. 参考

### n2n-nexus-host 命令

```bash
# 托盘程序（默认）
n2n-nexus-host

# 前台运行，不带托盘；参数覆盖 settings.json（--port 0 表示任选空闲端口）
n2n-nexus-host serve [--host 127.0.0.1] [--port 5688] [--root <dir>]

# 开机启动的后台服务（Windows 需管理员终端，macOS / Linux 用 sudo）。
# 托盘正在运行 host 时 install 拒绝执行（先退出托盘；再打开时它控制服务），
# 否则把 --host / --port 写进 settings.json，停掉为该数据目录运行的 host，
# 注册并启动服务，最后报告端口上是谁在应答。
# uninstall 删除服务并停掉服务的 host；托盘和前台 serve 继续运行。
n2n-nexus-host service install [--host <addr>] [--port <port>] [--root <dir>]
n2n-nexus-host service uninstall [--root <dir>]
n2n-nexus-host service status [--host <addr>] [--port <port>] [--root <dir>]

# 托盘登录后自启 / 取消
n2n-nexus-host autostart on|off

n2n-nexus-host version
```

用 `sudo` 执行时，服务使用执行 `sudo` 的用户的默认数据目录和日志目录，除非 `--root` 指定了别的数据目录。每个数据目录只能运行一个 host：第二个会报“another n2n-nexus-host is running”并退出。

### n2n-nexus 命令

```bash
# 启动 MCP 适配器（由 IDE 启动）
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp [--id <实例 ID>]

# 为 Claude Code 或 Codex 安装 / 删除 hooks 和 MCP 服务
n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
n2n-nexus uninstall <claude|codex>

# 检查已安装的 hook 和 MCP 命令是否还能运行，以及 host 是否以相同协议版本应答（有问题时退出码 1）
n2n-nexus doctor [claude|codex]

# hook 入口（由 install 写进客户端配置）
n2n-nexus hook <claude|codex> [--endpoint <url>] [--wait]
```

### 环境变量

客户端（`n2n-nexus`）：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | MCP 适配器、hooks 和 `doctor` 连接的 host 地址，设为 `discover` 时在局域网里查找 | `http://127.0.0.1:5688` |
| `NEXUS_DISCOVERY_PORT` | 客户端用 `discover` 查询时使用的 UDP 端口 | `5688` |
| `NEXUS_INSTANCE_ID` | 覆盖 MCP 实例 ID（未读游标、会议权限都以它为键） | `mcp-<主机名>-<工作目录哈希>-<IDE 名>` |
| `NEXUS_CODEX_COMMAND` | Codex 后台等待以 `<命令> queue ...` 方式运行的命令 | `codex` |

host（`n2n-nexus-host`）：只读取 `NEXUS_ROOT`，即数据目录（`--root` 优先）。其余 host 设置都在 `settings.json` 里，托盘、服务和命令行共用。

### settings.json

host 启动时读取；命令行参数优先。文件或字段缺失时使用默认值。

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `host` | 监听地址（IPv4 地址只监听 IPv4，IPv6 地址只监听 IPv6）；`0.0.0.0` 让局域网可以访问 | `"127.0.0.1"` |
| `port` | TCP 端口 | `5688` |
| `discoveryPort` | 局域网发现的 UDP 端口，只有 `host` 不是回环地址时才应答 | `5688` |
| `allowedHosts` | `Host` 头额外允许的域名（IP、`localhost`、`host.docker.internal` 始终允许） | `[]` |
| `rateLimit` | 每个实例每秒工具调用数，每个客户端地址为其 5 倍；hooks 另有独立额度：每个对话同样速率，每个客户端地址 5 倍。`0` 关闭限流 | `20` |
| `rateBurst` | 每个实例可一次性突发的调用数（最小为 1） | `60` |
| `maxAutoTurns` | 两次用户输入之间，一个对话最多可以自动继续的轮数（包括被叫醒、listen 等待、因消息被拦下不结束）；超过后消息只排队，等用户下次输入。`0` 表示不限制 | `8` |

改完文件后重启 host（托盘 **重启**，或重启 `serve` / 服务）。

### 数据和日志

host 把全部协作数据保存在数据目录里的一个 SQLite 数据库中：

| 平台 | 数据目录 | 日志目录 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\n2n-nexus` | `%LOCALAPPDATA%\n2n-nexus\logs` |
| macOS | `~/Library/Application Support/n2n-nexus` | `~/Library/Logs/n2n-nexus` |
| Linux | `$XDG_DATA_HOME/n2n-nexus`（默认 `~/.local/share/n2n-nexus`） | `$XDG_STATE_HOME/n2n-nexus`（默认 `~/.local/state/n2n-nexus`） |

可以通过 `--root <path>` 或 `NEXUS_ROOT` 改数据目录。

```text
<数据目录>/
├── nexus.db          # 项目、资产、文档、会议、全局聊天、事件、任务、未读游标、对话和直接消息
├── settings.json     # host 设置（见上）
└── host.lock         # 每个数据目录只运行一个 host
```

后台服务，以及自己运行 host 时的托盘，把日志写到日志目录的 `host.log`（单个 10 MB，保留 3 个旧文件）；托盘自己的日志写到同一目录的 `tray.log`；`n2n-nexus-host serve` 输出到标准错误。host 删除哪些数据、什么时候删，见[架构说明](ARCHITECTURE_zh.md#清理与保留期)。

n2n-nexus 0.x 的数据（`~/.n2n-nexus`）不会导入：host 不读取它，也不动它。
