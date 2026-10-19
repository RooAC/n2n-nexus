# 架构与标准

## 🏛️ 系统架构

```
┌──────────────────────────────────────────────────┐
│              n2n-nexus daemon                    │
│  独立 HTTP 服务器 · 用户手动启动，持续运行          │
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
MCP-A  MCP-B  MCP-C
(Win)  (WSL)  (VM)
轻量协议适配器，每条 MCP 连接一个
```

### 核心原则

1. **Daemon 是唯一的真相来源** — 所有读写、业务逻辑和工具定义都在 daemon 侧。
2. **MCP 只维护连接身份** — 不含 hardcode 工具名、不存本地持久化数据；会话目录和收件箱在 daemon。
3. **Daemon 决定工具能力** — MCP 启动和重连时拉取 `GET /api/tools`。个人收件箱需要适配器和 daemon 都支持会话身份；旧客户端仍可使用原有共享消息接口。
4. **无本地降级** — daemon 不可达时，MCP 每 3 秒重试并报告错误，不做本地 fallback（避免数据分裂）。daemon 拒绝的工具调用（校验失败、不存在、无权限）作为错误结果（`isError: true`）返回给 IDE，不影响连接；未知工具名返回 JSON-RPC `-32602` 错误。
5. **MCP ↔ Daemon 全部走普通 HTTP** — 收件箱由助手主动拉取；心跳只维护在线状态，不唤醒模型。

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
  ├─ 若 daemon 不在线：重试循环（每 3 秒）
  │     └─ GET /api/tools 成功 → 缓存工具列表
  │           → notifications/tools/list_changed → IDE 重新拉取
  │
  └─ stdin 关闭 → 停止重试、关闭、退出
```

适配器的实例 ID（未读游标、会议权限以它为键）取自该连接上第一次见到的客户端名，来源是请求 `_meta` 中的 `io.modelcontextprotocol/clientInfo`（2026-07-28）或 `initialize`（2025 代），`NEXUS_INSTANCE_ID` / `--id` 可固定。

每条 MCP 连接还会生成随机会话 ID，在首次工具请求时注册，每 20 秒刷新一次心跳，在线租约为 60 秒。断连后标记离线；适配器重启会创建新会话，旧会话的待收消息不会转移。宿主多个聊天共用连接时也共用收件箱。项目关联仅用于目录筛选，不作为项目工具的隐式操作目标。注册和断连分别使用 `POST /api/sessions/register` 与 `POST /api/sessions/disconnect`，工具请求的会话身份放在模型参数之外。系统仍采用可信本地 daemon 边界，这不是身份认证机制。精确契约见[工具参考](TOOLS_REFERENCE.md#session-directory-and-direct-inboxes)。

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
└── nexus.db                # SQLite 数据库（会议、全局聊天、事件、任务、游标）
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
  ├─ n2n-nexus daemon    用户手动启动一次，持续运行，持有所有数据。
  │
  └─ n2n-nexus mcp       IDE 通过 npx 自动启动，维护连接身份。
```

**Daemon**（用户手动启动）：
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
POST /api/tools/call         执行工具调用 { tool, args, instanceId, sessionId? }
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
