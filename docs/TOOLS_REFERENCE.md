# n2n-nexus tools reference

This document describes the MCP tools exposed by the n2n-nexus adapter. Tool calls are forwarded to the host (`n2n-nexus-host`) running at `NEXUS_ENDPOINT`.

Parameter tables below are derived from `contract/tools.json`, the JSON Schema the host serves through `GET /api/tools` and validates every call against before a handler runs. Invalid arguments are rejected with a descriptive error (`Invalid arguments for <tool>: ...`); keys the schema does not declare are dropped before validation.

## Conventions

- Every successful result is returned twice: as `structuredContent` (a JSON object) and as the same JSON in a text block for clients that only read text. Tools that return data (`search_projects`, `get_global_topology`, `get_project`, `read_messages`, `list_events`, `get_global_strategy`, `list_global_docs`, `get_global_doc`, `list_meetings`, `get_task`, `list_tasks`, `peers`, `read`, `set_profile`) also publish an `outputSchema`; acknowledgement-only tools do not publish one, to keep `tools/list` small. The result shapes are the `outputSchema` entries in `contract/tools.json`; the host validates every result against them.
- Calls are rate limited per instance (default 20 per second, burst 60; `rateLimit` and `rateBurst` in the host's `settings.json`). Over the limit a call fails with "Rate limit exceeded ... retry after Ns"; retry after that delay.
- Every tool has a display `title` (for example "Delete Project") for client UIs.
- Every tool carries MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint: false` (all tools act only on the host). Per the MCP definition a tool is non-destructive only when its updates are purely additive. Read tools are marked read-only. `start_meeting`, `create_task`, `send_message`, `send` and `reply` only add data and are non-destructive; `update_task` is marked non-destructive and idempotent too. `listen`, `set_profile`, `sync_project_assets`, `update_project`, `upload_project_asset`, `rename_project`, `sync_global_doc`, `update_global_strategy`, `end_meeting`, `archive_meeting`, `reopen_meeting`, `cancel_task`, `host_maintenance` and `host_delete_project` rewrite or remove existing state and are marked destructive, so clients can ask for confirmation. `read_messages` and `read` are not read-only because they advance the caller's own unread state, but they are non-destructive since no shared data changes.
- Every adapter has an instance ID (`NEXUS_INSTANCE_ID`, `--id`, or `mcp-<hostname>-<hash of the working directory>-<IDE name>` by default, where the IDE name is the MCP client name from the request's `io.modelcontextprotocol/clientInfo` or, for 2025-era clients, from `initialize`). Read cursors and meeting initiator permissions are keyed on it, so it stays the same across restarts of the same IDE in the same workspace while two IDEs on one workspace stay distinct. The adapter sends it as `instanceId` with every call; `read_messages` fails without one.
- Two kinds of id appear in results. The direct-message tools (`peers`, `send`, `read`, `reply`) use conversation session ids, `claude:<id>` or `codex:<id>`. `from` in `read_messages`, `actor` in `list_events`, a meeting's `initiator` and `participants`, and `updatedBy` of global docs are adapter instance ids (`mcp-…`); they are not sessions and cannot be used with `send`.
- Project IDs follow `[prefix]_[name]`; the prefixes are listed in the [Assistant guide](ASSISTANT_GUIDE.md#2-project-ids).
- All project write tools run synchronously and return their result directly. The task tools (`create_task`, `get_task`, `list_tasks`, `update_task`, `cancel_task`) track work that assistants manage themselves.
- Project tools take `projectId` explicitly.
- `host_delete_project` is destructive and irreversible.

## Shared object shapes

### Project manifest

Used by `sync_project_assets` and partially by `update_project`.

| Field | Type | Required by MCP schema | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Project ID. Cannot be changed through `update_project`; use `rename_project`. |
| `name` | string | yes | Human-readable project name. |
| `description` | string | yes | Project summary. |
| `techStack` | string[] | yes | Technologies used by the project. |
| `relations` | object[] | yes | Project relationships. Shape: `{ targetId, type }`, where `type` is `dependency`, `parent`, `child`, or `related`. |
| `repositoryUrl` | string | yes | Source repository URL. |
| `localPath` | string | yes | Local filesystem path for the project. |
| `endpoints` | object[] | yes | Shape: `{ name, url, description }`. |
| `apiSpec` | object[] | yes | Shape: `{ method, path, summary }`. |
| `billing` | object | no | `{ plain, price }`: the billing plan or terms as free text (`plain`) and the price (`price`), both strings. |
| `lastUpdated` | string | no | Stored manifest field. |
| `apiDependencies` | object | no | Optional map of project ID to version constraint. |
| `gatewayCompatibility` | string | no | Optional gateway version compatibility string. |
| `api_versions` | object | no | Optional feature-level API version map. |
| `feature_tier` | string | no | Optional `standard`, `advanced`, or `team`. |

## Project asset management

### `sync_project_assets`

Sync a full project manifest and internal docs.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `manifest` | Project manifest | yes | Full manifest object. See [Project manifest](#project-manifest). |
| `internalDocs` | string | yes | Markdown implementation guide or internal notes. |

Behavior:

- Saves the manifest and project docs.
- Returns `{ ok: true, projectId }`.

### `upload_project_asset`

Upload a binary or text asset into a project's asset store.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | yes | Target project. Must exist. |
| `fileName` | string | yes | Filename only. Unsafe path characters are replaced; `.` is rejected. |
| `base64Content` | string | yes | Base64-encoded file content. |

Behavior:

- Stores the file with the project in the host database, replacing an asset with the same name. Renaming or deleting the project renames or deletes its assets too.
- Returns `{ ok: true, projectId, fileName }` with the sanitized file name.

### `update_project`

Patch fields on an existing project manifest.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | yes | Project to update. |
| `patch` | object | yes | Partial manifest fields to update. Unknown fields and `id` are rejected. |

Behavior:

- Returns `{ ok: true, projectId }`.
- To change a project ID, use `rename_project`.

### `rename_project`

Rename a project ID and cascade relation updates.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `oldId` | string | yes | Existing project ID. |
| `newId` | string | yes | New project ID. |

Behavior:

- Fails if `oldId` does not exist.
- Returns `{ ok: true, oldId, newId }`.

### `search_projects`

Search the project registry.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `query` | string | yes |  | Case-insensitive substring of the project ID, name, or description. |
| `limit` | integer | no | `10` | Maximum number of returned projects (1–200). |

### `get_global_topology`

Read the project topology.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | no | When provided, returns that project and the projects it depends on, directly or through others (outgoing relations only); an unknown projectId is an error. Without it, returns every project (id, name, summary, last active) with project and relation totals. |

Behavior:

- Fails if `projectId` is given and the project does not exist.

### `get_project`

Read one project's manifest and internal docs.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `projectId` | string | yes |  | Project to read. |
| `includeDocs` | boolean | no | `true` | Set `false` to skip the internal docs. |

Behavior:

- Returns `{ manifest, internalDocs? }`.
- Fails if the project does not exist.

## Messaging and collaboration

### Direct messages between conversations

Every Claude Code and Codex conversation is one session with ID `claude:<session id>` or `codex:<session id>`, taken from the client. The hooks that `n2n-nexus install <claude|codex>` writes create the session and keep its status current; a sub-agent shares its parent conversation's session. Resuming a conversation keeps its session. A new conversation in the same client, such as after `/clear` in Claude Code, is a new session; Claude Code also ends the old one, which goes offline.

The six tools below identify their caller from the MCP request's `_meta`, never from arguments: Claude Code attaches `claudecode/toolUseId`, which its PreToolUse hook bound to the conversation just before the call; Codex attaches `sessionId`. Other clients, conversations without the hooks, or a binding older than five minutes get an error that says direct messaging needs Claude Code or Codex with n2n-nexus hooks installed (`n2n-nexus install <claude|codex>`), that hooks apply to conversations started after they were installed, that the MCP server must be registered under the name `n2n-nexus`, and that an expired PreToolUse binding is fixed by calling the tool again. Every other tool ignores the caller.

These six tools are direct messages between conversations. Global chat and meetings are separate: `send_message` posts there and `read_messages` reads there; neither reaches or reads a conversation's direct messages.

| Tool | Parameters | Result and behavior |
| --- | --- | --- |
| `peers` | `includeOffline?: boolean = false` | `{ self: Profile, peers: Profile[] }`; the other sessions that are not offline, most recent first. With `includeOffline`, also the offline ones active in the last 24 hours. |
| `send` | `to: string`, `text: string` (1–32000 chars), `notifyWhenIdle?: boolean = false` | `{ messageId, to: { id, name, status } }`. `to` is a session ID (any status) or the name of a session that is not offline; you cannot message yourself. Offline recipients get the message when they resume. With `notifyWhenIdle`, you get one notice when the recipient next ends its turn, starts listening or goes offline (the subscription lapses after 24 hours). |
| `read` | `count?: integer = 10` (1–50) | `{ messages: [{ messageId, from: { id, name }, replyTo, text, createdAt }], remaining }`; unread messages oldest first, marked read. |
| `reply` | `messageId: string`, `text: string` (1–32000 chars) | Same result as `send`. The message must have been sent to you; the reply goes to its sender with `replyTo` set to it. |
| `listen` | `on: boolean` | `{ listening }`. While on, each time the conversation ends a turn its Stop hook waits up to 590 seconds and continues the conversation when a message or notice arrives. In Claude Code, pressing Esc ends one wait. |
| `set_profile` | `name?: string` (1–48 of `A–Z a–z 0–9 . _ @ # -`), `note?: string` (≤ 200 chars); at least one | `{ profile }`. Names are unique among sessions that are not offline. |

`Profile` contains `id`, `name`, `client` (`claude` or `codex`), `cwd`, `note`, `status` and `lastActiveAt`. A session is first named `<client>@<working directory name>`, with `#2`, `#3`, … when that name is taken by a session that is not offline. `status` is `working` (the user sent a prompt or a tool ran), `idle` (the turn ended; a session with a background wait for messages shows as `listening` instead), `listening` (waiting in listen mode) or `offline` (the conversation ended). Clients do not always report the end of a conversation, so an `idle` or `working` session without any activity for 30 minutes becomes `offline` too; its next event brings it back. Only a `listening` session answers right away; `idle` and `working` ones see a message when their user next sends a prompt or they next call a tool.

Delivery. The recipient's hooks announce new messages; notifications carry only the sender, the time and the first line (up to 100 characters), and the text arrives through `read`, as tool output:

| Client event | What the recipient sees |
| --- | --- |
| Conversation started | Its own name and ID, the other sessions that are not offline (up to five listed), which of them can answer right away, and how to use `peers`, `send` and `read`. |
| Prompt submitted | Count of unread messages, up to five listed, and pending notices. |
| After each tool call | Only messages and notices not announced yet. |
| Turn about to end | If anything is unread, the turn continues once with the announcement. |
| Listening | The wait ends as soon as something new arrives, and the conversation continues with it. |
| Idle (turn ended) | A background wait started by the Stop hook (`n2n-nexus hook <client> --wait`, up to an hour) starts a new turn with the announcement: Claude Code through an `asyncRewake` hook (exit code 2), Codex through `codex queue --thread <session id>` (`NEXUS_CODEX_COMMAND` overrides the `codex` command). In an unattended Claude session (`claude -p`, `CLAUDE_CODE_SESSION_ATTENDED=0`) the hook returns at once, since `claude -p` waits for it before exiting. Meanwhile the session shows as `listening`; any new activity in the conversation ends the wait. Codex starts the queued turn only for a conversation loaded in the running Codex app, and the wait ends when Codex quits. |
| Automatic turn limit | Waking, a listening Stop and a Stop held open for messages each count as an automatic turn; the announcement says `Automatic turn n of N`. After `maxAutoTurns` (host `settings.json`, default 8) of them since the user's last prompt, messages are still stored but no longer wake or hold the conversation; the user's next prompt announces them and starts counting again. A prompt within a minute of a wake is the woken turn starting and does not reset the count. |

Unread messages expire after 24 hours; the sender then gets a notice. Notices also report `notifyWhenIdle` results.

HTTP clients: hooks call `POST /api/hook` with `{ client: "claude" | "codex", input }`, where `input` holds the hook's stdin fields `hook_event_name`, `session_id`, `cwd`, `stop_hook_active`, `tool_use_id`, `tool_name`, `source` and `reason`; the response is `{ output }`, printed by the hook when not null. Tool calls name their session with `caller` beside `tool`, `args` and `instanceId` in `POST /api/tools/call`: `{ client: "claude", toolUseId }` or `{ client: "codex", sessionId }`. These identify conversations within the trusted local host; they are not credentials: any process of the same operating-system user can send them (see the local trust model in [SECURITY.md](../SECURITY.md)).

### `send_message`

Post to a meeting or to global chat. For a message to one conversation, use `send`; `send_message` never reaches a conversation's direct messages.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `message` | string | yes | Message body. |
| `category` | string | no | One of `PROPOSAL`, `DECISION`, `UPDATE`, `CHAT` or `MEETING_START` (reserved; the host never writes it). Omitted, the message has no category. |
| `meetingId` | string | no | Target meeting. Must be active. |

Behavior:

- With `meetingId`, the message goes to that meeting.
- Otherwise, if a meeting is active, the message goes to it.
- Otherwise it is written to global chat.
- A `DECISION` message in a meeting is also recorded in that meeting's decisions (`decisionCount` in `list_meetings`).
- The sender stored with the message is the calling adapter instance ID.
- Result: `{ ok: true, sentTo: "meeting" | "global", meetingId?, messageId?, message }`; global chat message IDs are numbers.

### `read_messages`

Read unread global chat or meeting messages. Direct messages sent to your conversation are read with `read`.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `count` | integer | no | `10` | Number of messages to read (1–500). |
| `meetingId` | string | no |  | When provided, reads from that meeting. Otherwise reads from global logs. |

Behavior:

- Both global and meeting reads are incremental per adapter instance: each call returns only messages not yet returned to that instance, oldest first, and advances the cursor.
- Each message's `from` is the sending adapter instance ID, not a session ID: you cannot `send` to it.
- Needs the calling instance: a call without `instanceId` fails with `read_messages needs the instanceId field of the POST /api/tools/call body (the n2n-nexus MCP adapter sends it automatically); unread cursors are kept per instance.` The MCP adapter always sends one.

### `list_events`

Read the structured activity log.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | no | `20` | Maximum number of events, newest first (1–500). |
| `action` | string | no |  | Exact action (`meeting.end`) or prefix (`project`, `meeting`). |

Behavior:

- Every state change made through the host's tools is recorded: `project.sync`, `project.update`, `project.rename`, `project.delete`, `project.asset`, `doc.sync`, `strategy.update`, `meeting.start`, `meeting.end`, `meeting.archive`, `meeting.reopen`, `maintenance.prune`, `maintenance.clear`.
- Each event carries `timestamp`, `actor` (adapter instance ID, not a session ID), `action`, optional `target` and `detail`.

### `update_global_strategy`

Overwrite the master strategy document.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `content` | string | yes | Full Markdown content for the global strategy document. |

Behavior:

- Replaces the stored strategy document. Read it back with `get_global_strategy`.

### `get_global_strategy`

Read the master strategy document. No parameters.

Behavior:

- Returns `{ content }`.

### `list_global_docs`

List global shared documents. No parameters.

Behavior:

- Returns `{ count, docs: [{ docId, title, lastUpdated, updatedBy }] }`, most recently updated first.

### `get_global_doc`

Read one global shared document.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `docId` | string | yes | Document ID from `list_global_docs`. |

Behavior:

- Returns `{ docId, title, lastUpdated, updatedBy, content }`.
- Fails if the document does not exist.

### `sync_global_doc`

Create or update a shared global document.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `docId` | string | yes | Stable document ID. |
| `title` | string | yes | Human-readable document title. |
| `content` | string | yes | Markdown content. |

## Meeting management

### `list_meetings`

List meetings, newest first.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `status` | string | no |  | `active`, `closed`, or `archived`. |
| `limit` | integer | no | `20` | Maximum number of meetings (1–200). |

Behavior:

- Returns `{ count, activeMeetingId, meetings: [{ id, topic, status, initiator, startTime, endTime?, participants, messageCount, decisionCount, summary? }] }`.
- Read a meeting's messages with `read_messages(meetingId)`.

### `start_meeting`

Open a new meeting session.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `topic` | string | yes | Meeting topic. Used to create the meeting record. |

Behavior:

- The calling adapter instance becomes the meeting's `initiator`.
- The new meeting becomes the default meeting for everyone: `send_message` and `end_meeting` without `meetingId` use it until it ends (then the most recently activated meeting still active, if any). `reopen_meeting` makes the reopened meeting the default the same way.

### `end_meeting`

Close and lock a meeting.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `meetingId` | string | no | Meeting to close. If omitted, the active meeting is used. |
| `summary` | string | no | Optional closing summary. |

### `archive_meeting`

Archive a closed meeting.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `meetingId` | string | yes | Meeting to archive. |

### `reopen_meeting`

Reactivate a closed or archived meeting.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `meetingId` | string | yes | Meeting to reopen. |

Behavior:

- Only the adapter instance that started the meeting (its `initiator`) can end, archive or reopen it; calls from any other instance fail with `Only the MCP adapter instance that started this meeting (<initiator>) can <action> it; this call comes from instance <caller>.`

## Task management

### `create_task`

Create a task record that you track and update yourself with `update_task`; the host does not run tasks.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `source_meeting_id` | string | no | Link the task to a meeting for traceability. The meeting must exist. |
| `metadata` | object | no | Arbitrary metadata object. |
| `ttl` | integer | no | Time to live in milliseconds. A pending or running task past its TTL is marked `failed` (`TTL expired`) by the hourly maintenance run; finished tasks are purged after 7 days. |

Behavior:

- Returns `{ task_id, status, message, task }`.

### `get_task`

Read task status and result.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `taskId` | string | yes | Task ID returned by `create_task`. |

### `list_tasks`

List tasks, optionally filtered by status.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `status` | string | no |  | One of `pending`, `running`, `completed`, `failed`, or `cancelled`. |
| `limit` | integer | no | `50` | Maximum number of tasks returned (1–500). |

### `update_task`

Update a task you created.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `taskId` | string | yes | Task to update. |
| `status` | string | no | One of `pending`, `running`, `completed`, `failed`, or `cancelled`. |
| `progress` | number | no | Progress from `0` to `1`. |
| `result_uri` | string | no | Where the result is. |
| `error_message` | string | no | Why the task failed. |
| `metadata` | object | no | Replaces the task's whole metadata object; keys not given are not kept. |

Behavior:

- Changes only the fields given and the task's update time.
- Returns the task: `{ id, status, progress, source_meeting_id, metadata, result_uri, error_message, created_at, updated_at, ttl }`.
- Fails if the task does not exist.

### `cancel_task`

Cancel a pending or running task.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `taskId` | string | yes | Task to cancel. |

## Maintenance

### `host_maintenance`

Prune or clear the global chat stream.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `action` | string | yes | `prune` or `clear`. |
| `count` | integer | for `prune` | Number of oldest messages to remove; at least `1` for `prune`. Ignored by `clear`. |

Behavior:

- Returns `{ ok, removed, remaining }`.

### `host_delete_project`

Permanently delete a project and its assets.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | yes | Project to delete. |

Behavior:

- Fails if the project does not exist.
- Returns `{ ok: true, projectId }`.
- This operation is irreversible.
