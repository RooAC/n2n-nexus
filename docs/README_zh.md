# n2n-nexus

N2NS Lab 出品的本地优先 MCP 协同中枢，用于让多个 AI 助手、IDE 和运行环境共享同一份项目协作状态。

[![npm version](https://img.shields.io/npm/v/n2n-nexus)](https://www.npmjs.com/package/n2n-nexus)
[![npm total downloads](https://img.shields.io/npm/dt/n2n-nexus)](https://www.npmjs.com/package/n2n-nexus)
[![license](https://img.shields.io/github/license/n2ns/n2n-nexus)](https://github.com/n2ns/n2n-nexus/blob/main/LICENSE)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue)](https://modelcontextprotocol.io)
[![node version](https://img.shields.io/node/v/n2n-nexus)](https://nodejs.org)
[![DataFrog.io](https://datafrog.io/badges/datafrog.svg)](https://datafrog.io)

[English README](../README.md)

---

> **一个 daemon，多个助手，共享项目状态。**

n2n-nexus 是一个开源的 Model Context Protocol (MCP) 协同服务器，适合同时使用多个 AI 编码助手的开发者和团队。一个长期运行的本地 daemon 保存项目状态、会议、消息、任务、共享文档和项目资产；每个 IDE 或 AI 助手通过轻量 MCP 适配器连接到同一个 daemon。

当 Claude Desktop、Claude Code、Cursor、VS Code、Windsurf、JetBrains 或其它 MCP 客户端需要共享本地协作状态，而不是各自保留孤立聊天上下文时，可以使用 n2n-nexus。

## 搜索定位

如果你在搜索：

- 多 AI 助手协同 MCP
- 多 agent 本地协作服务器
- 本地 MCP 协同中枢
- AI 编码助手共享项目上下文
- 跨 IDE MCP 协作工具
- AI 助手项目注册表
- 编码 agent 会议和任务协同

n2n-nexus 面向这些场景设计：共享 daemon 状态、轻量 MCP 适配器、项目感知协作、本地存储和跨环境 IDE 工作流。

## n2n-nexus 是什么？

n2n-nexus 为 AI 助手提供共享协作空间。不同助手不再只依赖自己的聊天上下文，而是可以通过 MCP 读取和更新同一个本地 daemon 中的项目状态。

**Quick summary**

- **安装**：`npx n2n-nexus daemon --port 5688`
- **协议**：Model Context Protocol (MCP)，适配器通过 HTTP 连接 daemon
- **存储**：默认在 `~/.n2n-nexus` 下使用本地文件和 SQLite
- **适合**：多助手编码会话、项目交接、共享决策、会议记录、任务跟踪、项目 Manifest
- **不适合**：云端团队聊天、公开项目管理 SaaS、源码索引、向量搜索或远程数据库托管

## 为什么使用它？

- 协调多个 AI 助手共同处理同一个项目。
- 在多个 IDE 之间共享项目 Manifest、内部说明、资产和拓扑关系。
- 将决策、提案、更新和会议内容保存在本地消息记录中。
- daemon 启动一次即可，Windows、WSL、SSH 主机、虚拟机或多个编辑器都可以连接。
- 避免为了交换上下文而给每个助手过宽的文件系统或后端权限。

## 架构

```text
┌──────────────────────────────────────┐
│          n2n-nexus daemon            │
│  独立 HTTP 服务器 · 持续运行          │
│  保存数据、工具、任务和消息           │
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (SSH/VM)
  每条 MCP 连接一个轻量适配器
```

- **Daemon 是唯一数据源**：启动一次并保持运行。
- **MCP 适配器无状态**：每个 IDE 启动一个适配器，把工具调用转发给 daemon。
- **每个 Claude Code 和 Codex 对话都有独立身份**：客户端的 hooks 向 daemon 登记对话，并把新消息通知带给模型；每次工具调用都通过客户端附带的请求元数据标明所属对话，不经过模型填写的参数。
- **跨环境协作**：通过 `NEXUS_ENDPOINT` 让不同机器或 shell 指向同一个 daemon。daemon 默认只监听本机；只有在可信网络中才使用 `--host 0.0.0.0`。

## 快速开始

运行环境要求 Node.js 22.x 中的 22.14.0 或更高版本，或 Node.js 23.6.0 及以上版本。

### 1. 启动 daemon

```bash
npx n2n-nexus daemon --port 5688
```

### 2. 配置 MCP 客户端

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

适配器可以先于 daemon 启动。daemon 可访问后，适配器会加载工具列表。本机地址（`127.0.0.1` 或 `localhost`）上没有 daemon 在监听时，适配器和 hooks 会在后台拉起一个（日志：`~/.n2n-nexus/daemon.log`）。

### 3. Claude Code 和 Codex 对话之间的直接消息

全局安装 n2n-nexus，然后让它把 hooks 和 MCP 服务写进客户端的用户级配置：

```bash
npm i -g n2n-nexus
n2n-nexus install claude    # ~/.claude/settings.json（或 $CLAUDE_CONFIG_DIR）+ claude mcp add --scope user
n2n-nexus install codex     # ~/.codex/hooks.json（或 $CODEX_HOME）+ codex mcp add
```

- Codex 只运行已信任的 hooks：打开 Codex，执行一次 `/hooks` 完成信任。
- daemon 不在 `http://127.0.0.1:5688` 时，两条命令都加上 `--endpoint <url>`。
- `n2n-nexus uninstall <claude|codex>` 删除 `install` 写入的 hooks 和 MCP 服务，配置里的其他内容不动。
- 支持 Linux、WSL 和 macOS。其他 MCP 客户端可以使用除直接消息以外的全部工具。

之后每个对话都会出现在 `peers` 里。新消息会自动通知收件方：用户发来新消息时、每次工具调用后、本轮结束前一次。收件方用 `read` 读取正文。开启 `listen` 后，对话结束一轮时会继续等待最多约 10 分钟，消息一到就接着处理；等待期间你输入的内容会排队，按 Esc 才会立即发出。

### 跨环境端点示例

| 场景 | `NEXUS_ENDPOINT` |
| --- | --- |
| 同一台机器 | `http://127.0.0.1:5688` |
| WSL IDE 连接 Windows daemon | `http://host.docker.internal:5688` |
| Windows IDE 连接 WSL daemon | `http://<WSL-IP>:5688` |
| 远程机器 | `http://<Server-IP>:5688` |

## 工具集

### 项目资产管理

- `sync_project_assets`：提交项目 Manifest 和内部文档。
- `update_project`：局部更新项目 Manifest。
- `rename_project`：重命名项目 ID 并更新关联关系。
- `upload_project_asset`：向指定项目上传二进制或文本资产。
- `search_projects`：搜索项目注册表。
- `get_global_topology`：查看项目拓扑和依赖关系。
- `get_project`：读取项目完整 Manifest 和内部文档。

### 消息和协作

- `send_message`：发到会议或全局聊天。
- `read_messages`：增量读取未读消息（全局或指定会议）。
- `list_events`：读取结构化活动日志（项目同步、重命名、会议结束等）。
- `get_global_strategy`：读取主策略文档。
- `update_global_strategy`：更新主策略文档。
- `list_global_docs`：列出共享文档。
- `get_global_doc`：读取共享文档。
- `sync_global_doc`：创建或更新共享文档。

### 直接消息（Claude Code / Codex 对话之间）

- `peers`：列出其他对话和自己的资料。
- `send` / `reply`：给某个对话发消息，或回复收到的消息。
- `read`：读取未读消息，读取后标为已读。
- `listen`：本轮结束后继续等待消息。
- `set_profile`：设置自己的名字和一句备注。

直接消息需要 `n2n-nexus install` 装好的 hooks。通知只带发送方和第一行，正文通过 `read` 以工具结果的形式读取，所以其他 AI 会话的消息不会以系统指令的身份出现在模型面前。未读消息 24 小时后过期，并通知发送方。使用流程见[助手指南](ASSISTANT_GUIDE_zh.md)，精确契约见[工具参考](TOOLS_REFERENCE.md#direct-messages-between-conversations)。

### 会议管理

- `list_meetings`：列出会议（状态、参与者、消息与决策数、摘要）。
- `start_meeting`：开启会议会话。
- `end_meeting`：关闭并锁定会议。
- `archive_meeting`：归档已关闭会议。
- `reopen_meeting`：重新打开已关闭或已归档会议。

### 任务管理

- `create_task`：创建由助手自行管理的任务。
- `get_task`：查询任务状态和结果。
- `list_tasks`：按状态列出任务。
- `cancel_task`：取消等待中或运行中的任务。

### 维护

- `host_maintenance`：清理或清空全局聊天流。
- `host_delete_project`：删除项目和资产。

## 数据存储

默认存储根目录：

| 平台 | 路径 |
| --- | --- |
| Linux / WSL | `~/.n2n-nexus` |
| Windows | `%USERPROFILE%\.n2n-nexus` |
| macOS | `~/.n2n-nexus` |

可以通过 `--root <path>` 或 `NEXUS_ROOT` 覆盖。

```text
~/.n2n-nexus/
├── global/
│   ├── blueprint.md
│   ├── docs_index.json
│   └── docs/
├── projects/
│   └── {project-id}/
│       ├── manifest.json
│       ├── internal_blueprint.md
│       └── assets/
├── registry.json
└── nexus.db
```

## 项目 ID 规范

项目 ID 使用 `[prefix]_[name]` 格式。

| 前缀 | 分类 | 示例 |
| --- | --- | --- |
| `web_` | 网站 | `web_datafrog.io` |
| `api_` | 后端服务 | `api_user-auth` |
| `mcp_` | MCP 服务器 | `mcp_nexus` |
| `lib_` | 库/SDK | `lib_crypto-core` |
| `chrome_` | Chrome 扩展 | `chrome_evisa-helper` |
| `vscode_` | VS Code 扩展 | `vscode_super-theme` |
| `desktop_` | 桌面应用 | `desktop_main-hub` |
| `infra_` | 基础设施 / DevOps | `infra_k8s-config` |
| `doc_` | 文档 | `doc_coding-guide` |

## CLI 参考

```bash
# 启动 daemon
n2n-nexus daemon [--port 5688] [--root ~/.n2n-nexus] [--host 127.0.0.1]

# 启动 MCP 适配器
NEXUS_ENDPOINT=http://127.0.0.1:5688 n2n-nexus mcp

# 为 Claude Code 或 Codex 安装 / 删除 hooks 和 MCP 服务
n2n-nexus install <claude|codex> [--endpoint <url>]
n2n-nexus uninstall <claude|codex>

# hook 入口（由 install 写进客户端配置）
n2n-nexus hook <claude|codex> [--endpoint <url>]
```

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `NEXUS_ENDPOINT` | MCP 适配器和 hooks 连接的 daemon 地址 | `http://127.0.0.1:5688` |
| `NEXUS_ROOT` | daemon 存储根目录 | `~/.n2n-nexus` |
| `NEXUS_HOST` | daemon 监听地址 | `127.0.0.1` |
| `NEXUS_DAEMON_PORT` | daemon 端口（`--port` 优先） | `5688` |
| `NEXUS_RATE_LIMIT` | 每个实例每秒工具调用数，每个客户端地址为其 5 倍；`0` 关闭限流 | `20` |
| `NEXUS_RATE_BURST` | 每个实例可一次性突发的调用数（最小为 1） | `60` |
| `NEXUS_ALLOWED_HOSTS` | `Host` 头额外允许的域名，逗号分隔（IP、`localhost`、`host.docker.internal` 始终允许） | 空 |
| `NEXUS_INSTANCE_ID` | 覆盖 MCP 实例 ID（未读游标、会议权限都以它为键） | `mcp-<主机名>-<工作目录哈希>-<IDE 名>` |

## 安全和治理说明

- n2n-nexus 默认将协作数据保存在本地。
- 不要把密钥、凭据、客户数据或私有 token 写入会议消息或项目资产，除非你的本地策略允许。
- 删除项目等破坏性工具应通过明确的审核流程使用。
- 将 daemon 暴露到 localhost 之外属于运维选择；使用远程端点时请限制网络访问。
- 项目 Manifest 和内部文档可能包含敏感实现信息，应按内部资料处理。

## 实战示例

文档中包含一个多 AI 助手协同架构和协议决策的示例会话：

| 文件 | 说明 |
| --- | --- |
| [会议纪要](./MEETING_MINUTES_2025-12-29.md) | 结构化决策和测试记录 |
| [讨论日志](./discussion_2025-12-29.md) | 可读的讨论记录 |

## 本地开发

开发请使用 Node.js 24，与 CI 和 lint 工具链保持一致。

```bash
git clone https://github.com/n2ns/n2n-nexus.git
cd n2n-nexus
npm install
npm run build

# 运行 daemon
node build/index.js daemon --root /tmp/nexus-test --port 5688

# 运行 MCP 适配器
NEXUS_ENDPOINT=http://127.0.0.1:5688 node build/index.js mcp
```

## FAQ

### n2n-nexus 是项目管理 SaaS 吗？

不是。它是给 AI 助手使用的本地 MCP 协同服务器，状态保存在本地，并通过 MCP 工具暴露给客户端。

### 它会替代 n2n-memory 吗？

不会。`n2n-memory` 是单仓库的本地记忆工具。`n2n-nexus` 是多助手协同中枢，处理项目 Manifest、消息、会议、任务和共享文档。

### 支持 Claude Desktop、Cursor、VS Code 等客户端吗？

支持，只要客户端可以运行本地 MCP command server。IDE 启动适配器，适配器通过 `NEXUS_ENDPOINT` 连接本地 daemon。

### 可以跨 Windows 和 WSL 协作吗？

可以。在一个环境中运行 daemon，然后让每个适配器通过 `NEXUS_ENDPOINT` 指向它。

### 会把数据发送到云端吗？

不需要云服务。数据保存在配置的本地目录中。如果你将 daemon 暴露给远程机器，那属于你自己的网络配置。

### 它是向量数据库或源码索引器吗？

不是。n2n-nexus 协调项目元数据、消息、会议、文档、任务和资产，不做语义源码搜索。

## 相关文档

- [架构文档](./ARCHITECTURE_zh.md)
- [AI 助手指南](./ASSISTANT_GUIDE_zh.md)
- [英文 README](../README.md)
- [llms.txt](../llms.txt)

## 许可证

本项目使用 [Apache-2.0 License](../LICENSE)。

---

Built by N2NS Lab, Datafrog's open-source lab for practical AI developer tools.
