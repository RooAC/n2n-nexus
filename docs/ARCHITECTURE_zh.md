# 架构与标准

## 🏛️ 系统架构

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus daemon                    │
│  独立 HTTP 服务器 · 由用户启动，或由               │
│  n2n-nexus install host 注册为开机服务             │
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
  ├─ 连不上：提示如何启动 daemon（本机用 install host 或 daemon，远程地址则
  │  需在那台机器上启动），自己从不启动
  ├─ 单次调用超时：只让这次调用失败，保留工具列表，不重连
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

通知只带发送方和第一行，正文由模型通过 `read` 以工具结果的形式读取，不作为注入的上下文出现。待命中的 Stop hook 最长挂起 590 秒，消息一到立即返回；客户端杀掉 hook（用户按 Esc）或 daemon 关闭时结束等待。系统仍采用可信本地 daemon 边界，这不是身份认证机制：同一系统用户下的所有进程都被视为可信，可以冒充任何对话；需要互相隔离的代理应以不同的系统用户运行，各自使用自己的 daemon（见 [SECURITY.md](../SECURITY.md) 的本地信任模型）。精确契约见[工具参考](TOOLS_REFERENCE.md#direct-messages-between-conversations)。

### 会话、在线状态与唤醒空闲对话

新对话的 SessionStart hook 会输出一段介绍：它自己的名称和 ID、没有离线的其他会话（最多列 5 个），以及 `peers`、`send`、`read` 的用法。适配器也会在 MCP 的服务器 instructions 里给出同样的说明。客户端不一定会报告对话结束，所以 `idle` 或 `working` 的会话 30 分钟没有任何活动就算 `offline`，直到它下一次有事件。

空闲的对话并没有在运行，只靠 hooks，要等它的用户有动作才能把消息送进去。为了让 AI 会话之间无需有人输入就能互相回复，`install` 会增加第二个 Stop hook `n2n-nexus hook <client> --wait`，每轮结束时启动一个后台等待：

```
一轮结束 ──▶ Stop hook（提醒未读，或进入 listen 等待）
         └─▶ Stop hook --wait ──▶ POST /api/hook {BackgroundWait}（每次最多 590 秒，循环最长 1 小时）
                                    │  等待期间会话显示为 "listening"
                                    ├─ 有新消息 ─▶ { wake: 通知 }
                                    │     Claude Code：asyncRewake hook 以退出码 2 结束，通知开启新的一轮
                                    │     Codex：独立后台进程执行 `codex queue --thread <id> --message <通知>`
                                    ├─ 该会话有其他任何事件 ─▶ null（等待结束）
                                    └─ 时间到 ─▶ { timeout: true }（再次请求）
```

会话处于 `working`，或者 listen 模式的 Stop hook 正在等待时，后台等待不会送达，所以同一条消息只提醒一次。已在 Windows 上用 Claude 桌面应用和 Codex 桌面应用实测（2026-10-23）：两个方向都能在数秒内叫醒空闲的对话。已知限制：

- Codex 只会为运行中的 Codex 应用里已加载的对话启动排队的一轮。Codex 重启后，用户点开对话才会加载。
- Codex 的后台等待会随 Codex 应用退出而结束，要等该对话再结束一轮才会重新启动。这期间发来的消息留在 daemon 里为未读（不进入 Codex 自己的队列），直到用户下次在该对话里发消息。
- Claude Code 的对话在最后一轮结束后一小时内可被叫醒（hook 的超时时间）。
- 每次 AI 回复都会再次叫醒对方。为了防止两个会话无限互相叫醒，daemon 会统计从用户上次输入以来的自动轮次（被叫醒、listen 等待、因消息被拦下不结束），达到 `NEXUS_MAX_AUTO_TURNS`（默认 8）后不再自动继续；叫醒后一分钟内的那次用户提交视为被叫醒的那一轮开始，不清零计数。超过上限的消息会等用户下次输入时再提醒。
- 自动轮次的计数只按时间区分"被叫醒的那一轮"和"用户输入"。如果一次唤醒没有真正开始新的一轮（例如 Codex 对话没加载），而用户在那一分钟内亲自输入，这次输入不清零计数，用户下一次输入才会清零。如果被叫醒的那一轮晚于一分钟才开始（例如用户之后才点开的 Codex 对话），它的提交会清零计数。两种情况都不会丢消息，也不会让会话在无人参与时无限循环。

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

**文件存储访问**：HTTP 请求是并发处理的，因此对 `registry.json`、manifest 和文档索引的每次修改都独占一把 daemon 级读写锁，并以原子方式写入（临时文件 + rename）；读取共享这把锁，所以不会读到改名或更新进行到一半的状态。写入时各文件按 `registry.json` 最后写的顺序进行，后一步失败就还原已写的文件。

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
  ├─ n2n-nexus install host   把 daemon 注册为开机启动的服务（Windows）。
  ├─ n2n-nexus mcp       IDE 通过 npx 自动启动，无状态代理。
  ├─ n2n-nexus hook      Claude Code / Codex 在每个 hook 事件时运行。
  ├─ n2n-nexus install   把 hooks 和 MCP 服务写进客户端的用户级配置。
  └─ n2n-nexus doctor    检查已安装的 hook 和 MCP 命令是否还能运行。
```

**Daemon**（用 `n2n-nexus install host` 注册为开机服务，或由用户启动；适配器和 hooks 从不启动 daemon，连不上时只提示）：
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

**局域网中的独立 host**：用 `--host 0.0.0.0` 把一个 daemon 作为服务运行（Windows 上用 `n2n-nexus install host --host 0.0.0.0`，其他系统用 systemd 单元或 launchd agent），不依赖任何 IDE，并对本地子网放行 TCP 与 UDP 5688。之后每台客户端机器只需要客户端部分：`n2n-nexus install <claude|codex> --endpoint discover` 写入 MCP 服务和 hooks，它们通过 UDP 广播找到 host。在 Windows 上要在普通终端里执行 `npm install -g`：在 Codex 这类打包（MSIX）应用的终端里安装，会装进该应用私有的 `%APPDATA%` 副本，只有这个应用看得到，而且之后它会挡住真正的全局安装。

**无强制启动顺序**：先开 IDE 再启动 daemon 也没问题，工具在 daemon 就绪后自动出现。Daemon 重启对 MCP 透明，自动重连后通知 IDE。

---

## 📡 REST API

### 工具能力（MCP 对接）
```
GET  /api/tools              返回完整工具定义列表（JSON Schema）
POST /api/tools/call         执行工具调用 { tool, args, instanceId, caller? }
POST /api/hook               客户端 hook 事件 { client, input } → { output }；BackgroundWait 事件即后台等待
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
- 不默认提供跨机器实时同步——将 `NEXUS_ENDPOINT` 指向可达的主机地址即可实现跨机器访问，或设为 `discover`，通过 UDP 广播在局域网里查找监听 `0.0.0.0` 的 daemon。
- 单 daemon 节点，无内置集群能力。
- 开源基线不包含认证/鉴权层。
