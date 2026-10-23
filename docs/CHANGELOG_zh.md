# 更新日志 (Changelog)

本项目的所有重大变更都将记录在此文件中。

## [未发布]

### 修复

- 托盘控制后台服务时显示服务实际的监听地址（例如 `http://0.0.0.0:5688（局域网）`），不再显示它用来检查服务的本机回环地址。

## [0.9.1] - 2026-10-24

让使用 n2n-nexus 的 AI 模型读到更清楚的说明。

### 变更

- 工具说明区分 `send` / `read`（会话之间的私信）与 `send_message` / `read_messages`（全局聊天和会议），说明 `read_messages`、`list_events` 和会议里的 ID 是 MCP 适配器实例 ID 而不是会话 ID，写明哪个会议成为当前会议、只有发起实例能结束 / 归档 / 重开，并准确描述 `sync_project_assets`（新建或整体替换）、任务 metadata、`billing`、策略文档和 `get_global_topology`。
- MCP 服务器说明和 SessionStart 介绍补上 `reply`、`set_profile`、私信需要的 hooks，以及两类消息的区别。
- 报错说明下一步：缺少会话身份时列出原因（没装 hooks、装完没开新对话、MCP 服务器名不是 `n2n-nexus`、绑定过期请重试）；会议权限报错写出发起实例和调用实例；参数校验报错只列出不合格的字段；`cancel_task` 区分任务不存在和已结束；适配器和 hook 的报错称 n2n-nexus-host 而不是 daemon。
- `get_global_topology` 传入不存在的 `projectId` 时报错，不再返回空图；`host_maintenance` 的 `prune` 要求 `count` ≥ 1，不再什么都不删。

## [0.9.0] - 2026-10-23

两个程序的 0.9.0 版本：host 改为独立的 Go 程序 `n2n-nexus-host`，npm 包 `n2n-nexus` 只保留客户端。

### 新增

- `n2n-nexus-host`：用 Go 重写的 host，Windows、macOS、Linux（amd64 和 arm64）各一个可执行文件。不带参数时以托盘程序运行：显示状态、地址和在线会话数、打开日志目录和数据目录、开关局域网访问（Windows 上经 UAC 确认后添加 TCP 和 UDP 防火墙规则，其他系统提示需要放行的端口）、登录后自启（托盘第一次运行时自动打开）、重启、退出；中文系统显示中文，其他显示英文。`serve` 在前台运行；`service install|uninstall|status` 注册以安装用户身份运行的开机服务，host 退出 5 秒后自动重启（Windows 计划任务、macOS LaunchDaemon、Linux systemd 单元），托盘正在运行 host 时拒绝安装；`autostart on|off` 设置托盘登录后自启。端口上已有 host（服务）应答时，托盘只做控制界面。每个数据目录只运行一个 host。
- 安装方式：Homebrew（`brew install n2ns/tap/n2n-nexus-host`，从源码编译）、Scoop（`scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`，`scoop install n2ns/n2n-nexus-host`），以及 GitHub Releases（标签 `host-v*`）上的压缩包，附 `SHA256SUMS` 和构建证明（`gh attestation verify`）。程序暂未做代码签名。
- `update_task`：更新任务的 `status`、`progress`（0–1）、`result_uri`、`error_message` 或 `metadata`，返回更新后的任务。
- `contract/`：host 与客户端之间的 JSON 协议（`tools.json`、`hook.json`、`errors.json`），随 npm 包发布。`GET /health` 返回 host 的 `contractVersion`，`n2n-nexus doctor` 检查 host 的协议版本与客户端一致。
- 局域网发现：`NEXUS_ENDPOINT=discover`（或 `--endpoint discover`）让 MCP 适配器和 hooks 通过 `NEXUS_DISCOVERY_PORT`（默认 5688）上的 UDP 广播查找 host，缓存在 `~/.n2n-nexus/discovered-endpoint`，连不上时重新查找。监听非回环地址的 host 在它的 `discoveryPort` 上应答。没有应答时，客户端使用本机地址 `http://127.0.0.1:5688`。
- SessionStart hook 告诉新对话它自己的会话名称和 ID，以及哪些其他会话不处于离线状态，不用先被要求查询就能给它们发消息。
- MCP 适配器发送服务器 instructions，说明如何查找其他 AI 会话并给它们发消息。
- 空闲的对话会被叫醒：`install` 增加第二个 Stop hook（`n2n-nexus hook <client> --wait`），每轮结束后最多等待一小时，有新消息或通知就让对话开始新的一轮：Claude Code 通过 `asyncRewake` hook，Codex 通过 `codex queue`（可用 `NEXUS_CODEX_COMMAND` 指定命令）。等待期间会话显示为 `listening`，对话里有任何新活动就结束等待。重新运行 `n2n-nexus install <client>` 即可加上这个 hook。 无人值守的 Claude 会话（`claude -p`，`CLAUDE_CODE_SESSION_ATTENDED=0`）不等待，回答完立即退出。
- 自动轮次上限：被叫醒、listen 等待、因消息被拦下不结束都算一次自动轮次。从用户上次输入算起达到 `maxAutoTurns`（host 的 `settings.json`，默认 8；`0` 表示不限制）后，消息照常保存，但不再叫醒或拦住对话，避免两个 AI 会话无限互相叫醒。提醒里会写明 `Automatic turn n of N`；被叫醒那一轮开始时的用户提交不清零计数。

### 变更

- **不兼容：** npm 包 `n2n-nexus` 只含客户端（MCP 适配器、`hook`、`install` / `uninstall`、`doctor`）；删除 `n2n-nexus daemon`，不再依赖 `better-sqlite3`。host 请用 `n2n-nexus-host` 运行。
- **不兼容：** 存储改为新的 SQLite 数据库：host 数据目录下的 `nexus.db`（`%LOCALAPPDATA%\n2n-nexus`、`~/Library/Application Support/n2n-nexus`、`$XDG_DATA_HOME/n2n-nexus`，默认 `~/.local/share/n2n-nexus`；`--root` 或 `NEXUS_ROOT` 可改）。项目、资产和全局文档都是其中的表，不再是文件；每个写操作一个事务，表结构由编号的迁移脚本管理。旧版本在 `~/.n2n-nexus` 里的数据不导入，原样保留。
- **不兼容：** host 只有四个接口：`GET /health`、`GET /api/tools`、`POST /api/tools/call`、`POST /api/hook`。删除项目、消息、全局、会议、任务、事件和维护的 REST 接口，它们的功能都有对应的工具。
- **不兼容：** `read_messages` 需要 `instanceId`（MCP 适配器总会带上）；不带的调用不再共用 `unknown` 未读游标。
- **不兼容：** host 设置放在数据目录的 `settings.json` 里（`host`、`port`、`discoveryPort`、`allowedHosts`、`rateLimit`、`rateBurst`、`maxAutoTurns`），命令行参数覆盖；host 除 `NEXUS_ROOT` 外不读任何环境变量。`NEXUS_HOST`、`NEXUS_DAEMON_PORT`、`NEXUS_ALLOWED_HOSTS`、`NEXUS_RATE_LIMIT`、`NEXUS_RATE_BURST`、`NEXUS_MAX_AUTO_TURNS` 不再使用；`NEXUS_DISCOVERY_PORT` 仍供使用 `discover` 的客户端使用。
- hooks 按对话和按客户端地址限流，与工具调用使用各自独立的桶。
- host 只保留有限时间的数据：事件、已读或已过期的直接消息、已发出的通知保留 30 天，已结束的任务保留 7 天；`host.log` 单个 10 MB 轮转，保留 3 个旧文件（托盘自己的日志写 `tray.log`）。
- MCP 适配器和 hooks 从不启动 host。本机地址上没有 host 应答时，工具调用报错并提示安装并启动 `n2n-nexus-host`；远程地址则提示需在那台机器上启动。hooks 静默跳过。
- `peers` 默认只列出未离线的会话；传 `includeOffline: true` 时，和以前一样再列出 24 小时内活跃过的离线会话。
- `idle` 或 `working` 状态的会话 30 分钟没有任何活动就标为 `offline`，因为客户端不一定发送 SessionEnd（已结束或关闭的 Codex 对话此前会一直"在线"）；它下一次有事件时恢复。`peers` 与 SessionStart 介绍会说明只有 `listening` 的会话能马上回复。

### 修复

- 后台等待算作活动，等待超过 30 分钟的会话不会在两次等待之间被标为 `offline`。开着 `listen` 的会话在等待全部结束后不再一直停在 `listening`；host 重启时也会复位残留的 `listening` 会话，30 分钟无活动后和其他会话一样变为 `offline`。
- 开始、结束、重新打开会议时，会议本身和活跃会议在同一个事务里更新。
- 事件过滤 `action` 只匹配完整名称或完整的 `<action>.` 前缀，不再忽略大小写，也不再把 `_`、`%` 当通配符。
- host 在请求超时内没有应答的工具调用只让这一次失败；MCP 适配器不再因此丢掉工具列表并重连，避免客户端重试 host 仍在执行的调用。
- Windows：`install <claude|codex>` 能找到 npm 安装的 `claude.cmd` / `codex.cmd`，`--wait` hook 也能叫醒这样安装的 Codex。直接用 Node 运行 npm 包装脚本背后的程序，不经过 cmd.exe，消息文本不会被当成命令执行，换行也能保留；从 npx 缓存路径安装会像其他系统一样被拒绝。
- `create_task` 的说明不再指向不存在的工具。
- npm 包带上 README 和指南里链接的文档（工具参考、安全、贡献指南、中文助手指南、2025-12-29 会议记录）。

## [0.8.2] - 2026-10-22

### 修复

- 两个 daemon 在全新存储目录上同时启动时，输掉的那个不再在到达端口前以 `SqliteError: database is locked` 崩溃；数据库初始化会等待另一个进程，输家按设计因 `EADDRINUSE` 退出。
- 文件存储的读取（`get_project`、`search_projects`、拓扑、全局文档）与写入共用一把读写锁，`rename_project` 进行中的读取不再返回文档和技术栈为空的条目。
- `sync_project_assets` 与 `update_project` 先写 manifest 和文档、最后写 registry，后一步失败时还原已写的文件；创建失败不再留下没有目录的项目，更新失败不再出现新旧字段混合。
- 0.6.0 之前写入的任务时间（`YYYY-MM-DD HH:MM:SS`）在启动时转换为 ISO 8601，不再提前最多一天被清理。
- `n2n-nexus uninstall`（以及 `install`）在 `mcp remove` 失败且客户端配置里仍有注册时报错、退出码 1 并说明处理办法；本来没注册的情况照旧忽略。

## [0.8.1] - 2026-10-22

### 新增

- `n2n-nexus install <claude|codex>` 写入 PATH 上的 `node`（当它就是当前运行的 Node 时），不再写 `process.execPath` 解析出的带版本号目录（nvm、Homebrew Cellar、fnm 等），这类目录在升级 Node 后会消失。`--node <path>` 可手动指定路径，路径必须存在、能运行且满足 `engines.node`。`install` 会打印实际写入的路径，位于版本目录时给出提示。
- `n2n-nexus doctor [claude|codex]`：检查已安装的 hook 命令和 MCP 命令里的 Node 路径与入口脚本是否存在、能否运行，并给出修复建议。

### 修复

- daemon 响应改为流式 UTF-8 解码，跨块的多字节字符不再变成 U+FFFD。
- `rename_project` 把目录、manifest 和 registry 条目作为一个整体重命名，任一步失败全部回滚。
- `host_delete_project` 在项目文件删不掉时返回失败并保留 registry 条目。
- `upload_project_asset` 在写锁内检查项目存在，与删除并发时不再把已删除的项目重新建出来；返回的是实际保存的文件名；清洗后为 `.` 的文件名会被拒绝。
- `listen({ on: false })` 会结束正在等待的 Stop hook，而不是等到超时。

### 升级说明

- 重新运行 `n2n-nexus install claude` 和/或 `n2n-nexus install codex`，让 hooks 和 MCP 命令使用稳定的 Node 路径。

## [0.8.0] - 2026-10-21

### 新增

- 每个 Claude Code 和 Codex 对话都是一个独立会话，ID 为 `claude:<id>` 或 `codex:<id>`，直接使用客户端分配的 ID。恢复对话、重启适配器、子代理都沿用同一身份。
- 直接消息工具 `peers`、`send`、`read`、`reply`、`listen`、`set_profile`。工具调用通过 MCP 请求的 `_meta` 标明所属对话（Claude Code 是 `claudecode/toolUseId`，由 PreToolUse hook 绑定；Codex 是 `sessionId`），不经过参数。
- `n2n-nexus hook <claude|codex>` 与 `POST /api/hook`：客户端 hooks 维护每个对话的状态（working、idle、listening、offline），并在用户发来新消息时、每次工具调用后、本轮结束前一次通知新消息。通知只带发送方和第一行，正文通过 `read` 以工具结果的形式读取。
- `listen`：对话结束一轮后继续等待最多 590 秒，消息一到就接着处理。`send(notifyWhenIdle)` 在收件方下一次结束一轮或离线时通知一次。未读消息 24 小时后过期，并通知发送方。
- `n2n-nexus install <claude|codex> [--endpoint <url>]` 与 `uninstall`：在客户端的用户级配置里写入或删除 hooks 和 MCP 服务，与已有设置合并。Codex 的 hooks 需要先用 `/hooks` 信任一次。
- 本机地址（`127.0.0.1` 或 `localhost`）上没有 daemon 时，适配器和 hooks 会在后台拉起一个，日志在 `~/.n2n-nexus/daemon.log`。

### 移除

- `list_sessions`、`update_session`、`read_inbox`、`get_message`、`acknowledge_message`，`send_message` 的 `to`、`replyTo`、`ttlMs` 参数，`POST /api/sessions/register` 与 `POST /api/sessions/disconnect`，以及适配器的随机会话 ID 和心跳。`send_message` 现在只发到会议和全局聊天。

### 修复

- 两个 daemon 在全新的存储目录上同时启动时，后一个不再在战略文档迁移里崩溃，而是因 `EADDRINUSE` 退出。

### 升级说明

- 升级后执行 `n2n-nexus install claude` 和 / 或 `n2n-nexus install codex`；直接消息依赖这些 hooks。其他 MCP 客户端仍可使用除直接消息以外的全部工具。
- 0.7.0 的会话和直接消息不做迁移，旧表不再读取。

## [0.7.0] - 2026-10-20

### 新增

- 会话发现：`list_sessions` 与 `update_session`。每条 MCP 连接有独立的会话 ID、显示名称、可选的项目关联、接收消息策略，以及基于心跳的在线状态。共用同一实例 ID 的连接各有独立收件箱。
- 直接消息：`send_message(to, replyTo?, ttlMs?)`，以及 `read_inbox`、`get_message` 和 `acknowledge_message`。回执区分已接受、已取回、已确认、已回复、已拒绝和已过期。已取回但未确认的消息仍可再次取回，回复会关联到原消息。

### 变更

- MCP 适配器注册自己的连接身份，并用心跳维持。稳定的实例 ID 继续用于标识旧的共享消息游标和会议权限。
- 更新了兼容的运行时和开发依赖，包括 Zod、ESLint、typescript-eslint、Vitest 和 Lefthook。

### 修复

- 战略文档迁移现在会记录完成状态，并保留有冲突的文档，防止之后的用户文档被误认为旧数据、在重启时被删除。
- HTTP 响应中断时，现在会让等待中的请求失败，而不是让连接尝试、工具调用或关机无限期等待。
- 格式错误的 Host 头和请求 URL 返回 HTTP 400，不会让 daemon 退出；原有的浏览器和 Host 限制仍然有效。
- 并发地把同一个项目重命名为不同目标时，不会再同时报告成功，也不会记录一次实际没有发生的重命名。
- MCP 适配器可以连接 IPv6 的 daemon 地址，不再把地址两侧的方括号当成 DNS 主机名的一部分。
- 任务过期计算保留时间戳的毫秒部分，维护任务不会在 TTL 到期前就把任务判为失败。

### 升级说明

- 先升级 daemon，再把 MCP 适配器重启到 0.7.0。新适配器在执行工具前需要 daemon 提供会话注册接口。升级后的 daemon 仍支持原有的会议和全局消息操作。
- 收件箱按 MCP 连接划分。宿主里共用一条连接的多个聊天共用一个收件箱；重启适配器会创建新会话，不会继承之前的收件箱。
- 收到的消息需要显式调用 `read_inbox`；本版本不会自动唤醒模型。在线状态只表示近期有心跳，已取回不代表已处理，确认表示收到，不表示工作已完成。

## [0.6.0] - 2026-10-16

### 新增

- 限流（MCP 工具规范对服务端的要求）：每个实例 ID 一个令牌桶（默认每秒 20 次、突发 60 次；`NEXUS_RATE_LIMIT`、`NEXUS_RATE_BURST`，设 `0` 关闭），另按客户端地址以 5 倍额度再限一次，因为实例 ID 由调用方自报。不带实例 ID 的请求（多数 REST 读接口）只按地址限流。超限时守护进程返回带 `Retry-After` 的 `429`，MCP 适配器把它作为工具错误交给模型，连接不受影响。`/health` 与 `GET /api/tools` 不计入。

- 结构化工具结果：每次成功调用在 JSON 文本之外同时返回 `structuredContent`，11 个返回数据的工具发布 `outputSchema`。结果结构是 `src/daemon/tool-outputs.ts` 中的 zod 契约，并用于给处理函数定类型；有测试经适配器在新旧两代协议下调用全部工具，逐个按契约校验结果。若写入类工具也发布 schema，`tools/list` 会从约 14 KB 涨到 27 KB，而它们只返回一行确认，因此未发布（只发布读取类时为 22 KB）。

- 每个工具新增显示用的 `title`（例如 "Delete Project"），MCP 客户端会用它代替原始工具名展示。

- 所有工具加上 MCP 工具注解（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`），客户端可以区分只读工具和会覆盖或删除数据的工具，并在调用后者前请用户确认。

- 新增 `list_meetings` 工具与 `GET /api/meetings`：列出会议及其状态、发起者、参与者、消息与决策数、摘要。此前助手只能访问已知 ID 的会议。

- 新增 `get_project` 工具与 `GET /api/projects/:projectId`：读取项目完整 Manifest 和内部文档。此前助手能同步却无法读回。

- 新增 `get_global_strategy`、`list_global_docs`、`get_global_doc` 工具。此前助手能写主策略和共享文档，却没有工具读回，只有 REST API 能读。

- `list_events` 工具与 `GET /api/events`：结构化活动日志（actor、action、target、detail），记录经由 daemon 发生的每次状态变更。

### 移除

- `register_session_context` 与 `POST /api/session/register`。守护进程为每个实例在内存里记“当前项目”，只有 `upload_project_asset` 用它；MCP 2026-07-28 取消了协议会话，并建议跨调用状态以显式工具参数传递。`upload_project_asset` 改为接收 `projectId` 并校验项目存在。

- 0.5 之前选举架构的残留与其他死代码：未使用的常量（`PORT_RANGE_*`、`HANDSHAKE_TIMEOUT`、`HEARTBEAT_INTERVAL`）、`hasFlag`、`HubConfig`/`ToolContext`/`MeetingState` 类型、`isSqliteAvailable`、`getTasksByMeeting`、`getActiveTaskCount`、`NexusClient.health`、从未使用的 `archives/` 目录与 `tasks.json` 路径、`suggestedSyncTargets`（解析早已不存在的 `name@project` 实例 ID 格式）、未写入文档的 `NEXUS_PORT`（`NEXUS_DAEMON_PORT` 的别名）以及 `migrations/003_add_tasks_table.sql`（schema 在 `sqlite.ts` 中）。两份 `getRootPath` 实现合并到 `config/paths.ts`，`--root ./relative` 与 `~` 的解析因此一致。`billing` 在读取与 patch 时不再被丢弃。

- 会议存储的 JSON 回退（`store.ts`、`meetings.ts`）与 `/api/storage/info` 端点。SQLite 为必需依赖，daemon 不再报告“degraded”存储模式。

### 修复

- `NEXUS_RATE_BURST` 取 0 到 1 之间的值会让所有调用永远返回 429，取 0 则静默关闭限流。现在突发数至少为 1，只有 `NEXUS_RATE_LIMIT=0` 才关闭限流。

- 旧版本（其 `update_project` 未经校验就写盘）写入的 manifest 中，relations、endpoints、apiSpec 等嵌套项可能缺字段或带多余字段，导致 `get_project` 与 `get_global_topology` 在 2026-07-28 客户端上通不过 outputSchema 校验。现在读取时规范化：丢弃无效项，缺失的字符串补为空，未知关系类型按 `related` 处理；不改写磁盘文件。

- 结果契约此前只靠 TypeScript 约束，而 TypeScript 不检查返回变量里的多余字段，存储数据新增字段就可能以违反已发布 `outputSchema` 的 structuredContent 到达客户端。现在每个结果出守护进程前都经过 zod 契约：剥掉未声明字段，无法满足契约的结果变为服务端错误。

- 一次重连尝试刚连上、还在通知客户端时，若有工具调用再次失去守护进程连接，这次尝试结束后仍会停掉重连循环，而适配器已经断开；之后每次调用都只返回 "Daemon is not ready yet"，直到重启 IDE。现在只有连接仍然在线时才停止重连。

- 适配器的重连循环使用 3 秒的 `setInterval`，而单次尝试最长要等 5 秒请求超时，守护进程假死时请求会层层叠加。现在每次尝试结束后才安排下一次。

- `rename_project`、`cancel_task`、`end_meeting`、`archive_meeting`、`reopen_meeting` 此前标注为 `destructiveHint: false`，而 MCP 规定该值只用于纯追加式工具，客户端可能不经用户确认就执行它们。现在标为破坏性。

- 守护进程报告工具不存在时（例如升级后适配器未察觉），适配器虽返回 `-32602`，`tools/list` 却仍列出该工具。现在会重新拉取工具列表，有变化时发送 `list_changed`。

- 适配器此前先拉取守护进程工具列表、再开始读 stdin。守护进程接受连接却不回应时，`server/discover` 与 `initialize` 要等 5 秒客户端超时，足以让探测型客户端把它误判为旧版服务器，stdin 关闭后也迟迟不退出。现在适配器立即开始服务，在后台拉取。

- 在 2026-07-28 连接上，不带 `io.modelcontextprotocol/clientInfo` 的请求（规范只是 SHOULD）得到的实例 ID 不含 IDE 名，同一客户端会变成两个实例，未读游标和会议权限随之分裂。适配器现在沿用该连接上第一次见到的客户端名。

- 调用适配器不认识的工具时，此前返回 `isError: true` 的工具结果。MCP 规范把未知工具归为协议错误，适配器现在返回 JSON-RPC 错误 `-32602`（Invalid Params），守护进程报告工具不存在时同样如此。

- IDE 关闭 stdin 后 MCP 适配器不退出：守护进程不可达时，3 秒一次的重连定时器让进程一直存活，留下孤儿适配器。现在 stdin 结束时适配器会关闭并退出，符合 stdio 传输规范。

- 与 `Object.prototype` 键同名的项目和文档 ID 处理错误：`register_session_context({ projectId: "constructor" })` 对不存在的项目返回成功，名为 `__proto__` 的项目或文档写入后丢失（赋值改写了对象原型）。注册表与文档索引改为无原型的映射。

- `sync_project_assets` 分两次加锁分别写 manifest 和内部文档，并发的 `host_delete_project` 可以插在两步之间，留下注册表不认识的项目目录。现在两步在同一临界区内完成。

- `npm run build` 现在先清空 `build/`。单独的 `tsc` 会留下已删除源码的编译产物（例如 `build/storage/store.js`），`npm publish` 会把它们一起发布。

- 任务的 `ttl` 只存不用，`cleanupTasks` 也从未被调度，tasks 表无限增长。daemon 现在在启动时和每小时执行任务维护：超过 TTL 的 pending/running 任务标记为 `failed`（`TTL expired`），完成超过 7 天的任务被清除。同时删除 `tasks_updated_at` 触发器：它会用另一种格式的 `datetime('now')` 覆盖 `updateTask` 写入的 ISO 8601 `updated_at`，使时间比较混用两种格式。

- `update_global_strategy` 写的是 `global/docs/strategy.md`，而文档把 `global/blueprint.md` 描述为主战略文档，且两处初始化用不同占位文案各创建一次 `blueprint.md`。现在该工具写入 `blueprint.md`，`GET /api/global/strategy` 读取它。首次启动时会把已有的 `strategy` 全局文档搬进 `blueprint.md`（除非那里已有非占位内容）并从文档索引中移除。

- `sqlite.ts` 在模块加载时注册的 SIGINT/SIGTERM 处理器会立即 `process.exit(0)`，导致 daemon 的 `server.close` 优雅关闭从不执行。信号处理改到 daemon 入口：停止接受连接、处理完进行中的请求、关闭数据库、再退出。

- 工具参数此前完全不校验：daemon 直接断言类型，让 SQLite 或文件系统在后面报错（例如 `category: "SYSTEM"` 会变成 `CHECK constraint failed` 的 500）。现在每个工具在 `src/daemon/tools.ts` 有 zod 契约，提供给 MCP 客户端的 JSON Schema 由它生成，同一契约校验工具调用与 REST 端点，失败返回 400 并指出出错字段。`update_project` 的 `patch` 拒绝未知字段，`create_task` 会检查 `source_meeting_id` 是否存在，SQLite 外键约束已启用。

- MCP 适配器每次启动随机生成实例 ID，IDE 重启后未读游标归零，会议也没人能再结束或归档（只有发起者可以）。默认值改为 `mcp-<主机名>-<工作目录哈希>-<IDE 名>`（IDE 名来自 MCP 握手），同一机器、同一工作区、同一 IDE 保持不变。`reopen_meeting` 与 `end_meeting`、`archive_meeting` 一样只允许发起者操作。

- daemon 此前接受任何 HTTP 请求，用户浏览器中打开的网页可以用跨站 `text/plain` POST 调用本地 daemon 的 `host_delete_project`。现在拒绝带浏览器 `Origin` 或跨站 `Sec-Fetch-Site` 头的请求（403），POST 必须是 `Content-Type: application/json`（415），请求体上限 16 MB（413），不再无限缓冲。`Host` 头必须是 IP、`localhost`、`host.docker.internal` 或 `NEXUS_ALLOWED_HOSTS` 中的域名，以阻断以同源 GET 形式到达 daemon 的 DNS rebinding 页面。

- MCP 适配器此前把任何失败的工具调用（任务不存在、会议已关闭、权限不足等）都当成 daemon 掉线：清空工具列表、通知 IDE 并进入重连循环。现在传输失败与工具失败区分开（`NexusTransportError` 与 `NexusToolError`），只有前者触发重连，工具失败以 `isError` 结果返回。`POST /api/tools/call` 对未知工具返回 404，对工具拒绝的调用返回 400。

### 变更

- MCP 适配器从 `@modelcontextprotocol/sdk` 1.x（协议 2025-11-25）迁移到 v2 SDK（`@modelcontextprotocol/server` 2.3），通过 `serveStdio` 在 stdio 上同时服务无状态的 2026-07-28 版与 2025 代客户端。2026-07-28 客户端可使用 `server/discover`、每请求 `_meta` 信封，并经 `subscriptions/listen` 收到列表变更通知；实例 ID 从请求信封读取客户端名。第一次 `tools/list` 最多等待 1 秒的启动拉取，本地守护进程在线时即完整；即使守护进程假死，`server/discover` 与 `initialize` 也立即得到响应。

- 无参数工具（`get_global_strategy`、`list_global_docs`）的 schema 改为 MCP 规范推荐的 `{ "type": "object", "properties": {}, "additionalProperties": false }`，并拒绝多余参数。

- `send_message` 的路由不再依赖 `register_session_context`：给了 `meetingId` 就发到该会议，否则发到活跃会议，否则发到全局聊天。`POST /api/messages/send` 采用同一规则（去掉了 `source` 参数），不再有一套默认值不同的独立代码路径。

- 全局聊天从 `global/discussion.json` 迁入 SQLite。不带 `meetingId` 的 `read_messages` 现在真正按实例增量读取（工具描述此前就这样承诺），追加不再重写整个文件，`host_maintenance` 会返回删除条数。daemon 首次启动时会导入已有的 `discussion.json`（五种已知类别之外的 category 置空），并将其改名为 `discussion.json.migrated`。
- daemon 的状态变更（注册会话、项目同步/重命名/删除、会议结束等）记录为事件，不再以 `SYSTEM` 行写入全局聊天。

- `sync_project_assets`、`update_project`、`rename_project`、`host_delete_project` 改为同步执行并直接返回结果，不再返回需轮询的 `task_id`。这些操作只需毫秒级时间，后台任务封装只多了一次轮询往返，还让写入与其他请求并发竞争。

- 要求 Node.js 22.14+（22.x 系列）或 23.6+，并将 MCP SDK、SQLite 与测试依赖更新到最新兼容稳定版。

## [0.5.0] - 2026-06-14

### 🏗️ Daemon + MCP 架构（破坏性重构）

架构全面重写。旧的 Host/Guest 选举机制被独立 HTTP daemon 取代，daemon 成为唯一的真相来源。

**原因**：选举模型假设所有 AI 实例共享同一个 `localhost`。这在 Windows/WSL/VM 跨环境场景下完全失效（各自处于不同的 localhost 命名空间），且在"Host" IDE 关闭时会导致其他实例无法访问数据。Split-brain 风险不可接受。

#### 新架构
- **`n2n-nexus daemon`** — 独立 HTTP 服务器；用户手动启动，持续运行；持有所有数据、工具定义和业务逻辑；不随 IDE 关闭而消亡
- **`n2n-nexus mcp`** — 无状态 MCP 代理；由 IDE 通过 `npx` 启动；从 daemon 拉取工具列表（`GET /api/tools`），转发每个工具调用（`POST /api/tools/call`）
- **跨环境支持**：通过配置 `NEXUS_ENDPOINT` 桥接 Windows/WSL/VM 或远程机器

#### MCP 行为
- 启动时工具列表为空；后台重试循环（每 3 秒）直到 daemon 可达
- 连接成功后：发送 `notifications/tools/list_changed` → IDE 自动重新加载工具列表
- daemon 断开后：清空工具列表，通知 IDE，重新进入重试循环
- MCP 内不含任何 hardcode 工具名——daemon 升级新工具后所有 MCP 实例无需更新即可获得新能力

#### 已删除（新架构不再需要）
- `src/network/` — 选举、Host、Guest 逻辑
- `src/auth/` — Host/Guest 权限门控
- `src/tools/handlers/`、`src/tools/definitions.ts`、`src/tools/schemas/`
- `src/resources/` — MCP Resources 层
- `src/server/resources.ts`、`src/server/tools.ts`

#### 存储层不变
`src/storage/` 保持原样。SQLite WAL 模式是安全的，因为只有 daemon 进程直接写入；MCP 进程通过 HTTP 间接访问，天然串行，无并发冲突。

---

## [0.4.2] - 2026-01-14
### 🛡️ 稳定性与自动化 (Stability & Automation)
- **Lefthook Integration**: 引入高性能 Git 钩子。现在提交时自动运行 `lint`，推送时自动运行 `build + test`，确保零回归。
- **E2E Test Stability**: 修复了子进程日志阻塞导致的测试挂起问题（通过实现 `stdout` 泄流）。
- **CLI Port Override**: 修复了 `--port` 命令行参数在 Host 选举过程中被忽略的 Bug。
- **Non-blocking Handshake**: 优化了 Stdio 连接逻辑，防止其阻塞选举。

## [0.4.1] - 2026-01-14
### ✨ 开发者体验与可观测性 (Developer Experience & Observability)
- **MCP Logging Protocol**: 实现了标准的 `notifications/message` 协议支持。调试日志现在直接显示在 IDE 的 "Model Context Protocol" 输出频道中。
- **Improved Stdio Handling**: 严格验证并确保了 `stdout` 流的 JSON-RPC 合规性，防止 IDE 插件加载失败。
- **Better Error Reporting**: 启动失败时会在 `stderr` 中提供更具描述性的上下文信息。

## [0.4.0] - 2026-01-14
### 🚀 高可用与高扩展 (High Availability & Scalability)
- **Failover Mechanism**: 实现了自动的 Guest-to-Host 故障转移。如果 Host 进程意外退出，Guest 会检测到端口/锁释放并立即接管 Host 角色，同时保证数据持久性。
- **Progressive Discovery**: 新增 `search_projects` 工具。允许 AI 根据意图搜索相关项目，而无需读取包含 1000+ 项目的完整注册表，大幅节省 Token。
- **Immediate Handshake**: 实现了请求缓冲机制 (Request Buffering)，允许 Server 在 Host 选举 (~300ms) 完成前就立即接受 (<10ms) IDE 的请求，彻底解决了启动时的竞态条件。
- **Stability**: 增加了针对进程故障转移 (`tests/failover.test.ts`) 和请求缓冲 (`tests/buffered_requests.test.ts`) 的端到端测试。

## [0.3.9] - 2026-01-14
### 🚀 故障切换与立即握手
- **立即握手**: 实现了基于缓冲区的设计，Stdio 启动后 <10ms 内即可响应，不再阻塞 IDE 等待选举。
- **自动故障切换**: 新增了 `Failover` 机制。如果 Host 进程被杀或崩溃，存活的 Guest 会在检测到连接断开后立即触发重新选举，并自动晋升为新 Host。
- **零配置 V2**: 进一步优化了启动流程，完全无需用户干预即可组建高可用集群。

## [0.3.5] - 2026-01-10
### 协议与稳定性
- **修复 (僵尸 Host)**: 实现了“智能重试”和“重新选举”逻辑。如果 Guest 反复连接到僵尸 Host（握手成功但 SSE 断开），现在会自动触发重新选举流程，将坏端口加入黑名单，并在必要时在从端口上将自身提升为 Host。
- **重构**: 启用了动态角色切换 (Guest -> Host)，无需重启进程。

## [0.3.4] - 2026-01-10
### 协议与稳定性
- **新握手协议**: 引入 `POST /nexus/handshake` 替代旧版 `/hello`。支持严格的客户端/服务端版本校验和稳健的 Host 探测。
- **全局错误安全网**: 增加了 `uncaughtException` 和 `unhandledRejection` 处理器，防止后台任务错误导致进程退出，确保 Hub 的高可用性。
- **修复 (EOF 错误)**: 解决了由于 SQLite 非幂等初始化导致的“连接关闭：EOF”崩溃问题。
- **修复 (僵尸 Host)**: 改进了 Guest 的 Host检测逻辑，消除了死循环重试。
- **测试覆盖**: 新增 `guest_connection.test.ts` 验证 Guest-Host SSE 集成。

## [0.3.3] - 2026-01-10
### 🔄 零配置持久化 (Zero-Config Persistence)
- **支持 XDG Base Directory**: 将存储位置从不稳定的 `node_modules` 迁移至系统标准的 User Data 路径：
  - **Linux/WSL**: `~/.local/share/n2n-nexus`
  - **Windows**: `%APPDATA%\n2n-nexus`
  - **macOS**: `~/Library/Application Support/n2n-nexus`
- **数据持久化**: 数据现在可以从 `npx` 缓存清理、项目删除和重新安装中幸存。
- **监听地址**: 默认监听地址更改为 `0.0.0.0` 以支持 WSL 镜像模式网络。
- **身份安全**: 默认的 "Assistant" ID 现在会自动追加随机后缀（例如 `Assistant-x9a2`），以防止多个空 IDE 连接时发生冲突。

## [v0.3.0] - 2026-01-08

### 🌐 全局 Hub 架构 (零配置多 IDE 协作)

此版本引入了全自动的 Host 选举和全局 Hub 架构，无需任何配置即可实现多 IDE 无缝协作。

#### 自动 Host 选举 (基于端口)
- **端口范围 5688-5700**: 首个绑定端口的实例成为 Host，其余成为 Guest。
- **探测优先策略**: Guest 在尝试绑定前先扫描已有 Host，消除竞态条件。
- **Hello 握手协议**: `/hello` 端点验证 Nexus 身份，区分其他服务。
- **10 秒接管窗口**: 绑定失败后，Guest 等待 10 秒再探测加入胜者。

#### 全局 Hub (基于 SSE 通讯)
- **单一 Hub 架构**: 所有 IDE（不论哪个项目）都连接到同一个 Host，实现跨项目协作。
- **Stdio-to-SSE 代理**: Guest 透明地将 IDE 流量转发到 Host。
- **多会话路由**: Host 维护会话映射，支持多个 Guest 并发连接。
- **存储路径继承**: Host 广播 `rootStorage` 路径；Guest 继承它以实现无缝故障转移。

#### 心跳与看门狗 (高可用)
- **Host 心跳**: Host 每 30 秒发送 `: ping` 保持连接活跃。
- **Guest 看门狗**: Guest 监控活动；若 60 秒无响应，自动触发重选。
- **热故障转移**: 存活的 Guest 自动使用继承的存储路径升迁为新 Host。

#### 术语重构
- **Moderator → Host**: 所有代码、测试和文档已更新。
- **`isModerator` → `isHost`**: API 和配置属性已重命名。
- **`moderator_*` → `host_*`**: 工具名已更新（如 `host_maintenance`）。

#### 零配置体验
- **`--id` 弃用**: 实例 ID 现在自动从项目文件夹名派生。
- **`--host` 移除**: Host 角色通过端口绑定自动确定。
- **简化 CLI**: 只需 `npx n2n-nexus` 即可开始。

| 指标 | 之前 | 之后 |
|------|------|------|
| 必需 CLI 参数 | 2-3 | 0-1 |
| 手动 Host 设置 | 需要 | 自动 |
| 多 IDE 同步 | 基于文件 | SSE 实时 |
| 故障转移时间 | 手动重启 | < 10 秒 |

#### 测试覆盖
- 新增 `election.test.ts`，包含 9 个覆盖探测、绑定和竞争场景的测试用例。
- 全部 55 个测试通过。

## [v0.2.1] - 2026-01-01

### 🚀 Token 经济深度优化

此版本重点优化了 AI 加载 MCP 服务端时的上下文窗口 (Context Window) 消耗。

#### 工具定义优化 (-49% Token 消耗)
- **精雕细琢的 Schema**: 使用手动优化的 `definitions.ts` 替换了 `Zod.toJSONSchema()`。
- **移除 $schema 冗余**: 消除了每个工具定义中的 `$schema` 声明（每个工具节省约 50 字符）。
- **精简描述**: 将平均描述长度缩短了 50%。
- **隐藏内部工具**: `update_task`（标记为 `[INTERNAL]`）已从公开的 `ListTools` 中排除。

| 指标 | 优化前 | 优化后 | 提升 |
|--------|--------|-------|-------------|
| 工具定义字符数 | 10,241 | 5,237 | **-49%** |
| 预估 Token | ~2,560 | ~1,310 | **-1,250 tokens** |

#### 增量消息读取
- **已读游标表**: 新增 `read_cursors` SQLite 表，追踪每个 IDE 实例在每个会议中的最后阅读消息 ID。
- **自动增量**: `read_messages` 自动根据 `instanceId` 只返回未读消息。
- **零配置**: 无需 `afterId` 参数 — 游标完全由服务端维护。
- **响应增强**: 返回 `{ newMessages: N, messages: [...] }` 便于 AI 验证。

#### Context7 风格渐进加载
- **`get_global_topology` 升级**:
  - **默认 (列表模式)**: 返回轻量级摘要 `{ totalProjects, totalEdges, projects: [{id, name}] }`。
  - **聚焦模式**: 传入 `projectId` 获取该特定项目的详细子图。
- **`listResources` 优化**:
  - **O(1) 扩展性**: 资源列表大小现在是常量，不再随项目数量增长。
  - **静态资源**: 固定 8 个核心资源（聊天、注册表、文档、会议等）。
  - **基于模板的项目**: 不再动态列出每个项目；改用路径模板。
  - **发现流程**: AI 先读取 `hub/registry` → 发现项目 ID → 根据模板构造 URI。

| 场景 | 优化前 | 优化后 |
|----------|--------|-------|
| 0 个项目 | 8 资源 | 8 资源 + 4 模板 |
| 20 个项目 | 28 资源 | 8 资源 + 4 模板 (固定) |
| 50 个项目 | 58 资源 | 8 资源 + 4 模板 (固定) |

#### 文档
- 更新了 `README.md`，包含新的工具行为描述。
- 将 `ASSISTANT_GUIDE.md` 升级至 v0.2.1，引入“渐进式发现，增量读取”原则。
- 重新组织了 Resources 章节，采用“核心资源 + 资源模板”结构。

## [v0.2.0] - 2025-12-31

### 🚀 任务原语系统 (Phase 2 & 3)
- **异步深耕**: 关键阻塞操作 (`rename_project`, `host_delete_project`) 迁移至 Task 原语，支持背景级联更新。
- **可追溯性**: 所有任务现在都支持 `source_meeting_id`，将执行结果与会议决策关联。
- **进度展示**: 增加了进度追踪 (0.0-1.0) 和 `result_uri` 结构化输出。
