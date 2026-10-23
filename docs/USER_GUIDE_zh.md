# n2n-nexus 使用指南

本指南一步步介绍如何配置 n2n-nexus，让你的 AI 编程会话（Claude Code 和 Codex）共享项目和文档、互相发消息。完整参考见 [README](README_zh.md)，各部分如何协作见[架构说明](ARCHITECTURE_zh.md)。

## 要安装什么

| 组件 | 是什么 | 装在哪 |
|---|---|---|
| `n2n-nexus-host` | host：保存所有共享数据、在会话之间传递消息的程序。只需在一台机器上运行。 | Windows、macOS 或 Linux |
| `n2n-nexus`（npm） | 客户端：AI 客户端启动的 MCP 服务器，以及告诉 host"这是哪个对话"的 hooks。 | 每台装了 Claude Code 或 Codex 的机器 |

## 1. 安装并启动 host

| 平台 | 安装 |
|---|---|
| Windows（Scoop） | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`，再 `scoop install n2ns/n2n-nexus-host` |
| Windows（winget） | 即将提供 |
| macOS（Homebrew） | `brew install n2ns/tap/n2n-nexus-host` |
| Linux | 从 [Releases](https://github.com/n2ns/n2n-nexus/releases) 下载 `n2n-nexus-host_<版本>_linux_<架构>.tar.gz`，把 `n2n-nexus-host` 放到 `PATH` 里 |

然后用下面两种方式之一启动：

- **托盘程序**：运行 `n2n-nexus-host`，任务栏会出现托盘图标；第一次运行时还会自动打开**登录后自启**。菜单里显示监听地址和在线会话数。
- **后台服务**（开机即启动，不用登录）：在管理员终端（Windows）或用 `sudo`（macOS、Linux）运行 `n2n-nexus-host service install`。安装前先退出托盘；之后再打开托盘，它只作为服务的控制界面。

程序暂未做代码签名：Windows 第一次运行可能弹出 SmartScreen（点**更多信息 → 仍要运行**）。

## 2. 为 Claude Code 和 Codex 安装客户端

需要 Node.js 22.14 或更新版本。

```bash
npm i -g n2n-nexus
n2n-nexus install claude     # Claude Code：hooks + MCP 服务器
n2n-nexus install codex      # Codex：hooks + MCP 服务器
n2n-nexus doctor             # 全面检查，包括 host 是否应答
```

装完后要**新开**对话：正在进行的对话不会加载新的 MCP 服务器。

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

## 5. 同一网络里的多台机器

只运行一个 host，让其他机器都用它：

1. 在 host 所在的机器上，在托盘菜单里打开**允许局域网访问**（Windows 会请求管理员权限，添加 TCP 和 UDP 5688 的防火墙规则）。没有托盘时：把 `settings.json` 里的 `"host"` 改成 `"0.0.0.0"` 并重启 host。
2. 在其他机器上用 `--endpoint discover` 安装客户端（例如 `n2n-nexus install claude --endpoint discover`）。客户端会在局域网里广播查找 host，并记住找到的地址。

macOS 上第一次连接时，系统可能会为运行客户端的应用（Claude、终端、VS Code）弹出**本地网络**权限提示。请允许；否则客户端连不上 host（**系统设置 → 隐私与安全性 → 本地网络**）。

## 6. 检查是否正常

- `n2n-nexus doctor` 检查已安装的 hook 和 MCP 命令，以及 host 是否应答、版本是否匹配。
- 在对话里让 AI 调用 `peers`：它会列出在线的其他会话。
- 托盘菜单里显示在线会话数。

## 7. 升级

- 客户端：`npm i -g n2n-nexus`。hooks 立即用上新版本；正在进行的对话里的 MCP 服务器仍是旧版本，新开对话后才换。
- host：用当初安装它的包管理器升级（`scoop update n2n-nexus-host`、`brew upgrade n2n-nexus-host`），或直接替换程序，然后重启（托盘：**重启**；服务：在管理员终端里再运行一次 `n2n-nexus-host service install`）。

## 8. 常见问题

| 现象 | 原因和解决办法 |
|---|---|
| 工具调用提示 n2n-nexus-host 不可用 | host 没运行或连不上：启动它（第 1 步）；如果在另一台机器上，打开局域网访问（第 5 步）。 |
| `peers` 里一直看不到 Codex 会话 | Codex 的 hooks 还没被信任（第 3 步）。 |
| 对话能收到消息通知，却没有 `read` / `reply` 工具 | hooks 装了，但这个配置下没注册 MCP 服务器。多个 Claude 配置目录（`CLAUDE_CONFIG_DIR`、账号切换工具）时常见：运行 `CLAUDE_CONFIG_DIR=<那个目录> n2n-nexus install claude`，再新开对话。 |
| 提示"This call carries no agent session" | 对话是在安装 hooks 之前开的（新开一个）、MCP 服务器名不是 `n2n-nexus`，或者身份过期（再调用一次）。在 Claude 桌面版的聊天里这是正常的（第 4 步）。 |
| `claude -p` 脚本 | 不会被后台等待拖住，无需处理。 |

## 9. 卸载

```bash
n2n-nexus uninstall claude
n2n-nexus uninstall codex
n2n-nexus-host service uninstall     # 如果装了服务（管理员终端 / sudo）
n2n-nexus-host autostart off         # 如果托盘设置了登录后自启
```
