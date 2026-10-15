# n2n-nexus tools reference

This document describes the MCP tools exposed by the n2n-nexus adapter. Tool calls are forwarded to the daemon running at `NEXUS_ENDPOINT`.

Parameter tables below are derived from the zod contracts in `src/daemon/tools.ts`, which generate the JSON Schema served by `GET /api/tools` and validate every call (tool and REST) before a handler runs. Invalid arguments are rejected with a descriptive error (`Invalid arguments for <tool>: ...`); unknown top-level keys are ignored.

## Conventions

- Every tool carries MCP annotations: `readOnlyHint`, `destructiveHint` (may overwrite or delete existing data), `idempotentHint` and `openWorldHint: false` (all tools act only on the local daemon). Read tools are marked read-only; `sync_project_assets`, `update_project`, `upload_project_asset`, `sync_global_doc`, `update_global_strategy`, `host_maintenance` and `host_delete_project` are marked destructive, so clients can ask for confirmation. `read_messages` is not read-only because it advances the unread cursor.
- Every adapter has an instance ID (`NEXUS_INSTANCE_ID`, `--id`, or `mcp-<hostname>-<hash of the working directory>-<IDE name>` by default, where the IDE name comes from the MCP initialize handshake). Read cursors and meeting initiator permissions are keyed on it, so it stays the same across restarts of the same IDE in the same workspace while two IDEs on one workspace stay distinct.
- Project IDs should follow `[prefix]_[name]`, for example `web_example.com`, `api_user-auth`, or `mcp_nexus`.
- All project write tools run synchronously and return their result directly. The task tools (`create_task`, `get_task`, `list_tasks`, `cancel_task`) track work that assistants manage themselves.
- There is no session state: tools that act on a project take `projectId` explicitly.
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
| `relations` | object[] | yes | Project relationships. TypeScript shape is `{ targetId, type }`, where `type` is `dependency`, `parent`, `child`, or `related`. |
| `repositoryUrl` | string | yes | Source repository URL. |
| `localPath` | string | yes | Local filesystem path for the project. |
| `endpoints` | object[] | yes | TypeScript shape is `{ name, url, description }`. |
| `apiSpec` | object[] | yes | TypeScript shape is `{ method, path, summary }`. |
| `billing` | object | no | Optional TypeScript field: `{ plain, price }`. |
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
| `fileName` | string | yes | Filename only. Unsafe path characters are replaced. |
| `base64Content` | string | yes | Base64-encoded file content. |

Behavior:

- Saves to `projects/<projectId>/assets/`, replacing a file with the same name.
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
| `query` | string | yes |  | Matches project ID, name, or summary. |
| `limit` | integer | no | `10` | Maximum number of returned projects (1–200). |

### `get_global_topology`

Read the project topology.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `projectId` | string | no | When provided, returns a focused subgraph for that project. Without it, returns a global project list and stats. |

### `get_project`

Read one project's manifest and internal docs.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `projectId` | string | yes |  | Project to read. |
| `includeDocs` | boolean | no | `true` | Set `false` to skip the internal docs. |

Behavior:

- Returns `{ manifest, internalDocs? }`. Also available as `GET /api/projects/:projectId?includeDocs=false`.
- Fails if the project does not exist.

## Messaging and collaboration

### `send_message`

Post a message to a meeting or to global chat.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `message` | string | yes | Message body. |
| `category` | string | no | One of `MEETING_START`, `PROPOSAL`, `DECISION`, `UPDATE`, or `CHAT`. |
| `meetingId` | string | no | Target meeting. Must be active. |

Behavior:

- With `meetingId`, the message goes to that meeting.
- Otherwise, if a meeting is active, the message goes to it.
- Otherwise it is written to global chat.
- Returns `{ ok, sentTo: "meeting" | "global", meetingId?, messageId? }`.

### `read_messages`

Read recent or unread messages.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `count` | integer | no | `10` | Number of messages to read (1–500). |
| `meetingId` | string | no |  | When provided, reads from that meeting. Otherwise reads from global logs. |

Behavior:

- Both global and meeting reads are incremental per adapter instance: each call returns only messages not yet returned to that instance, oldest first, and advances the cursor.

### `list_events`

Read the structured activity log.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | no | `20` | Maximum number of events, newest first (1–500). |
| `action` | string | no |  | Exact action (`meeting.end`) or prefix (`project`, `meeting`). |

Behavior:

- Every state change made through the daemon is recorded: `project.sync`, `project.update`, `project.rename`, `project.delete`, `project.asset`, `doc.sync`, `strategy.update`, `meeting.start`, `meeting.end`, `meeting.archive`, `meeting.reopen`, `maintenance.prune`, `maintenance.clear`.
- Each event carries `timestamp`, `actor` (instance ID), `action`, optional `target` and `detail`.

### `update_global_strategy`

Overwrite the master strategy document.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `content` | string | yes | Full Markdown content for the global strategy document. |

Behavior:

- Writes `global/blueprint.md` under the storage root. Read it back with `get_global_strategy` or `GET /api/global/strategy`.

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
- Read a meeting's messages with `read_messages(meetingId)`. Also available as `GET /api/meetings?status=&limit=`.

### `start_meeting`

Open a new meeting session.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `topic` | string | yes | Meeting topic. Used to create the meeting record. |

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

- Only the meeting initiator can end, archive or reopen a meeting.

## Task management

### `create_task`

Create a background task.

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
| `count` | integer | no | Number of oldest messages to remove for `prune` (default `0`); ignored by `clear`. |

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
