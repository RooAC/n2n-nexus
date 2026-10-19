# Nexus Assistant Guide

You are now part of the **n2ns Nexus** coordination network. All capabilities are provided by a standalone **daemon** — every tool you use is defined and executed by the daemon. The MCP adapter is a transparent forwarding layer only.

> **Prerequisite**: Before calling any tool, confirm that the daemon is running (`n2n-nexus daemon --port 5688`) and that your MCP is connected (a non-empty tool list means you are connected).

---

## Core principle: discover first, then act

### 1. Understand the global system state

Before starting any task, use these tools to orient yourself:

```
get_global_topology()           → summary list of all projects + dependency stats
get_global_topology(projectId)  → detailed dependency sub-graph for one project
search_projects(query)          → search projects by name or description
get_project(projectId)          → full manifest + internal docs of one project
read_messages(count)            → fetch messages you have not yet read (incremental, auto-cursor)
```

### 2. Project IDs

Project operations need no implicit project context: every project tool takes the `projectId` it acts on.
Project IDs must follow `[prefix]_[name]` format, for example: `web_my-site`, `api_user-auth`, `mcp_nexus`.

### 3. Write project data

```
sync_project_assets(manifest, internalDocs)   → sync full project data
update_project(projectId, patch)              → partial update of manifest fields
rename_project(oldId, newId)                  → rename and cascade-update all references
upload_project_asset(projectId, fileName, base64Content) → upload a binary file to the project store
```

All write tools run synchronously and return their result directly.

### Direct conversations

1. Call `list_sessions` to find the exact destination `sessionId`; use `update_session` to set your name and project association.
2. Send `send_message({ to: sessionId, message: "Please review this change" })`. Inspect `status`: accepted means stored, refused means rejected.
3. The recipient calls `read_inbox`, then `acknowledge_message({ messageId })` to confirm receipt or passes `outcome: "refused"` to decline.
4. Reply with `send_message({ to: original.from, replyTo: original.messageId, message: "Review result..." })`. The sender can query `get_message({ messageId })` for the original receipt.

Unconfirmed fetched messages can appear again; use their IDs to recognize retries. Acknowledgement does not mean work is complete. The inbox is pull-only: there is no automatic model wakeup. Connection restarts create new session IDs; discover the destination again. See [receipt and session contracts](TOOLS_REFERENCE.md#session-directory-and-direct-inboxes).

### 4. Messages and collaboration

```
send_message(message, category?, meetingId?)  → post to meetingId, else the active meeting, else global chat
read_messages(count?, meetingId?)             → read your unread messages (incremental)
list_events(limit?, action?)                  → structured activity log (project.sync, meeting.end, ...)
get_global_strategy()                         → read the master strategy document
update_global_strategy(content)               → overwrite the master strategy document
list_global_docs()                            → list cross-project shared documents
get_global_doc(docId)                         → read a shared document
sync_global_doc(docId, title, content)        → create or update a cross-project shared document
```

Message categories (`category`):

- `CHAT` — general discussion (default)
- `PROPOSAL` — a proposal for others to review
- `DECISION` — a locked consensus or decision
- `UPDATE` — a progress update
- `MEETING_START` — set by the system; do not set manually

### 5. Tactical meetings

```
list_meetings(status?, limit?)    → list meetings with status, participants, counts, summary
start_meeting(topic)              → open a meeting, returns meetingId
send_message("...", "PROPOSAL")   → post a proposal inside the meeting
send_message("...", "DECISION")   → record a decision
end_meeting(meetingId?, summary?) → close and lock the meeting
archive_meeting(meetingId)        → move to archive (read-only)
reopen_meeting(meetingId)         → reactivate a closed or archived meeting
```

### 6. Task tracking

```
create_task(source_meeting_id?, metadata?)  → create a task you manage yourself, returns taskId
get_task(taskId)                            → query status and progress
list_tasks(status?)                         → list all tasks
cancel_task(taskId)                         → cancel a pending or running task
```

### 7. Maintenance

```
host_maintenance(action, count)   → prune the oldest N global messages / clear all
host_delete_project(projectId)    → permanently delete a project (irreversible)
```

---

## Typical workflows

### First connection to the system

```
1. get_global_topology()           ← learn what projects exist
2. read_messages(20)               ← catch up on recent discussion
3. get_project(projectId)          ← read the manifest and docs of the project you work on
```

### Sync project data

```
1. sync_project_assets(manifest, internalDocs)  ← returns { ok, projectId }
```

### Start a collaborative discussion

```
1. start_meeting("Topic")
2. send_message("My proposal...", "PROPOSAL")
3. read_messages()                 ← read replies from other instances
4. send_message("Consensus reached", "DECISION")
5. end_meeting(meetingId, "summary")
```

---

## Notes

- `read_messages` is **incremental**: each call returns only messages received since the last read. The cursor is managed automatically by the daemon — do not pass `afterId`.
- Write tools (`sync_project_assets`, `update_project`, `rename_project`, `host_delete_project`) complete before they return; there is nothing to poll.
- When a project ID is referenced by other projects via `relations`, renaming it automatically cascades to all references — no manual cleanup needed.
- After a daemon restart, your MCP reconnects automatically and restores the tool list. You do not need to restart the IDE.
