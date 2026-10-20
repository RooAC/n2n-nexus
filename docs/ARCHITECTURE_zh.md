# 架构与标准

## 🏛️ 系统架构

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus daemon                    │
│  独立 HTTP 服务器 · 用户启动，或由本机的          │
│  hook / 适配器在后台自动拉起，持续运行             │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  REST API    │  │  存储层                   │  │
│  │  /api/tools  │  │  SQLite（WAL）+ JSON 文件 │  │
│  │  /api/tools  │  │                          │  │
│  │    /call     │  │  单进程写入，无锁竞争      │  │
│  └──────┬───────┘  └──────────────────────────┘  │
│   全部业务逻辑、工具定义、数据读写均在此处           │
└─────────┼────────────────────────────────────────┘
          │ HTTP（NEXUS_ENDPOINT — 可跨环境配置）
   ┌──────┼──────┐
   ▼      ▼      ▼
MCP-A  MCP-B  MCP-C      hooks（Claude Code / Codex）
(Win)  (WSL)  (VM)       每个客户端事件调用一次 POST /api/hook
轻量协议适配器，每条 MCP 连接一个
```

### 核心原则

1. **Daemon 是唯一的真相来源** — 所有读写、业务逻辑和工具定义都在 daemon 侧。
2. **MCP 无状态** — 不含 hardcode 工具名、不存本地持久化数据，自己也不持有会话；对话和直接消息都在 daemon。
3. **Daemon 决定工具能力** — MCP 启动和重连时拉取 `GET /api/tools`。
4. **无本地降级** — daemon 不可达时，MCP 每 3 秒重试并报告错误，不做本地 fallback（避免数据分裂）。daemon 拒绝的工具调用（校验失败、不存在、无权限）作为错误结果（`isError: true`）返回给 IDE，不影响连接；未知工具名返回 JSON-RPC `-32602` 错误。
5. **MCP、hooks 与 Daemon 之间全部走普通 HTTP** — 客户端的 hooks 上报对话事件，并把新消息通知带回给模型；正文由模型用工具读取。

### MCP 启动流程

```
读取 NEXUS_ENDPOINT（默认 http://127.0.0.1:5688）
  │
  ├─ 开始 stdio 服务（MCP TypeScript SDK v2，serveStdio），同时拉一次 GET /api/tools；
  │  第一次 tools/list 最多等这次拉取 1 秒
  │     ├─ 2026-07-28 客户端：server/discover、每请求 _meta 信封，
  │     │  list_changed 经 subscriptions/listen 下发
  │     └─ 2025 代客户端：initialize 握手，主动下发 list_changed
  │
  ├─ 连接 127.0.0.1 / localhost 被拒绝：在后台拉起一次 daemon
  │
  ├─ 若 daemon 不在线：重试循环（每 3 秒）
  │     └─ GET /api/tools 成功 → 缓存工具列表
  │           → notifications/tools/list_changed → IDE 重新拉取
  │
  └─ stdin 关闭 → 停止重试、关闭、退出
```

适配器的实例 ID（未读游标、会议权限以它为键）取自该连接上第一次见到的客户端名，来源是请求 `_meta` 中的 `io.modelcontextprotocol/clientInfo`（2026-07-28）或 `initialize`（2025 代），`NEXUS_INSTANCE_ID` / `--id` 可固定。

### 对话与 hooks

每个 Claude Code 或 Codex 对话是一个会话，ID 为 `claude:<会话 ID>` 或 `codex:<会话 ID>`，直接使用客户端自己分配的 ID。`n2n-nexus install <claude|codex>` 写入的 hooks 会在 SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd（Claude Code 还有只匹配 n2n-nexus 工具的 PreToolUse）时运行 `n2n-nexus hook <client>`。hook 命令把事件里用于识别的字段转发给 `POST /api/hook`，并打印 daemon 的回应；出任何错误都以退出码 0 退出、不输出，所以 daemon 不在也不会卡住客户端。

```
客户端事件 ──▶ n2n-nexus hook ──▶ POST /api/hook ──▶ 会话状态、通知
                                                      │
UserPromptSubmit / PostToolUse ◀── additionalContext ◀─┤  "2 unread direct messages ..."
Stop                           ◀── decision: block   ◀─┘  每次结束前一次，或待命时消息一到就返回
```

工具调用的对话身份不经过模型参数。适配器从请求的 `_meta` 里读取：Claude Code 带 `claudecode/toolUseId`，由调用前刚运行的 PreToolUse hook 绑定到对话（已实测：调用会等 hook 结束）；Codex 带 `sessionId`。适配器把它作为 `caller` 放进 `POST /api/tools/call`。身份是对话而不是适配器进程，所以适配器重启、恢复对话、子代理都沿用同一身份，一个适配器也能同时服务多个 Codex 对话。

通知只带发送方和第一行，正文由模型通过 `read` 以工具结果的形式读取，不作为注入的上下文出现。待命中的 Stop hook 最长挂起 590 秒，消息一到立即返回；客户端杀掉 hook（用户按 Esc）或 daemon 关闭时结束等待。系统仍采用可信本地 daemon 边界，这不是身份认证机制。精确契约见[工具参考](TOOLS_REFERENCE.md#direct-messages-between-conversations)。

---

## 💾 数据持久化

所有数据存储在 daemon 的存储根目录下（默认 `~/.n2n-nexus`）：

```
~/.n2n-nexus/
├── global/
│   ├── blueprint.md        # 主战略文档
│   ├── docs_index.json     # 全局文档索引
│   └── docs/               # 共享 Markdown 文档
├── projects/
│   └── {project-id}/
│       ├── manifest.json          # 项目元数据
│       ├── internal_blueprint.md  # 内部技术文档
│       └── assets/                # 二进制资产（图片、PDF）
├── registry.json           # 全局项目索引
└── nexus.db                # SQLite 数据库（会议、全局聊天、事件、任务、游标、对话、直接消息）
```

**SQLite WAL 模式**：只有 daemon 进程打开数据库。MCP 适配器不直接访问，全部经由 HTTP。

**文件存储写入**：HTTP 请求是并发处理的，因此对 `registry.json`、manifest 和文档索引的每次修改都排在一把 daemon 级写锁后面，并以原子方式写入（临时文件 + rename）。

**活动日志**：经由 daemon 发生的状态变更（项目同步/重命名/删除、会议开始/结束、文档同步等）以结构化事件记录在 SQLite 中，通过 `list_events` / `GET /api/events` 读取，不混入聊天流。

**自我修复**：`registry.json` 在损坏或丢失时自动重建初始状态。

---

## 🏷️ 项目 ID 命名规范

所有项目 ID 必须遵循 `[prefix]_[name]` 格式：

| 前缀 | 分类 | 示例 |
|------|------|------|
| `web_` | 网站 | `web_datafrog.io` |
| `api_` | 后端服务 | `api_user-auth` |
| `mcp_` | MCP 服务器 | `mcp_nexus` |
| `lib_` | 库/SDK | `lib_crypto-core` |
| `chrome_` | Chrome 扩展 | `chrome_evisa-helper` |
| `vscode_` | VSCode 扩展 | `vscode_super-theme` |
| `android_` | Android 应用 | `android_client-app` |
| `ios_` | iOS 应用 | `ios_client-app` |
| `flutter_` | Flutter 应用 | `flutter_unified-app` |
| `desktop_` | 桌面应用 | `desktop_main-hub` |
| `bot_` | 机器人 | `bot_auto-moderator` |
| `infra_` | 基础设施/DevOps | `infra_k8s-config` |
| `doc_` | 文档 | `doc_coding-guide` |

---

## 🌐 发布模型

一个 npm 包，两个命令：

```
n2n-nexus
  │
  ├─ n2n-nexus daemon    启动一次，持续运行，持有所有数据。
  ├─ n2n-nexus mcp       IDE 通过 npx 自动启动，无状态代理。
  ├─ n2n-nexus hook      Claude Code / Codex 在每个 hook 事件时运行。
  └─ n2n-nexus install   把 hooks 和 MCP 服务写进客户端的用户级配置。
```

**Daemon**（由用户启动；本机地址上没有 daemon 时，也会由 hook 或适配器在后台拉起）：
```bash
npx n2n-nexus daemon --port 5688
# 或显式指定存储路径
npx n2n-nexus daemon --root ~/.n2n-nexus --port 5688
```

**MCP**（IDE 配置）：
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

**无强制启动顺序**：先开 IDE 再启动 daemon 也没问题，工具在 daemon 就绪后自动出现。Daemon 重启对 MCP 透明，自动重连后通知 IDE。

---

## 📡 REST API

### 工具能力（MCP 对接）
```
GET  /api/tools              返回完整工具定义列表（JSON Schema）
POST /api/tools/call         执行工具调用 { tool, args, instanceId, caller? }
POST /api/hook               客户端 hook 事件 { client, input } → { output }
```

### 系统
```
GET  /health                 健康状态 + 版本信息
```

### 项目
```
POST /api/projects/sync
POST /api/projects/update
POST /api/projects/rename
POST /api/projects/delete
GET  /api/projects/search
GET  /api/projects/topology
GET  /api/projects/:projectId
```

### 消息与全局协作
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

### 会议
```
GET  /api/meetings
POST /api/meetings/start
POST /api/meetings/end
POST /api/meetings/archive
POST /api/meetings/reopen
GET  /api/meetings/:meetingId
```

### 任务
```
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/update
POST /api/tasks/:taskId/cancel
```

### 维护
```
POST /api/maintenance/logs
```

---

### 请求防护

daemon 拒绝来自浏览器的请求（带 `Origin` 头或跨站 `Sec-Fetch-Site`：403）、既非 IP 也不在本地/允许列表中的 `Host`（403，防 DNS rebinding）、非 JSON 的 POST 请求体（415）以及超过 16 MB 的请求体（413）。工具调用按实例和客户端地址限流（429，带 `Retry-After`）。详见 `SECURITY.md`。

## 边界说明

- 不默认提供云端桥接。
- 不默认提供跨机器实时同步——将 `NEXUS_ENDPOINT` 指向可达的主机地址即可实现跨机器访问。
- 单 daemon 节点，无内置集群能力。
- 开源基线不包含认证/鉴权层。
