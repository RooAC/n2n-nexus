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

> **一个 host，多个助手，共享项目状态。**

n2n-nexus 是一个开源的 Model Context Protocol (MCP) 协同服务器，适合同时使用多个 AI 编码助手的开发者和团队。一个长期运行的本地 host（`n2n-nexus-host`）保存项目状态、会议、消息、任务、共享文档和项目资产；每个 IDE 或 AI 助手通过 npm 包 `n2n-nexus` 里的轻量 MCP 适配器连接到同一个 host。

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

n2n-nexus 面向这些场景设计：共享 host 状态、轻量 MCP 适配器、项目感知协作、本地存储和跨环境 IDE 工作流。

## n2n-nexus 是什么？

n2n-nexus 为 AI 助手提供共享协作空间。不同助手不再只依赖自己的聊天上下文，而是可以通过 MCP 读取和更新同一个本地 host 中的项目状态。

**Quick summary**

- **安装**：host 用 Scoop / Homebrew / Release 压缩包安装 `n2n-nexus-host`；客户端 `npm i -g n2n-nexus@latest` 后执行 `n2n-nexus install <claude|codex>`
- **协议**：Model Context Protocol (MCP)，适配器通过 HTTP 连接 host
- **存储**：host 数据目录下的一个 SQLite 数据库
- **适合**：多助手编码会话、项目交接、共享决策、会议记录、任务跟踪、项目 Manifest
- **不适合**：云端团队聊天、公开项目管理 SaaS、源码索引、向量搜索或远程数据库托管

## 为什么使用它？

- 协调多个 AI 助手共同处理同一个项目。
- 在多个 IDE 之间共享项目 Manifest、内部说明、资产和拓扑关系。
- 将决策、提案、更新和会议内容保存在本地消息记录中。
- host 启动一次即可，Windows、WSL、SSH 主机、虚拟机或多个编辑器都可以连接。
- 避免为了交换上下文而给每个助手过宽的文件系统或后端权限。

## 架构

```text
┌──────────────────────────────────────┐
│           n2n-nexus-host             │
│  托盘程序或后台服务                   │
│  保存数据、工具、任务和消息           │
└──────────────┬───────────────────────┘
               │ HTTP (NEXUS_ENDPOINT)
       ┌───────┼───────┐
       ▼       ▼       ▼
    MCP-A   MCP-B   MCP-C
   (Win)   (WSL)   (SSH/VM)
  每条 MCP 连接一个 n2n-nexus 适配器
```

- **Host 是唯一数据源**：安装一次并保持运行，以托盘程序或后台服务的方式。
- **MCP 适配器无状态**：每个 IDE 启动一个适配器（`n2n-nexus mcp`），把工具调用转发给 host。
- **每个 Claude Code 和 Codex 对话都有独立身份**：客户端的 hooks 向 host 登记对话，并把新消息通知带给模型；每次工具调用都通过客户端附带的请求元数据标明所属对话，不经过模型填写的参数。
- **跨环境协作**：通过 `NEXUS_ENDPOINT` 让不同机器或 shell 指向同一个 host。host 默认只监听 `127.0.0.1`；只有在可信网络中才开启局域网访问。

## 快速开始

1. 安装并启动 host `n2n-nexus-host`：用 Scoop、Homebrew 或 [Releases](https://github.com/n2ns/n2n-nexus/releases) 里的压缩包，见[安装手册第 1–2 步](INSTALL_zh.md#1-安装-host)。
2. 安装客户端，接入 Claude Code 或 Codex（`npm i -g n2n-nexus@latest`，再执行 `n2n-nexus install claude` 或 `n2n-nexus install codex`），见[第 3 步](INSTALL_zh.md#3-为-claude-code-和-codex-安装客户端)。
3. 仅 Codex：用 `/hooks` 信任一次 n2n-nexus 的 hooks，见[第 4 步](INSTALL_zh.md#4-启用-codex-的-hooks只需一次必须做)。

其他 MCP 客户端和多台机器，见[安装手册](INSTALL_zh.md)；使用方法、常见问题和配置，见[使用手册](USER_GUIDE_zh.md)。

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
- `update_task`：更新任务的状态、进度、结果 URI、错误信息或元数据。
- `cancel_task`：取消等待中或运行中的任务。

### 维护

- `host_maintenance`：清理或清空全局聊天流。
- `host_delete_project`：删除项目和资产。

## 实战示例

文档中包含一个多 AI 助手协同架构和协议决策的示例会话：

| 文件 | 说明 |
| --- | --- |
| [会议纪要](./MEETING_MINUTES_2025-12-29.md) | 结构化决策和测试记录 |
| [讨论日志](./discussion_2025-12-29.md) | 可读的讨论记录 |

## FAQ

### n2n-nexus 是项目管理 SaaS 吗？

不是。它是给 AI 助手使用的本地 MCP 协同服务器，状态保存在本地，并通过 MCP 工具暴露给客户端。

### 它会替代 n2n-memory 吗？

不会。`n2n-memory` 是单仓库的本地记忆工具。`n2n-nexus` 是多助手协同中枢，处理项目 Manifest、消息、会议、任务和共享文档。

### 支持 Claude Desktop、Cursor、VS Code 等客户端吗？

支持，只要客户端可以运行本地 MCP command server。IDE 启动适配器，适配器通过 `NEXUS_ENDPOINT` 连接本地 host。

### 可以跨 Windows 和 WSL 协作吗？

可以。在一个环境中运行 host，然后让每个适配器通过 `NEXUS_ENDPOINT` 指向它。

### 会把数据发送到云端吗？

不需要云服务。数据保存在配置的本地目录中。如果你将 host 暴露给远程机器，那属于你自己的网络配置。

### 它是向量数据库或源码索引器吗？

不是。n2n-nexus 协调项目元数据、消息、会议、文档、任务和资产，不做语义源码搜索。

## 文档

- [安装手册](./INSTALL_zh.md)：host 和客户端的安装、升级和卸载；Codex hooks 信任、其他 MCP 客户端、多台机器。
- [使用手册](./USER_GUIDE_zh.md)：使用 n2n-nexus：托盘、直接消息、常见问题；命令、环境变量、`settings.json`、数据和日志。
- [架构文档](./ARCHITECTURE_zh.md)：系统设计，host 与客户端的分工。
- [工具参考](./TOOLS_REFERENCE.md)：全部工具及参数（英文）。
- [AI 助手指南](./ASSISTANT_GUIDE_zh.md)：AI 助手如何调用工具、保持项目上下文。
- [Host 开发](../host/README.md)：host 的编译、测试和发布（英文）。
- [参与贡献](../CONTRIBUTING.md)：开发环境、提交问题和贡献代码（英文）。
- [更新日志](./CHANGELOG_zh.md)：版本历史。
- [安全](../SECURITY.md)：安全模型和漏洞报告方式（英文）。
- [英文 README](../README.md)
- [llms.txt](../llms.txt)

## 许可证

本项目使用 [Apache-2.0 License](../LICENSE)。

---

Built by N2NS Lab, Datafrog's open-source lab for practical AI developer tools.
