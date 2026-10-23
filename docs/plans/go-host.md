# 实施方案：Go 重写独立 host（n2n-nexus-host）

状态：方案待确认　｜　日期：2026-10-23

## 1. 目标与完成标准

用 Go 重写现在的 TS daemon，做成独立可执行文件 `n2n-nexus-host`：默认以托盘程序驻留，`--service` 时作为开机启动的后台服务运行。npm 包 `n2n-nexus` 只保留客户端（MCP 适配器、hooks、install），不再含 daemon、存储和 SQLite。借这次重写清掉存储层和协议上的技术债，不留兼容代码。

完成标准（全部满足才算完成）：

1. 一致性测试（第 6 节）在 Windows、macOS、Linux 三个平台上对 Go host 全部通过。
2. `go test ./...`（host 单元测试）与 `npm run check`（客户端）通过。
3. `tests/e2e/hooks-e2e.sh` 用真实的 `claude` 和 `codex` 连 Go host 跑通，留下日志。
4. 在 Windows 上手动验收托盘和 `--service`：托盘菜单每一项、登录后自启、服务开机启动和退出后 5 秒内重启、局域网模式加防火墙规则；结果记入验收记录。
5. 仓库里不再有 TS daemon、TS 存储层、`install host` 及其测试；文档里不再出现它们。
6. `host-v1.0.0` 与 npm `n2n-nexus@1.0.0` 发布成功：GitHub Release 含各平台文件、SHA-256 校验值和构建证明，scoop、Homebrew formula、winget 清单可用。

## 2. 已确认的决定

| 项目 | 决定 |
|---|---|
| 运行方式 | 同一个程序：默认托盘，登录后自启；`service install` 注册开机启动的后台服务。服务以安装它的用户身份运行 |
| 代码位置 | 本仓库 `host/` 目录，Go 模块 `github.com/n2ns/n2n-nexus/host` |
| 存储 | 单个 SQLite 文件，全部数据建成正规的表，每个写操作一个事务，表结构用带版本号的迁移脚本管理 |
| 旧数据 | 不导入、不读取；旧 `~/.n2n-nexus` 原样保留 |
| 协议 | 只保留 `GET /health`、`GET /api/tools`、`POST /api/tools/call`、`POST /api/hook`；新增 `update_task` 工具；其余 REST 接口删除 |
| 平台 | Windows、macOS、Linux（amd64 与 arm64） |
| 发布 | GitHub Releases（SHA-256 + 构建证明）；Windows 用 winget 和 scoop，macOS 用从源码编译的 Homebrew formula，Linux 用 tar 包；第一版不签名（见 TODO） |
| 数据目录 | Windows `%LOCALAPPDATA%\n2n-nexus`，macOS `~/Library/Application Support/n2n-nexus`，Linux `$XDG_DATA_HOME/n2n-nexus`（默认 `~/.local/share/n2n-nexus`）；`--root` 或 `NEXUS_ROOT` 可改 |
| 托盘语言 | 跟随系统语言：中文系统中文，其他英文 |
| 数据清理 | 事件、已读或已过期的直接消息、已发出的通知保留 30 天；工具调用绑定过期即删；已结束的任务 7 天；日志单个 10 MB、保留 3 个 |
| 版本 | host 与 npm 客户端都从 1.0.0 开始；当前 [Unreleased] 不单独发布 |
| 发版标签 | npm 客户端 `v*`（现有 `publish.yml`）；host `host-v*`（新 `host-release.yml`） |

## 3. 协议（`contract/`）

协议文件放在仓库根目录 `contract/`，是两边唯一的来源：Go host 用 `go:embed` 嵌入，TS 客户端和一致性测试直接读取，npm 包随包发布。

| 文件 | 内容 |
|---|---|
| `contract/tools.json` | 每个工具的名称、说明、输入 JSON Schema、输出 JSON Schema |
| `contract/hook.json` | hook 请求字段（`HOOK_INPUT_FIELDS`）、输出格式、`BACKGROUND_WAIT_EVENT`、各项超时与时限常量、`_meta` 键名、会话状态枚举 |
| `contract/errors.json` | 错误返回格式与状态码：400 参数错误、403 Host / 浏览器来源、404 工具不存在、413 请求过大、415 非 JSON、429 限流（带 `Retry-After`） |

做法：

- 第一次用一次性脚本从现有 zod 定义导出（`z.toJSONSchema`），人工核对后提交；脚本不进仓库。之后直接编辑这些 JSON 文件。
- 新增 `update_task`：参数 `taskId`，以及与现有 `TaskUpdate` 相同的可选字段 `status`、`progress`（0.0–1.0）、`result_uri`、`error_message`、`metadata`；取代原来的 `POST /api/tasks/:id/update`。
- 删除的接口：`/api/messages/*`、`/api/projects/*`、`/api/global/*`、`/api/meetings/*`、`/api/tasks*`、`/api/events`、`/api/maintenance/logs`。对应能力都已有同名工具。
- 匿名调用（没有 `instanceId`）不再共用 `unknown` 游标：会推进已读游标的工具在缺少 `instanceId` 时返回 400。
- 工具处理中“找不到”统一返回 400 加明确的错误文字（工具调用只有这一种入口，不再区分 404）。

## 4. Go host 设计

### 4.1 目录

```text
host/
├── cmd/n2n-nexus-host/main.go   # 命令行入口
├── internal/config/             # settings.json、命令行参数、数据和日志目录
├── internal/contract/           # 嵌入 contract/*.json，加载 schema，参数与输出校验
├── internal/store/              # SQLite、迁移脚本、各表的读写
│   └── migrations/0001_init.sql
├── internal/tools/              # 每个工具的处理函数
├── internal/hooks/              # 会话状态机（listening、后台等待、自动轮次）
├── internal/api/                # HTTP：4 个接口、Host/浏览器来源检查、限流、请求体上限
├── internal/discovery/          # UDP 局域网发现应答
├── internal/maintain/           # 定时清理
├── internal/tray/               # 托盘菜单与中英文文本
├── internal/service/            # 各平台服务与自启注册
└── internal/testclock/          # 只在 testclock 构建标签下编译的时间控制
```

依赖：`modernc.org/sqlite`（纯 Go）、`github.com/santhosh-tekuri/jsonschema/v6`（校验）、`fyne.io/systray`（托盘）、`gopkg.in/natefinch/lumberjack.v2`（日志轮转）、`github.com/gofrs/flock`（单实例锁）。Go 1.27。

### 4.2 命令行

```text
n2n-nexus-host                      # 托盘方式（默认）
n2n-nexus-host serve [--host] [--port] [--root]   # 前台无界面运行（服务和调试用）
n2n-nexus-host service install|uninstall|status [--host] [--port] [--root]
n2n-nexus-host autostart on|off     # 托盘登录后自启
n2n-nexus-host version
```

### 4.3 配置

- 配置只来自 `<数据目录>/settings.json`，命令行参数覆盖；字段：`host`（默认 `127.0.0.1`）、`port`（5688）、`discoveryPort`（5688）、`allowedHosts`、`rateLimit`、`rateBurst`、`maxAutoTurns`（8）。
- 环境变量只认 `NEXUS_ROOT`。原来 daemon 读的 `NEXUS_HOST`、`NEXUS_DAEMON_PORT`、`NEXUS_ALLOWED_HOSTS`、`NEXUS_RATE_*`、`NEXUS_MAX_AUTO_TURNS`、`NEXUS_DISCOVERY_PORT` 不再由 host 读取：服务拿不到安装终端的环境变量，配置文件是托盘、服务、命令行共用的唯一来源。
- 托盘改设置时写 `settings.json` 并重启内部服务器。

### 4.4 存储

- 一个文件 `<数据目录>/nexus.db`，WAL 模式，`foreign_keys=ON`，`busy_timeout=5000`。
- 版本号存在 `PRAGMA user_version`；`migrations/NNNN_*.sql` 按序执行，每个文件一个事务；启动时只做这件事，不补列、不修文件。
- 单实例：启动时对 `<数据目录>/host.lock` 加文件锁，拿不到就报“已有 host 在运行”并退出。
- 表（0001_init）：

| 表 | 说明 |
|---|---|
| `projects` | manifest 的标量字段各占一列；`tech_stack`、`endpoints`、`api_spec`、`billing`、`api_dependencies`、`api_versions` 整体读写，存 JSON 列；`internal_docs` 存 TEXT |
| `project_relations` | `(project_id, target_id, type)`，外键 `ON UPDATE CASCADE ON DELETE CASCADE`；改名和删除由数据库级联 |
| `project_assets` | `(project_id, file_name, data BLOB, updated_at)`，外键级联 |
| `global_strategy` | 单行表（`id = 1`） |
| `global_docs` | `(id, title, content, updated_at)` |
| `meetings` | 加 `status`（active / closed / archived）和 `is_default` 字段；去掉 `meeting_state` 键值表，活跃会议用 `WHERE status = 'active'` 查 |
| `meeting_messages`、`decisions` | 外键指向 `meetings` |
| `global_messages`、`events`、`tasks`、`read_cursors` | 沿用现有字段 |
| `agent_sessions`、`agent_messages`、`agent_notices`、`agent_idle_subscriptions`、`tool_use_bindings` | 沿用现有字段 |

- 会议添加消息、开始 / 结束 / 重开会议、改名项目等多条写入都在一个事务里。

### 4.5 会话状态机

- 把 `server.ts` 里的模块级变量（`listeningStops`、`backgroundWaits`、`autoTurns`、`wokenAt`、`agentWake`）收进一个 `hooks.Coordinator` 结构，由 server 实例持有。
- 行为以一致性测试为准，包括本轮修过的：等待结束后离开 `listening`、启动时复位残留的 `listening`、后台等待请求算作活动、自动轮次上限。
- 时间通过一个 `Clock` 接口取得；正式版本用系统时间，`testclock` 构建标签下由测试接口设置。

### 4.6 HTTP 与发现

- 只有 4 个接口；Host 头和浏览器来源检查、`Content-Type`、16 MB 请求体上限、按实例和按地址限流与现在一致。
- `/api/hook` 按会话 ID 单独计限流桶，不和工具调用共用地址桶。
- 局域网发现：监听非回环地址时在 `discoveryPort` 上应答 `n2n-nexus/discover`，回复 `{"service":"n2n-nexus","version","host","port"}`，与现有客户端兼容。

### 4.7 清理与日志

- 每小时一次：删除 30 天前的事件、已读或已过期的直接消息、已发出的通知；删除过期的工具调用绑定；任务按现有规则过期，结束 7 天后删除。启动时先做一次。
- 日志：Windows `%LOCALAPPDATA%\n2n-nexus\logs`，macOS `~/Library/Logs/n2n-nexus`，Linux `$XDG_STATE_HOME/n2n-nexus`（默认 `~/.local/state/n2n-nexus`）；`host.log` 单个 10 MB、保留 3 个。

### 4.8 托盘

- 启动时先看端口上是否已有本机 host（`GET /health` 返回 `service: n2n-nexus`）：有（例如后台服务在跑）就只做控制界面，不再起服务器；没有就在进程内起服务器。
- 菜单：运行状态与地址、在线会话数；打开日志目录、打开数据目录；“仅本机 / 局域网”切换；“登录后自启”开关；重启；退出。
- 切到局域网时：Windows 用 UAC 提权执行 `netsh advfirewall` 添加 TCP 和 UDP 入站规则；macOS、Linux 只提示需要放行的端口。
- 中英文文本放在 `internal/tray/i18n.go`，按系统语言选择。
- Windows 编译加 `-ldflags -H=windowsgui`，不出控制台窗口。

### 4.9 服务与自启

| 平台 | `service install`（开机启动，以当前用户运行） | 托盘自启 |
|---|---|---|
| Windows | 计划任务，开机触发、S4U（不需要密码）、无时限；运行 `n2n-nexus-host serve --supervise` | 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |
| macOS | `/Library/LaunchDaemons/io.n2ns.n2n-nexus-host.plist`，`UserName` 为当前用户，`KeepAlive` | `~/Library/LaunchAgents/io.n2ns.n2n-nexus-host.tray.plist`，`RunAtLoad` |
| Linux | `/etc/systemd/system/n2n-nexus-host.service`，`User=` 当前用户，`Restart=always`、`RestartSec=5` | `~/.config/autostart/n2n-nexus-host.desktop` |

- `serve --supervise`：Go 进程自己拉起子进程 `serve`，子进程退出 5 秒后重启；不再用 cmd 循环。
- `service install` 需要管理员 / root；先停掉已在运行的 host（按单实例锁和 `/health` 判断，不按命令行字符串匹配），再注册并启动，最后报告端口上是谁在监听。

## 5. npm 客户端的改动

- 删除：`src/daemon/`（`hook-contract.ts` 中客户端用到的部分改为读取 `contract/hook.json`）、`src/storage/`、`src/utils/async-rwlock.ts`、`src/cli/host.ts`、`daemon` 与 `install host` / `uninstall host` 命令、依赖 `better-sqlite3`；`zod` 只在 MCP SDK 需要时保留为它的依赖，客户端代码不再直接使用。
- `src/client/discovery.ts` 只保留查询端，删除应答端。
- “没有 daemon”提示改为：本机地址提示安装并启动 `n2n-nexus-host`；远程地址提示到那台机器上启动（保留本轮的区分逻辑）。
- `doctor`：检查 host 是否可达、版本，以及客户端与 host 的协议版本是否一致（`/health` 返回 `contractVersion`，取自 `contract/hook.json`）。
- `package.json` `files` 加入 `contract/`。

## 6. 一致性测试

- 位置 `tests/conformance/`，用 vitest 写，只通过 HTTP 访问外部 host。
- 夹具 `tests/conformance/harness.ts`：用环境变量 `NEXUS_HOST_BIN` 指定的可执行文件，以临时 `--root`、`--port 0` 启动；从标准错误的就绪行读出端口；每个测试文件一个 host 进程。
- 时间：测试版本用 `go build -tags testclock` 构建，提供 `POST /test/clock {"now": <ms>}`；正式版本没有这个接口。
- 来源：现有通过 HTTP 测 daemon 的用例改写进来（`agent_hooks`、`agent_tools`、`daemon_messages`、`daemon_projects`、`events_api`、`global_docs_api`、`global_messages`、`meetings_api`、`tasks`、`message_cursor`、`structured_output`、`tool_validation`、`http_guard`、`rate_limit`、`concurrency`、`daemon_rest_errors`、`prototype_keys`）；直接改存储状态的写法改为通过 hook 或工具达到同样状态；针对已删除 REST 接口的用例删除。
- 存储层的单元测试（`storage*`、`migrations`、`sqlite_init`、`fs-utils`、`projects_api` 中的文件布局部分）随 TS 存储层删除，由 `host/internal/store` 的 Go 测试覆盖同样的行为（事务回滚、级联、迁移版本、清理）。
- 先拿现有 TS daemon 跑一遍一致性测试（除 `update_task` 和已改的协议行为外全部通过），确认测试本身正确，再用来验收 Go host。

## 7. 实施步骤

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 导出并提交 `contract/`；客户端改为从 `contract/hook.json` 读常量 | `npm run check` 通过；导出的 schema 与 `GET /api/tools` 返回一致 |
| 2 | 建一致性测试和夹具，对 TS daemon 跑通 | 一致性测试对 TS daemon 通过 |
| 3 | Go host：config、store、contract、tools、hooks、api、discovery、maintain、`serve` 命令 | `go test ./...`；一致性测试对 Go host 在 Linux 上全部通过 |
| 4 | 托盘、自启、`service install` 三个平台 | Windows 手动验收（第 1 节第 4 条）；macOS、Linux 用 CI 检查注册文件内容，并各手动跑一次 |
| 5 | CI：`.github/workflows/host.yml`，在 `host/`、`contract/`、`tests/conformance/` 变化时于 ubuntu、windows、macos 上跑 `go test` 和一致性测试；lefthook pre-push 加 `go test` 与一致性测试 | 三个平台 CI 通过 |
| 6 | 精简 npm 客户端（第 5 节），删除 TS daemon、存储层、`install host` 及其测试 | `npm run check` 通过；`hooks-e2e.sh` 对 Go host 跑通 |
| 7 | 发布流程：`.github/workflows/host-release.yml`（`host-v*` 触发）；新建 `n2ns/homebrew-tap`（从源码编译的 formula）与 `n2ns/scoop-bucket`；winget 清单随 Release 生成，首次手动提交 `microsoft/winget-pkgs` | 用 `host-v1.0.0-rc.1` 试跑：Release 文件、校验值、`gh attestation verify` 通过，三种包管理器能装上 |
| 8 | 文档：README（中英）、ARCHITECTURE（中英）、TOOLS_REFERENCE（删 REST 一节，加 `update_task`）、CLAUDE.md、llms.txt、SECURITY、CHANGELOG（中英）、TODO；新增 `host/README.md` | 全仓库搜索 `install host`、`n2n-nexus daemon`、`/api/projects`、`better-sqlite3` 无残留 |
| 9 | 发布 `host-v1.0.0` 与 npm `v1.0.0` | 第 1 节第 6 条 |

构建说明：Windows、Linux 的二进制用 `CGO_ENABLED=0` 交叉编译；macOS 托盘依赖 cgo（Cocoa），在 `macos-latest` 上用 `CGO_ENABLED=1` 构建 amd64 与 arm64。

## 8. 风险

- 会话状态机的时序最容易移植出错：以一致性测试为准，且第 2 步先证明测试在 TS 上成立。
- Linux 托盘依赖桌面环境支持 StatusNotifierItem；没有桌面的服务器只用 `service install`。
- 未签名：Windows 首次运行可能有 SmartScreen / Defender 提示，README 说明处理办法；签名见 TODO。
