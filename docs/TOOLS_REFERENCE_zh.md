# n2n-nexus 工具参考

[English version](TOOLS_REFERENCE.md)

本文档介绍 n2n-nexus 适配器提供的 MCP 工具。工具调用会转发给运行在 `NEXUS_ENDPOINT` 的 host（`n2n-nexus-host`）。

下面的参数表来自 `contract/tools.json`。host 通过 `GET /api/tools` 提供这份 JSON Schema，并在处理函数运行前用它校验每一次调用。参数无效的调用会被拒绝，并返回说明原因的错误（`Invalid arguments for <tool>: ...`）；schema 没有声明的键会在校验前被丢弃。

## 约定

- 每个成功的结果都返回两份：一份是 `structuredContent`（JSON 对象），另一份是放在文本块里的同一段 JSON，供只读取文本的客户端使用。返回数据的工具（`search_projects`、`get_global_topology`、`get_project`、`read_messages`、`list_events`、`get_global_strategy`、`list_global_docs`、`get_global_doc`、`list_meetings`、`get_task`、`list_tasks`、`peers`、`read`、`set_profile`）还会提供 `outputSchema`；只返回确认的工具不提供，以保持 `tools/list` 精简。结果的结构就是 `contract/tools.json` 里的 `outputSchema` 条目；host 用它们校验每一个结果。
- 调用按实例限流（默认每秒 20 次，突发 60 次；对应 host `settings.json` 中的 `rateLimit` 和 `rateBurst`）。超出限制的调用会失败并返回 "Rate limit exceeded ... retry after Ns"；等待该时长后重试。
- 每个工具都有供客户端界面显示的 `title`（例如 "Delete Project"）。
- 每个工具都带有 MCP annotations：`readOnlyHint`、`destructiveHint`、`idempotentHint` 和 `openWorldHint: false`（所有工具都只作用于 host）。按照 MCP 的定义，只有更新完全是追加时，工具才算非破坏性。读取类工具标为只读。`start_meeting`、`create_task`、`send_message`、`send` 和 `reply` 只追加数据，是非破坏性的；`update_task` 也标为非破坏性且幂等。`listen`、`set_profile`、`sync_project_assets`、`update_project`、`upload_project_asset`、`rename_project`、`sync_global_doc`、`update_global_strategy`、`end_meeting`、`archive_meeting`、`reopen_meeting`、`cancel_task`、`host_maintenance` 和 `host_delete_project` 会改写或删除已有状态，标为破坏性，以便客户端请求确认。`read_messages` 和 `read` 不是只读的，因为它们会推进调用方自己的未读状态；但它们是非破坏性的，因为不改变任何共享数据。
- 每个适配器都有一个实例 ID（`NEXUS_INSTANCE_ID`、`--id`，默认是 `mcp-<hostname>-<工作目录的哈希>-<IDE 名>`，其中 IDE 名是 MCP 客户端名，取自请求的 `io.modelcontextprotocol/clientInfo`，2025 代的客户端则取自 `initialize`）。读取游标和会议发起者权限都以它为键，所以同一个 IDE 在同一个工作区里重启后它保持不变，而同一个工作区里的两个 IDE 仍然互相区分。适配器在每次调用中都以 `instanceId` 带上它；没有它时 `read_messages` 会失败。
- 结果里会出现两种 ID。直接消息工具（`peers`、`send`、`read`、`reply`）使用对话的会话 ID，即 `claude:<id>` 或 `codex:<id>`。`read_messages` 中的 `from`、`list_events` 中的 `actor`、会议的 `initiator` 和 `participants`，以及全局文档的 `updatedBy` 都是适配器实例 ID（`mcp-…`）；它们不是会话，不能用于 `send`。
- 项目 ID 采用 `[prefix]_[name]` 格式；前缀列在[助手指南](ASSISTANT_GUIDE_zh.md#2-项目-id)中。
- 所有项目写入工具都同步执行并直接返回结果。任务工具（`create_task`、`get_task`、`list_tasks`、`update_task`、`cancel_task`）用于跟踪由助手自己管理的工作。
- 项目工具显式接收 `projectId`。
- `host_delete_project` 是破坏性操作，且不可逆。

## 共享对象结构

### 项目 manifest

由 `sync_project_assets` 使用，`update_project` 使用其中一部分。

| 字段 | 类型 | MCP schema 是否要求 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 项目 ID。不能通过 `update_project` 修改；请使用 `rename_project`。 |
| `name` | string | 是 | 便于阅读的项目名称。 |
| `description` | string | 是 | 项目简介。 |
| `techStack` | string[] | 是 | 项目使用的技术。 |
| `relations` | object[] | 是 | 项目之间的关系。结构：`{ targetId, type }`，其中 `type` 为 `dependency`、`parent`、`child` 或 `related`。 |
| `repositoryUrl` | string | 是 | 源代码仓库 URL。 |
| `localPath` | string | 是 | 项目在本地文件系统中的路径。 |
| `endpoints` | object[] | 是 | 结构：`{ name, url, description }`。 |
| `apiSpec` | object[] | 是 | 结构：`{ method, path, summary }`。 |
| `billing` | object | 否 | `{ plain, price }`：以自由文本表示的计费方案或条款（`plain`）和价格（`price`），两者都是字符串。 |
| `lastUpdated` | string | 否 | 保存在 manifest 中的字段。 |
| `apiDependencies` | object | 否 | 可选，项目 ID 到版本约束的映射。 |
| `gatewayCompatibility` | string | 否 | 可选，网关版本兼容性字符串。 |
| `api_versions` | object | 否 | 可选，功能级 API 版本映射。 |
| `feature_tier` | string | 否 | 可选，`standard`、`advanced` 或 `team`。 |

## 项目资产管理

### `sync_project_assets`

同步完整的项目 manifest 和内部文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `manifest` | 项目 manifest | 是 | 完整的 manifest 对象。见[项目 manifest](#项目-manifest)。 |
| `internalDocs` | string | 是 | Markdown 格式的实现指南或内部笔记。 |

行为：

- 保存 manifest 和项目文档。
- 返回 `{ ok: true, projectId }`。

### `upload_project_asset`

把二进制或文本资产上传到项目的资产库。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 目标项目。必须已存在。 |
| `fileName` | string | 是 | 只能是文件名。不安全的路径字符会被替换；`.` 会被拒绝。 |
| `base64Content` | string | 是 | Base64 编码的文件内容。 |

行为：

- 把文件随项目存进 host 数据库，替换同名资产。项目改名或删除时，其资产也随之改名或删除。
- 返回 `{ ok: true, projectId, fileName }`，其中是清理后的文件名。

### `update_project`

修改已有项目 manifest 中的字段。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 要更新的项目。 |
| `patch` | object | 是 | 要更新的部分 manifest 字段。未知字段和 `id` 会被拒绝。 |

行为：

- 返回 `{ ok: true, projectId }`。
- 要修改项目 ID，请使用 `rename_project`。

### `rename_project`

重命名项目 ID，并级联更新关系。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `oldId` | string | 是 | 现有项目 ID。 |
| `newId` | string | 是 | 新项目 ID。 |

行为：

- `oldId` 不存在时失败。
- 返回 `{ ok: true, oldId, newId }`。

### `search_projects`

搜索项目注册表。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | string | 是 |  | 项目 ID、名称或描述中的子串，不区分大小写。 |
| `limit` | integer | 否 | `10` | 最多返回的项目数（1–200）。 |

### `get_global_topology`

读取项目拓扑。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 否 | 提供时，返回该项目及它直接或间接依赖的项目（只看出向关系）；未知的 projectId 会报错。不提供时，返回所有项目（id、名称、摘要、最后活跃时间）以及项目总数和关系总数。 |

行为：

- 提供了 `projectId` 但项目不存在时失败。

### `get_project`

读取单个项目的 manifest 和内部文档。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `projectId` | string | 是 |  | 要读取的项目。 |
| `includeDocs` | boolean | 否 | `true` | 设为 `false` 时不返回内部文档。 |

行为：

- 返回 `{ manifest, internalDocs? }`。
- 项目不存在时失败。

## 消息与协作

### 对话之间的直接消息

每个 Claude Code 和 Codex 对话都是一个会话，ID 为 `claude:<会话 ID>` 或 `codex:<会话 ID>`，取自客户端。`n2n-nexus install <claude|codex>` 写入的 hooks 会创建会话并保持其状态最新；子代理与其父对话共用同一个会话。恢复对话时沿用原来的会话。在同一个客户端里开始的新对话（例如 Claude Code 中执行 `/clear` 之后）是一个新会话；Claude Code 还会结束旧会话，旧会话随之变为离线。

下面六个工具从 MCP 请求的 `_meta` 识别调用方，从不使用参数：Claude Code 带上 `claudecode/toolUseId`，它由 PreToolUse hook 在调用前刚刚绑定到对话；Codex 带上 `sessionId`。其他客户端、没有 hooks 的对话，或绑定已超过五分钟的调用会收到一条错误，说明：直接消息需要装有 n2n-nexus hooks 的 Claude Code 或 Codex（`n2n-nexus install <claude|codex>`）；hooks 只对安装之后开始的对话生效；MCP 服务器必须以 `n2n-nexus` 为名注册；PreToolUse 绑定过期时再调用一次工具即可解决。其他所有工具都不关心调用方。

这六个工具是对话之间的直接消息。全局聊天和会议是另外的东西：`send_message` 发到那里，`read_messages` 从那里读取；两者都不会发到或读取对话的直接消息。

| 工具 | 参数 | 结果与行为 |
| --- | --- | --- |
| `peers` | `includeOffline?: boolean = false` | `{ self: Profile, peers: Profile[] }`；其他未离线的会话，最近活跃的在前。带 `includeOffline` 时，还包括过去 24 小时内活跃过的离线会话。 |
| `send` | `to: string`、`text: string`（1–32000 个字符）、`notifyWhenIdle?: boolean = false` | `{ messageId, to: { id, name, status } }`。`to` 是会话 ID（任何状态）或某个未离线会话的名称；不能给自己发消息。离线的收件方在恢复时收到消息。带 `notifyWhenIdle` 时，收件方下一次结束一轮、开始待命或离线时，你会收到一次通知（订阅 24 小时后失效）。 |
| `read` | `count?: integer = 10`（1–50） | `{ messages: [{ messageId, from: { id, name }, replyTo, text, createdAt }], remaining }`；未读消息，最早的在前，读取后标为已读。 |
| `reply` | `messageId: string`、`text: string`（1–32000 个字符） | 结果与 `send` 相同。该消息必须是发给你的；回复发给它的发送方，`replyTo` 设为该消息。 |
| `listen` | `on: boolean` | `{ listening }`。开启期间，对话每结束一轮，其 Stop hook 会等待最多 590 秒，有消息或通知到达时让对话继续。在 Claude Code 中按 Esc 会结束一次等待。 |
| `set_profile` | `name?: string`（1–48 个 `A–Z a–z 0–9 . _ @ # -` 中的字符）、`note?: string`（≤ 200 个字符）；至少提供一个 | `{ profile }`。名称在未离线的会话中唯一。 |

`Profile` 包含 `id`、`name`、`client`（`claude` 或 `codex`）、`cwd`、`note`、`status` 和 `lastActiveAt`。会话的初始名称为 `<client>@<工作目录名>`，该名称已被某个未离线会话占用时加上 `#2`、`#3`、…。`status` 为 `working`（用户发送了提示词或有工具在运行）、`idle`（本轮已结束；有后台等待消息的会话改为显示 `listening`）、`listening`（在 listen 模式下等待）或 `offline`（对话已结束）。客户端不一定会报告对话结束，所以 `idle` 或 `working` 的会话 30 分钟没有任何活动也会变为 `offline`；它的下一个事件会让它恢复。只有 `listening` 的会话会立即回应；`idle` 和 `working` 的会话要等它的用户下次发送提示词或它下次调用工具时才会看到消息。

送达。收件方的 hooks 会提醒新消息；通知只带发送方、时间和第一行（最多 100 个字符），正文通过 `read` 以工具输出的形式送达：

| 客户端事件 | 收件方看到的内容 |
| --- | --- |
| 对话开始 | 自己的名称和 ID、未离线的其他会话（最多列出五个）、其中哪些能立即回应，以及 `peers`、`send` 和 `read` 的用法。 |
| 提交提示词 | 未读消息数、最多列出五条，以及待处理的通知。 |
| 每次工具调用后 | 只有尚未提醒过的消息和通知。 |
| 本轮即将结束 | 有未读内容时，本轮带着提醒再继续一次。 |
| 待命中 | 一有新内容到达就结束等待，对话带着它继续。 |
| 空闲（本轮已结束） | Stop hook 启动的后台等待（`n2n-nexus hook <client> --wait`，最长一小时）带着提醒开启新的一轮：Claude Code 通过 `asyncRewake` hook（退出码 2），Codex 通过 `codex queue --thread <会话 ID>`（`NEXUS_CODEX_COMMAND` 可替换 `codex` 命令）。在无人值守的 Claude 会话（`claude -p`、`CLAUDE_CODE_SESSION_ATTENDED=0`）中，该 hook 立即返回，因为 `claude -p` 会等它结束才退出。等待期间会话显示为 `listening`；对话中的任何新活动都会结束等待。Codex 只会为运行中的 Codex 应用里已加载的对话启动排队的一轮，且 Codex 退出时等待结束。 |
| 自动轮次上限 | 被叫醒、待命中的 Stop，以及因消息而不结束的 Stop，各算一次自动轮次；提醒中会写 `Automatic turn n of N`。从用户上次输入以来达到 `maxAutoTurns`（host `settings.json`，默认 8）次后，消息仍会保存，但不再叫醒或拦住对话；用户下次输入时提醒这些消息，并重新开始计数。叫醒后一分钟内的提示词视为被叫醒的那一轮开始，不清零计数。 |

未读消息 24 小时后过期，发送方随后会收到通知。通知也会报告 `notifyWhenIdle` 的结果。

HTTP 客户端：hooks 调用 `POST /api/hook`，请求体为 `{ client: "claude" | "codex", input }`，其中 `input` 包含 hook 标准输入中的字段 `hook_event_name`、`session_id`、`cwd`、`stop_hook_active`、`tool_use_id`、`tool_name`、`source` 和 `reason`；响应为 `{ output }`，不为 null 时由 hook 打印。工具调用在 `POST /api/tools/call` 中用与 `tool`、`args`、`instanceId` 并列的 `caller` 指明会话：`{ client: "claude", toolUseId }` 或 `{ client: "codex", sessionId }`。它们只在可信本地 host 范围内标识对话，不是凭证：同一系统用户的任何进程都能发送它们（见 [SECURITY_zh.md](SECURITY_zh.md) 中的本地信任模型）。

### `send_message`

发到某个会议或全局聊天。要给某一个对话发消息，请使用 `send`；`send_message` 不会发到对话的直接消息。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | string | 是 | 消息正文。 |
| `category` | string | 否 | `PROPOSAL`、`DECISION`、`UPDATE`、`CHAT` 或 `MEETING_START`（保留值；host 从不写入）之一。不传时消息没有分类。 |
| `meetingId` | string | 否 | 目标会议。必须处于活跃状态。 |

行为：

- 提供 `meetingId` 时，消息发到该会议。
- 否则，如果有活跃会议，消息发到该会议。
- 否则写入全局聊天。
- 会议中的 `DECISION` 消息还会记入该会议的决策（`list_meetings` 中的 `decisionCount`）。
- 随消息保存的发送方是调用方的适配器实例 ID。
- 结果：`{ ok: true, sentTo: "meeting" | "global", meetingId?, messageId?, message }`；全局聊天的消息 ID 是数字。

### `read_messages`

读取全局聊天或会议中的未读消息。发给你的对话的直接消息用 `read` 读取。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `count` | integer | 否 | `10` | 要读取的消息数（1–500）。 |
| `meetingId` | string | 否 |  | 提供时从该会议读取。否则从全局日志读取。 |

行为：

- 全局和会议的读取都按适配器实例增量进行：每次调用只返回尚未返回给该实例的消息，最早的在前，并推进游标。
- 每条消息的 `from` 是发送方的适配器实例 ID，不是会话 ID：不能对它使用 `send`。
- 需要调用方实例：没有 `instanceId` 的调用会失败，并返回 `read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically); unread cursors are kept per instance.` MCP 适配器总会带上它。

### `list_events`

读取结构化活动日志。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | integer | 否 | `20` | 最多返回的事件数，最新的在前（1–500）。 |
| `action` | string | 否 |  | 完整的 action（`meeting.end`）或前缀（`project`、`meeting`）。 |

行为：

- 通过 host 工具产生的每一次状态变更都会被记录：`project.sync`、`project.update`、`project.rename`、`project.delete`、`project.asset`、`doc.sync`、`strategy.update`、`meeting.start`、`meeting.end`、`meeting.archive`、`meeting.reopen`、`maintenance.prune`、`maintenance.clear`。
- 每个事件带有 `timestamp`、`actor`（适配器实例 ID，不是会话 ID）、`action`，以及可选的 `target` 和 `detail`。

### `update_global_strategy`

覆盖写入主战略文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 是 | 全局战略文档的完整 Markdown 内容。 |

行为：

- 替换已保存的战略文档。用 `get_global_strategy` 读回。

### `get_global_strategy`

读取主战略文档。没有参数。

行为：

- 返回 `{ content }`。

### `list_global_docs`

列出全局共享文档。没有参数。

行为：

- 返回 `{ count, docs: [{ docId, title, lastUpdated, updatedBy }] }`，最近更新的在前。

### `get_global_doc`

读取一份全局共享文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `docId` | string | 是 | 来自 `list_global_docs` 的文档 ID。 |

行为：

- 返回 `{ docId, title, lastUpdated, updatedBy, content }`。
- 文档不存在时失败。

### `sync_global_doc`

创建或更新一份全局共享文档。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `docId` | string | 是 | 固定不变的文档 ID。 |
| `title` | string | 是 | 便于阅读的文档标题。 |
| `content` | string | 是 | Markdown 内容。 |

## 会议管理

### `list_meetings`

列出会议，最新的在前。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | string | 否 |  | `active`、`closed` 或 `archived`。 |
| `limit` | integer | 否 | `20` | 最多返回的会议数（1–200）。 |

行为：

- 返回 `{ count, activeMeetingId, meetings: [{ id, topic, status, initiator, startTime, endTime?, participants, messageCount, decisionCount, summary? }] }`。
- 用 `read_messages(meetingId)` 读取会议的消息。

### `start_meeting`

开启一个新会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `topic` | string | 是 | 会议主题。用于创建会议记录。 |

行为：

- 调用方的适配器实例成为会议的 `initiator`。
- 新会议成为所有人的默认会议：不传 `meetingId` 的 `send_message` 和 `end_meeting` 都作用于它，直到它结束（之后是仍处于活跃状态、最近被激活的会议，如果有的话）。`reopen_meeting` 以同样的方式让重新开启的会议成为默认会议。

### `end_meeting`

关闭并锁定会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 否 | 要关闭的会议。不传时使用活跃会议。 |
| `summary` | string | 否 | 可选的结束总结。 |

### `archive_meeting`

存档已关闭的会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 是 | 要存档的会议。 |

### `reopen_meeting`

重新激活已关闭或已存档的会议。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `meetingId` | string | 是 | 要重新开启的会议。 |

行为：

- 只有开启会议的适配器实例（会议的 `initiator`）能结束、存档或重新开启它；其他实例的调用会失败，并返回 `Only the MCP adapter instance that started this meeting (<initiator>) can <action> it; this call comes from instance <caller>.`

## 任务管理

### `create_task`

创建一条任务记录，由你自己用 `update_task` 跟踪和更新；host 不执行任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `source_meeting_id` | string | 否 | 把任务关联到某个会议，便于追溯。该会议必须存在。 |
| `metadata` | object | 否 | 任意元数据对象。 |
| `ttl` | integer | 否 | 存活时间，单位毫秒。超过 TTL 的待处理或运行中任务会在每小时一次的维护中被标为 `failed`（`TTL expired`）；结束的任务 7 天后清除。 |

行为：

- 返回 `{ task_id, status, message, task }`。

### `get_task`

读取任务状态和结果。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | `create_task` 返回的任务 ID。 |

### `list_tasks`

列出任务，可按状态筛选。

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `status` | string | 否 |  | `pending`、`running`、`completed`、`failed` 或 `cancelled` 之一。 |
| `limit` | integer | 否 | `50` | 最多返回的任务数（1–500）。 |

### `update_task`

更新你创建的任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | 要更新的任务。 |
| `status` | string | 否 | `pending`、`running`、`completed`、`failed` 或 `cancelled` 之一。 |
| `progress` | number | 否 | 进度，从 `0` 到 `1`。 |
| `result_uri` | string | 否 | 结果所在位置。 |
| `error_message` | string | 否 | 任务失败的原因。 |
| `metadata` | object | 否 | 替换任务的整个元数据对象；未提供的键不会保留。 |

行为：

- 只修改提供的字段和任务的更新时间。
- 返回任务：`{ id, status, progress, source_meeting_id, metadata, result_uri, error_message, created_at, updated_at, ttl }`。
- 任务不存在时失败。

### `cancel_task`

取消待处理或运行中的任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | 要取消的任务。 |

## 维护

### `host_maintenance`

修剪或清空全局聊天流。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | `prune` 或 `clear`。 |
| `count` | integer | `prune` 时必填 | 要删除的最旧消息数；`prune` 时至少为 `1`。`clear` 会忽略它。 |

行为：

- 返回 `{ ok, removed, remaining }`。

### `host_delete_project`

永久删除项目及其资产。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 要删除的项目。 |

行为：

- 项目不存在时失败。
- 返回 `{ ok: true, projectId }`。
- 此操作不可逆。
