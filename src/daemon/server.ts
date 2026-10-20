import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { URL } from "node:url";

import { StorageManager } from "../storage/index.js";
import { SqliteMeetingStore } from "../storage/sqlite-meeting.js";
import { GlobalMessageStore } from "../storage/global-messages.js";
import { EventStore } from "../storage/events.js";
import { runMigrations } from "../storage/migrations.js";
import { createTask, updateTask, getTask, listTasks, cancelTask } from "../storage/tasks.js";
import { AgentStore, type AgentMessage, type AgentNotice, type AgentSession, messagePreview } from "../storage/agents.js";
import { DiscussionMessage } from "../types.js";
import { MAX_BODY_BYTES } from "../constants.js";
import { ADDRESS_LIMIT_FACTOR, RateLimitConfig, RateLimiter, rateLimitFromEnv } from "./rate-limit.js";
import { ResultContractError, ToolResult, finalizeResult } from "./tool-outputs.js";
import { TOOL_DEFINITIONS, ToolArgs, ToolName, isToolName, parseToolArgs, taskUpdateSchema, callerSchema, hookRequestSchema, ToolValidationError } from "./tools.js";
import {
    LISTEN_WAIT_MS, MESSAGE_TRUST_NOTE, NO_AGENT_SESSION_ERROR, NOTICE_PREFIX, NOTIFY_LIST_LIMIT,
    agentSessionId, type Caller, type HookClient
} from "./hook-contract.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Storage bootstrap
// ---------------------------------------------------------------------------

async function initializeStorage(): Promise<void> {
    await StorageManager.init();
    SqliteMeetingStore.init();
    await runMigrations();
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function toolSyncProjectAssets(args: ToolArgs<"sync_project_assets">, instanceId: string): Promise<ToolResult<"sync_project_assets">> {
    const m = { ...args.manifest, lastUpdated: args.manifest.lastUpdated ?? new Date().toISOString() };

    await StorageManager.saveProject(m, args.internalDocs);
    EventStore.record(instanceId, "project.sync", m.id);
    return { ok: true, projectId: m.id, message: `Project '${m.id}' manifest and docs synced.` };
}

async function toolUploadAsset(args: ToolArgs<"upload_project_asset">, instanceId: string): Promise<ToolResult<"upload_project_asset">> {
    if (!await StorageManager.getProjectManifest(args.projectId)) throw new Error(`Project '${args.projectId}' not found.`);
    const sanitized = args.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const buf = Buffer.from(args.base64Content, "base64");
    await StorageManager.saveAsset(args.projectId, sanitized, buf);
    EventStore.record(instanceId, "project.asset", args.projectId, { fileName: sanitized, bytes: buf.length });
    return { ok: true, projectId: args.projectId, fileName: sanitized, message: `Asset '${sanitized}' saved to project '${args.projectId}'.` };
}

async function toolUpdateProject(args: ToolArgs<"update_project">, instanceId: string): Promise<ToolResult<"update_project">> {

    await StorageManager.patchProjectManifest(args.projectId, args.patch);
    EventStore.record(instanceId, "project.update", args.projectId, { fields: Object.keys(args.patch) });
    return { ok: true, projectId: args.projectId, message: `Project '${args.projectId}' updated.` };
}

async function toolRenameProject(args: ToolArgs<"rename_project">, instanceId: string): Promise<ToolResult<"rename_project">> {
    if (args.oldId === args.newId) throw new Error("oldId and newId are identical.");
    const exists = await StorageManager.getProjectManifest(args.oldId);
    if (!exists) throw new Error(`Project '${args.oldId}' not found.`);

    await StorageManager.renameProject(args.oldId, args.newId);
    EventStore.record(instanceId, "project.rename", args.newId, { oldId: args.oldId });
    return { ok: true, oldId: args.oldId, newId: args.newId, message: `Project renamed '${args.oldId}' → '${args.newId}'.` };
}

async function toolSearchProjects(args: ToolArgs<"search_projects">): Promise<ToolResult<"search_projects">> {
    const registry = await StorageManager.listRegistry();
    const projects = registry.projects as Record<string, { name?: string; summary?: string }>;
    const q = args.query.toLowerCase();
    const limit = args.limit;

    const results = Object.entries(projects)
        .filter(([id, p]) =>
            id.toLowerCase().includes(q) ||
            (p.name && p.name.toLowerCase().includes(q)) ||
            (p.summary && p.summary.toLowerCase().includes(q))
        )
        .slice(0, limit)
        .map(([id, p]) => ({ id, name: p.name || id, description: p.summary }));

    return { query: args.query, count: results.length, results };
}

async function toolGetGlobalTopology(args: ToolArgs<"get_global_topology">): Promise<ToolResult<"get_global_topology">> {
    return StorageManager.calculateTopology(args.projectId);
}

async function toolGetProject(args: ToolArgs<"get_project">): Promise<ToolResult<"get_project">> {
    const manifest = await StorageManager.getProjectManifest(args.projectId);
    if (!manifest) throw new Error(`Project '${args.projectId}' not found.`);
    return args.includeDocs
        ? { manifest, internalDocs: await StorageManager.getProjectDocs(args.projectId) }
        : { manifest };
}

async function toolSendMessage(args: ToolArgs<"send_message">, instanceId: string): Promise<ToolResult<"send_message">> {
    const meetingId = args.meetingId ?? SqliteMeetingStore.getActiveMeetingId();

    if (meetingId) {
        const msg: DiscussionMessage = {
            from: instanceId,
            text: args.message,
            category: args.category,
            timestamp: new Date().toISOString()
        };
        SqliteMeetingStore.addMessage(meetingId, msg);
        return { ok: true, sentTo: "meeting", meetingId, message: `Message sent to meeting ${meetingId}.` };
    }

    const saved = GlobalMessageStore.addMessage(instanceId, args.message, args.category);
    return { ok: true, sentTo: "global", messageId: saved.id, message: "Message sent to global chat." };
}

async function toolReadMessages(args: ToolArgs<"read_messages">, instanceId: string): Promise<ToolResult<"read_messages">> {
    const count = args.count;

    if (args.meetingId) {
        const meeting = SqliteMeetingStore.getMeeting(args.meetingId);
        if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
        const messages = SqliteMeetingStore.getRecentMessages(count, args.meetingId, instanceId);
        return { source: "meeting", meetingId: args.meetingId, messages, count: messages.length };
    }

    const messages = GlobalMessageStore.readUnread(instanceId, count);
    return { source: "global", messages, count: messages.length };
}

async function toolUpdateGlobalStrategy(args: ToolArgs<"update_global_strategy">, instanceId: string): Promise<ToolResult<"update_global_strategy">> {
    await StorageManager.saveGlobalBlueprint(args.content);
    EventStore.record(instanceId, "strategy.update");
    return { ok: true, message: "Global strategy updated." };
}

async function toolGetGlobalStrategy(): Promise<ToolResult<"get_global_strategy">> {
    return { content: await StorageManager.getGlobalBlueprint() };
}

async function toolListGlobalDocs(): Promise<ToolResult<"list_global_docs">> {
    const index = await StorageManager.listGlobalDocs();
    const docs = Object.entries(index)
        .map(([docId, entry]) => ({ docId, ...entry }))
        .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    return { count: docs.length, docs };
}

async function toolGetGlobalDoc(args: ToolArgs<"get_global_doc">): Promise<ToolResult<"get_global_doc">> {
    const entry = (await StorageManager.listGlobalDocs())[args.docId];
    if (!entry) throw new Error(`Document '${args.docId}' not found.`);
    return { docId: args.docId, ...entry, content: await StorageManager.getGlobalDoc(args.docId) };
}

async function toolSyncGlobalDoc(args: ToolArgs<"sync_global_doc">, instanceId: string): Promise<ToolResult<"sync_global_doc">> {
    await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, instanceId);
    EventStore.record(instanceId, "doc.sync", args.docId, { title: args.title });
    return { ok: true, message: `Global document '${args.title}' (${args.docId}) synchronized.` };
}

async function toolListMeetings(args: ToolArgs<"list_meetings">): Promise<ToolResult<"list_meetings">> {
    const meetings = SqliteMeetingStore.listMeetings(args.status, args.limit);
    return { count: meetings.length, activeMeetingId: SqliteMeetingStore.getActiveMeetingId(), meetings };
}

async function toolStartMeeting(args: ToolArgs<"start_meeting">, instanceId: string): Promise<ToolResult<"start_meeting">> {
    const meeting = SqliteMeetingStore.startMeeting(args.topic, instanceId);
    EventStore.record(instanceId, "meeting.start", meeting.id, { topic: meeting.topic });
    return { ok: true, meetingId: meeting.id, topic: meeting.topic, status: meeting.status };
}

async function toolEndMeeting(args: ToolArgs<"end_meeting">, instanceId: string): Promise<ToolResult<"end_meeting">> {
    const id = args.meetingId ?? SqliteMeetingStore.getActiveMeetingId();
    if (!id) throw new Error("No active meeting found to end.");

    const meeting = SqliteMeetingStore.endMeeting(id, args.summary, instanceId);
    EventStore.record(instanceId, "meeting.end", id, { topic: meeting.topic, summary: args.summary });
    return { ok: true, meetingId: id, status: "closed", summary: meeting.summary };
}

async function toolArchiveMeeting(args: ToolArgs<"archive_meeting">, instanceId: string): Promise<ToolResult<"archive_meeting">> {
    const meeting = SqliteMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
    SqliteMeetingStore.archiveMeeting(args.meetingId, instanceId);
    EventStore.record(instanceId, "meeting.archive", args.meetingId);
    return { ok: true, meetingId: args.meetingId, status: "archived" };
}

async function toolReopenMeeting(args: ToolArgs<"reopen_meeting">, instanceId: string): Promise<ToolResult<"reopen_meeting">> {
    const meeting = SqliteMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
    SqliteMeetingStore.reopenMeeting(args.meetingId, instanceId);
    EventStore.record(instanceId, "meeting.reopen", args.meetingId);
    return { ok: true, meetingId: args.meetingId, status: "active" };
}

async function toolCreateTask(args: ToolArgs<"create_task">): Promise<ToolResult<"create_task">> {
    if (args.source_meeting_id && !SqliteMeetingStore.getMeeting(args.source_meeting_id)) {
        throw new Error(`Meeting '${args.source_meeting_id}' not found.`);
    }
    const task = createTask({ source_meeting_id: args.source_meeting_id, metadata: args.metadata, ttl: args.ttl });
    return { task_id: task.id, status: task.status, message: "Task created.", task };
}

async function toolGetTask(args: ToolArgs<"get_task">): Promise<ToolResult<"get_task">> {
    const task = getTask(args.taskId);
    if (!task) throw new Error(`Task '${args.taskId}' not found.`);
    return task;
}

async function toolListTasks(args: ToolArgs<"list_tasks">): Promise<ToolResult<"list_tasks">> {
    const tasks = listTasks(args.status, args.limit);
    return { count: tasks.length, tasks };
}

async function toolCancelTask(args: ToolArgs<"cancel_task">): Promise<ToolResult<"cancel_task">> {
    const ok = cancelTask(args.taskId);
    if (!ok) throw new Error(`Task '${args.taskId}' not found or cannot be cancelled.`);
    return { ok: true, taskId: args.taskId, message: "Task cancelled." };
}

async function toolHostMaintenance(args: ToolArgs<"host_maintenance">, instanceId: string): Promise<ToolResult<"host_maintenance">> {
    const removed = args.action === "clear"
        ? GlobalMessageStore.clear()
        : GlobalMessageStore.pruneOldest(args.count);
    EventStore.record(instanceId, `maintenance.${args.action}`, undefined, { removed });
    return { ok: true, removed, remaining: GlobalMessageStore.count(), message: `Removed ${removed} global messages.` };
}

async function toolListEvents(args: ToolArgs<"list_events">): Promise<ToolResult<"list_events">> {
    const events = EventStore.list(args.limit, args.action);
    return { count: events.length, events };
}

async function toolHostDeleteProject(args: ToolArgs<"host_delete_project">, instanceId: string): Promise<ToolResult<"host_delete_project">> {
    const exists = await StorageManager.getProjectManifest(args.projectId);
    if (!exists) throw new Error(`Project '${args.projectId}' not found.`);

    await StorageManager.deleteProject(args.projectId);
    EventStore.record(instanceId, "project.delete", args.projectId);
    return { ok: true, projectId: args.projectId, message: `Project '${args.projectId}' deleted.` };
}

// ---------------------------------------------------------------------------
// Agent sessions: direct-message tools
// ---------------------------------------------------------------------------

/** Wakes a Stop hook waiting in listen mode; the event name is the session id. */
const agentWake = new EventEmitter();
agentWake.setMaxListeners(0);

function wake(sessionIds: string[]): void {
    for (const id of sessionIds) agentWake.emit(id);
}

/** Expire overdue messages and wake the senders that got a notice. */
function expireMessages(now: number): void {
    wake(AgentStore.expireMessages(now));
}

function profileOf(s: AgentSession): ToolResult<"peers">["self"] {
    return { id: s.id, name: s.name, client: s.client, cwd: s.cwd, note: s.note, status: s.status, lastActiveAt: s.lastActiveAt };
}

/**
 * The agent session behind a direct-message tool call: Claude through the
 * toolUseId its PreToolUse hook bound, Codex through its session id.
 */
function resolveAgent(caller: Caller | undefined): AgentSession {
    const now = Date.now();
    let id: string | null = null;
    if (caller?.client === "claude") id = AgentStore.resolveToolUse(caller.toolUseId, now);
    else if (caller?.client === "codex") id = agentSessionId("codex", caller.sessionId);
    if (!id || !AgentStore.get(id)) throw new Error(NO_AGENT_SESSION_ERROR);
    AgentStore.refresh(id, now);
    expireMessages(now);
    return AgentStore.get(id)!;
}

function deliver(from: AgentSession, to: AgentSession, text: string, replyTo: string | null, notifyWhenIdle: boolean): ToolResult<"send"> {
    if (to.id === from.id) throw new Error("You cannot send a message to yourself.");
    const messageId = AgentStore.addMessage(from.id, to.id, text, replyTo);
    if (notifyWhenIdle) AgentStore.subscribeIdle(from.id, to.id);
    wake([to.id]);
    return { messageId, to: { id: to.id, name: to.name, status: to.status } };
}

async function toolPeers(caller: Caller | undefined): Promise<ToolResult<"peers">> {
    const self = resolveAgent(caller);
    return { self: profileOf(self), peers: AgentStore.listPeers(self.id).map(profileOf) };
}

async function toolSend(args: ToolArgs<"send">, caller: Caller | undefined): Promise<ToolResult<"send">> {
    const self = resolveAgent(caller);
    const to = AgentStore.findRecipient(args.to);
    if (!to) throw new Error(`Unknown recipient '${args.to}'. Call peers for session ids and names.`);
    return deliver(self, to, args.text, null, args.notifyWhenIdle);
}

async function toolReply(args: ToolArgs<"reply">, caller: Caller | undefined): Promise<ToolResult<"reply">> {
    const self = resolveAgent(caller);
    const original = AgentStore.getMessage(args.messageId);
    if (!original || original.toId !== self.id) throw new Error(`Message '${args.messageId}' was not sent to you.`);
    return deliver(self, AgentStore.get(original.fromId)!, args.text, original.id, false);
}

async function toolRead(args: ToolArgs<"read">, caller: Caller | undefined): Promise<ToolResult<"read">> {
    const self = resolveAgent(caller);
    const { messages, remaining } = AgentStore.readUnread(self.id, args.count);
    return {
        messages: messages.map(m => ({
            messageId: m.id, from: { id: m.fromId, name: m.fromName }, replyTo: m.replyTo, text: m.text, createdAt: m.createdAt
        })),
        remaining
    };
}

async function toolListen(args: ToolArgs<"listen">, caller: Caller | undefined): Promise<ToolResult<"listen">> {
    const self = resolveAgent(caller);
    AgentStore.setListening(self.id, args.on);
    return { listening: args.on };
}

async function toolSetProfile(args: ToolArgs<"set_profile">, caller: Caller | undefined): Promise<ToolResult<"set_profile">> {
    const self = resolveAgent(caller);
    return { profile: profileOf(AgentStore.updateProfile(self.id, args)) };
}

// ---------------------------------------------------------------------------
// Agent sessions: hooks
// ---------------------------------------------------------------------------

type HookOutput = Record<string, unknown> | null;

/** Notification text for messages and notices; marks them notified. */
function notify(messages: AgentMessage[], notices: AgentNotice[], label: "unread" | "new"): string {
    const lines: string[] = [];
    if (messages.length > 0) {
        const n = messages.length;
        lines.push(`${NOTICE_PREFIX} ${n} ${label} direct message${n === 1 ? "" : "s"}:`);
        for (const m of messages.slice(0, NOTIFY_LIST_LIMIT)) {
            lines.push(`- From ${m.fromName} (${m.fromId}) at ${m.createdAt}: ${messagePreview(m.text)}`);
        }
        if (n > NOTIFY_LIST_LIMIT) lines.push(`- ...and ${n - NOTIFY_LIST_LIMIT} more`);
    }
    if (notices.length > 0) {
        lines.push(messages.length > 0 ? "Notices:" : `${NOTICE_PREFIX} Notices:`);
        for (const notice of notices) lines.push(`- ${notice.text}`);
    }
    if (messages.length > 0) lines.push(`${MESSAGE_TRUST_NOTE} Call read to view them.`);
    AgentStore.markNotified(messages.map(m => m.id), notices.map(n => n.id));
    return lines.join("\n");
}

/** Notification for every unread message and pending notice, or null when there are none. */
function notifyAll(sessionId: string): string | null {
    const messages = AgentStore.unread(sessionId);
    const notices = AgentStore.pendingNotices(sessionId);
    return messages.length || notices.length ? notify(messages, notices, "unread") : null;
}

/** Notification for what was not notified yet, or null when nothing is new. */
function notifyFresh(sessionId: string): string | null {
    const messages = AgentStore.unread(sessionId, true);
    const notices = AgentStore.pendingNotices(sessionId);
    return messages.length || notices.length ? notify(messages, notices, "new") : null;
}

const contextOutput = (hookEventName: string, text: string | null): HookOutput =>
    text === null ? null : { hookSpecificOutput: { hookEventName, additionalContext: text } };

const blockOutput = (reason: string): HookOutput => ({ decision: "block", reason });

/**
 * Listen mode: wait until something not notified yet arrives (then block the
 * stop with it), the wait runs out, or the hook's HTTP client goes away.
 */
function waitForMessages(sessionId: string, waitMs: number, signal: AbortSignal): Promise<HookOutput> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (output: HookOutput) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            agentWake.off(sessionId, check);
            signal.removeEventListener("abort", stopWaiting);
            resolve(output);
        };
        const stopWaiting = () => {
            if (done) return;
            AgentStore.setStatusIf(sessionId, "listening", "idle");
            finish(null);
        };
        function check() {
            if (done) return;
            // SessionEnd (or listen off) during the wait: nobody will act on a block any more.
            if (!AgentStore.get(sessionId)?.listening) return finish(null);
            const text = notifyFresh(sessionId);
            if (text === null) return;
            AgentStore.setStatus(sessionId, "working");
            finish(blockOutput(text));
        }
        const timer = setTimeout(stopWaiting, waitMs);
        agentWake.on(sessionId, check);
        signal.addEventListener("abort", stopWaiting, { once: true });
        if (signal.aborted) stopWaiting();
        else check();
    });
}

async function handleStop(sessionId: string, input: Record<string, unknown>, listenWaitMs: number, signal: AbortSignal): Promise<HookOutput> {
    if (input.stop_hook_active !== true) {
        const text = notifyAll(sessionId);
        if (text !== null) {
            AgentStore.setStatus(sessionId, "working");
            return blockOutput(text);
        }
    }
    if (AgentStore.get(sessionId)!.listening) {
        AgentStore.setStatus(sessionId, "listening");
        wake(AgentStore.fireIdle(sessionId, "idle"));
        return waitForMessages(sessionId, listenWaitMs, signal);
    }
    AgentStore.setStatus(sessionId, "idle");
    wake(AgentStore.fireIdle(sessionId, "idle"));
    return null;
}

/** One client hook event (POST /api/hook). Returns what the hook prints, or null. */
async function handleHook(client: HookClient, input: Record<string, unknown>, listenWaitMs: number, signal: AbortSignal): Promise<HookOutput> {
    if (typeof input.session_id !== "string" || !input.session_id) return null;
    const id = agentSessionId(client, input.session_id);
    const now = Date.now();
    AgentStore.touch(id, client, typeof input.cwd === "string" ? input.cwd : "", now);
    expireMessages(now);

    switch (input.hook_event_name) {
        case "SessionStart":
            AgentStore.setStatus(id, "idle");
            return null;
        case "UserPromptSubmit":
            AgentStore.setStatus(id, "working");
            return contextOutput("UserPromptSubmit", notifyAll(id));
        case "PreToolUse":
            if (typeof input.tool_use_id === "string" && input.tool_use_id) AgentStore.bindToolUse(input.tool_use_id, id, now);
            return null;
        case "PostToolUse":
            AgentStore.setStatus(id, "working");
            return contextOutput("PostToolUse", notifyFresh(id));
        case "Stop":
            return handleStop(id, input, listenWaitMs, signal);
        case "SessionEnd":
            AgentStore.setStatus(id, "offline");
            AgentStore.setListening(id, false);
            wake([id, ...AgentStore.fireIdle(id, "offline")]);
            return null;
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchTool(name: ToolName, rawArgs: unknown, instanceId: string, caller?: Caller): Promise<unknown> {
    switch (name) {
        case "peers":                     parseToolArgs(name, rawArgs); return toolPeers(caller);
        case "send":                      return toolSend(parseToolArgs(name, rawArgs), caller);
        case "read":                      return toolRead(parseToolArgs(name, rawArgs), caller);
        case "reply":                     return toolReply(parseToolArgs(name, rawArgs), caller);
        case "listen":                    return toolListen(parseToolArgs(name, rawArgs), caller);
        case "set_profile":               return toolSetProfile(parseToolArgs(name, rawArgs), caller);
        case "sync_project_assets":       return toolSyncProjectAssets(parseToolArgs(name, rawArgs), instanceId);
        case "upload_project_asset":      return toolUploadAsset(parseToolArgs(name, rawArgs), instanceId);
        case "update_project":            return toolUpdateProject(parseToolArgs(name, rawArgs), instanceId);
        case "rename_project":            return toolRenameProject(parseToolArgs(name, rawArgs), instanceId);
        case "search_projects":           return toolSearchProjects(parseToolArgs(name, rawArgs));
        case "get_global_topology":       return toolGetGlobalTopology(parseToolArgs(name, rawArgs));
        case "get_project":               return toolGetProject(parseToolArgs(name, rawArgs));
        case "send_message":              return toolSendMessage(parseToolArgs(name, rawArgs), instanceId);
        case "read_messages":             return toolReadMessages(parseToolArgs(name, rawArgs), instanceId);
        case "list_events":               return toolListEvents(parseToolArgs(name, rawArgs));
        case "get_global_strategy":       parseToolArgs(name, rawArgs); return toolGetGlobalStrategy();
        case "update_global_strategy":    return toolUpdateGlobalStrategy(parseToolArgs(name, rawArgs), instanceId);
        case "list_global_docs":          parseToolArgs(name, rawArgs); return toolListGlobalDocs();
        case "get_global_doc":            return toolGetGlobalDoc(parseToolArgs(name, rawArgs));
        case "sync_global_doc":           return toolSyncGlobalDoc(parseToolArgs(name, rawArgs), instanceId);
        case "list_meetings":             return toolListMeetings(parseToolArgs(name, rawArgs));
        case "start_meeting":             return toolStartMeeting(parseToolArgs(name, rawArgs), instanceId);
        case "end_meeting":               return toolEndMeeting(parseToolArgs(name, rawArgs), instanceId);
        case "archive_meeting":           return toolArchiveMeeting(parseToolArgs(name, rawArgs), instanceId);
        case "reopen_meeting":            return toolReopenMeeting(parseToolArgs(name, rawArgs), instanceId);
        case "create_task":               return toolCreateTask(parseToolArgs(name, rawArgs));
        case "get_task":                  return toolGetTask(parseToolArgs(name, rawArgs));
        case "list_tasks":                return toolListTasks(parseToolArgs(name, rawArgs));
        case "cancel_task":               return toolCancelTask(parseToolArgs(name, rawArgs));
        case "host_maintenance":          return toolHostMaintenance(parseToolArgs(name, rawArgs), instanceId);
        case "host_delete_project":       return toolHostDeleteProject(parseToolArgs(name, rawArgs), instanceId);
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...(status === 413 ? { Connection: "close" } : {}),
        ...headers
    });
    res.end(payload);
}

class HttpError extends Error {
    constructor(public readonly status: number, message: string, public readonly headers: Record<string, string> = {}) {
        super(message);
    }
}

function rateLimited(retryAfterSec: number, scope: string): HttpError {
    return new HttpError(429, `Rate limit exceeded for ${scope}; retry after ${retryAfterSec}s.`, { "Retry-After": String(retryAfterSec) });
}

/**
 * Run a tool for an HTTP request. Validation failures and handler rejections
 * are the caller's fault and surface as 400, not as daemon errors.
 */
async function callTool(name: ToolName, args: unknown, instanceId: string, caller?: Caller): Promise<unknown> {
    try {
        return finalizeResult(name, await dispatchTool(name, args, instanceId, caller));
    } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof ResultContractError) {
            // A daemon-side defect (or unreadable stored data), not the caller's fault.
            console.error("[n2n-nexus daemon]", e.message);
            throw new HttpError(500, e.message);
        }
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
}

/** Instance id recorded for requests that do not name one. */
const UNKNOWN_INSTANCE = "unknown";

function actor(body: Record<string, unknown>): string {
    return typeof body.instanceId === "string" && body.instanceId ? body.instanceId : UNKNOWN_INSTANCE;
}

/** A malformed caller names no session: direct-message tools then refuse, every other tool ignores it. */
function callerOf(body: Record<string, unknown>): Caller | undefined {
    const parsed = callerSchema.safeParse(body.caller);
    return parsed.success ? parsed.data : undefined;
}

/** Query-string parameters as tool arguments; `numeric` names are converted to numbers. */
function queryArgs(url: URL, numeric: string[]): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) {
        if (key === "instanceId") continue;
        args[key] = numeric.includes(key) ? Number(value) : value;
    }
    return args;
}

async function parseRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
    const declared = Number(req.headers["content-length"]);
    if (declared > maxBytes) throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let tooLarge = false;
        req.on("data", (chunk: Buffer) => {
            if (tooLarge) return;
            received += chunk.length;
            if (received > maxBytes) {
                // Keep draining so the 413 can still be written; the response closes the connection.
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (tooLarge) return reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes`));
            if (received === 0) return resolve({});
            let parsed: unknown;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(new HttpError(400, "Invalid JSON")); }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return reject(new HttpError(400, "Request body must be a JSON object"));
            }
            resolve(parsed as Record<string, unknown>);
        });
        req.on("error", reject);
    });
}

/** Host names (without port) that may address the daemon besides IP literals. */
const DEFAULT_ALLOWED_HOSTS = ["localhost", "host.docker.internal"];

export function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const extra = (env.NEXUS_ALLOWED_HOSTS || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    return [...DEFAULT_ALLOWED_HOSTS, ...extra];
}

/** Hostname part of a Host header: strips the port and IPv6 brackets. */
function hostName(header: string): string {
    const m = header.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (m) return m[1].toLowerCase();
    return header.replace(/:\d+$/, "").toLowerCase();
}

/**
 * The daemon has no authentication, so it must not be callable from a web
 * page the user happens to have open. Browsers attach Origin / Sec-Fetch-*
 * headers to cross-site requests and only send JSON bodies after a CORS
 * preflight, which the daemon never grants; MCP adapters and scripts send
 * neither header and use application/json. A DNS-rebinding page reaches the
 * daemon as a same-origin request under its own host name, so the Host
 * header must be an IP literal or a known local name.
 */
function rejectBrowserRequest(req: http.IncomingMessage, allowedHosts: string[]): HttpError | null {
    const host = req.headers.host;
    if (!host) return new HttpError(400, "Host header is required");
    const name = hostName(host);
    if (!net.isIP(name) && !allowedHosts.includes(name)) {
        return new HttpError(403, `Host '${name}' is not allowed; use an IP address or add it to NEXUS_ALLOWED_HOSTS`);
    }
    if (req.headers.origin !== undefined) {
        return new HttpError(403, "Requests from browser origins are not allowed");
    }
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "none" && site !== "same-origin") {
        return new HttpError(403, "Cross-site browser requests are not allowed");
    }
    if (req.method === "POST") {
        const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json") {
            return new HttpError(415, "Content-Type must be application/json");
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export async function createDaemonServer(options: {
    port: number;
    host?: string;
    version: string;
    maxBodyBytes?: number;
    allowedHosts?: string[];
    /** Per-instance tool call limit; the per-address limit is ADDRESS_LIMIT_FACTOR times this. */
    rateLimit?: RateLimitConfig;
    /** Longest a listening session's Stop hook is held open (default LISTEN_WAIT_MS). */
    listenWaitMs?: number;
}): Promise<{ server: http.Server }> {
    await initializeStorage();
    const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    const allowedHosts = options.allowedHosts ?? allowedHostsFromEnv();
    const listenWaitMs = options.listenWaitMs ?? LISTEN_WAIT_MS;
    const limit = options.rateLimit ?? rateLimitFromEnv();
    const instanceLimiter = new RateLimiter(limit.perSecond, limit.burst);
    const addressLimiter = new RateLimiter(limit.perSecond * ADDRESS_LIMIT_FACTOR, limit.burst * ADDRESS_LIMIT_FACTOR);

    /**
     * Tool calls from HTTP routes, counted against the calling instance's budget.
     * Requests that name no instance ("unknown") are only limited per address:
     * pooling them in one shared bucket let any client exhaust it for all others.
     */
    const call = (name: ToolName, args: unknown, instanceId: string, caller?: Caller) => {
        if (instanceId !== UNKNOWN_INSTANCE) {
            const wait = instanceLimiter.take(`instance:${instanceId}`);
            if (wait) throw rateLimited(wait, `instance '${instanceId}'`);
        }
        return callTool(name, args, instanceId, caller);
    };

    const server = http.createServer(async (req, res) => {
        const method = req.method || "GET";
        const parseBody = (r: http.IncomingMessage) => parseRequestBody(r, maxBodyBytes);

        try {
            let url: URL;
            try {
                url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
            } catch {
                req.resume();
                throw new HttpError(400, "Invalid request URL or Host header");
            }
            const path = url.pathname;
            const guard = rejectBrowserRequest(req, allowedHosts);
            if (guard) {
                req.resume();
                return jsonResponse(res, guard.status, { ok: false, error: guard.message });
            }

            // Health and the tool list stay reachable so adapters can tell "busy" from "down".
            const exempt = method === "GET" && (path === "/health" || path === "/api/tools");
            if (!exempt) {
                const wait = addressLimiter.take(`address:${req.socket.remoteAddress ?? "unknown"}`);
                if (wait) {
                    req.resume();
                    const e = rateLimited(wait, "this client address");
                    return jsonResponse(res, e.status, { ok: false, error: e.message }, e.headers);
                }
            }

            // Health
            if (method === "GET" && path === "/health") {
                return jsonResponse(res, 200, { ok: true, version: options.version });
            }

            // Tool definitions
            if (method === "GET" && path === "/api/tools") {
                return jsonResponse(res, 200, { tools: TOOL_DEFINITIONS });
            }

            // Tool call dispatcher  ← core endpoint
            if (method === "POST" && path === "/api/tools/call") {
                const body = await parseBody(req);
                const toolName = body.tool as string;
                const args = (body.args || {}) as Record<string, unknown>;
                const instanceId = actor(body);

                if (!toolName) return jsonResponse(res, 400, { ok: false, error: "tool is required" });
                if (!isToolName(toolName)) {
                    return jsonResponse(res, 404, { ok: false, error: `Unknown tool: '${toolName}'` });
                }
                return jsonResponse(res, 200, { ok: true, result: await call(toolName, args, instanceId, callerOf(body)) });
            }

            // Client hook events. Hooks name no instance, so only the per-address limit above applies.
            if (method === "POST" && path === "/api/hook") {
                const body = await parseBody(req);
                const hook = hookRequestSchema.safeParse(body);
                if (!hook.success) return jsonResponse(res, 400, { ok: false, error: `Invalid hook request:\n${z.prettifyError(hook.error)}` });
                // A listening Stop hook is held open; the client killing the hook or the daemon closing ends the wait.
                const gone = new AbortController();
                res.on("close", () => { if (!res.writableEnded) gone.abort(); });
                const output = await handleHook(hook.data.client, hook.data.input, listenWaitMs, AbortSignal.any([gone.signal, closing.signal]));
                if (gone.signal.aborted) return;
                return jsonResponse(res, 200, { output }, closing.signal.aborted ? { Connection: "close" } : {});
            }

            // Messages
            if (method === "POST" && path === "/api/messages/send") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("send_message", body, actor(body)));
            }

            if (method === "GET" && path === "/api/messages/unread") {
                const result = await call("read_messages", queryArgs(url, ["count"]), url.searchParams.get("instanceId") || UNKNOWN_INSTANCE);
                return jsonResponse(res, 200, result);
            }

            // Projects
            if (method === "POST" && path === "/api/projects/sync") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("sync_project_assets", { internalDocs: "", ...body }, actor(body)));
            }

            if (method === "POST" && path === "/api/projects/update") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("update_project", body, actor(body)));
            }

            if (method === "POST" && path === "/api/projects/rename") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("rename_project", body, actor(body)));
            }

            if (method === "POST" && path === "/api/projects/delete") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("host_delete_project", body, actor(body)));
            }

            if (method === "GET" && path === "/api/projects/search") {
                return jsonResponse(res, 200, await call("search_projects", queryArgs(url, ["limit"]), UNKNOWN_INSTANCE));
            }

            const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
            if (method === "GET" && projectMatch && !["search", "topology"].includes(projectMatch[1])) {
                const includeDocs = url.searchParams.get("includeDocs") !== "false";
                return jsonResponse(res, 200, await call("get_project", { projectId: decodeURIComponent(projectMatch[1]), includeDocs }, UNKNOWN_INSTANCE));
            }

            if (method === "GET" && path === "/api/projects/topology") {
                return jsonResponse(res, 200, await call("get_global_topology", queryArgs(url, []), UNKNOWN_INSTANCE));
            }

            // Global docs
            if (method === "GET" && path === "/api/global/docs") {
                const index = await StorageManager.listGlobalDocs();
                return jsonResponse(res, 200, { docs: index });
            }

            const docMatch = path.match(/^\/api\/global\/docs\/(.+)$/);
            if (docMatch) {
                const docId = decodeURIComponent(docMatch[1]);
                if (method === "GET") {
                    const doc = await StorageManager.getGlobalDoc(docId);
                    if (!doc) return jsonResponse(res, 404, { ok: false, error: `Document '${docId}' not found.` });
                    return jsonResponse(res, 200, doc);
                }
                if (method === "POST") {
                    const body = await parseBody(req);
                    await call("sync_global_doc", { ...body, docId }, actor(body));
                    return jsonResponse(res, 200, { ok: true, docId });
                }
            }

            if (method === "GET" && path === "/api/global/strategy") {
                return jsonResponse(res, 200, { content: await StorageManager.getGlobalBlueprint() });
            }

            if (method === "POST" && path === "/api/global/strategy") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("update_global_strategy", body, actor(body)));
            }

            // Meetings
            if (method === "GET" && path === "/api/meetings") {
                return jsonResponse(res, 200, await call("list_meetings", queryArgs(url, ["limit"]), UNKNOWN_INSTANCE));
            }

            if (method === "POST" && path === "/api/meetings/start") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("start_meeting", body, actor(body)));
            }

            if (method === "POST" && path === "/api/meetings/end") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("end_meeting", body, actor(body)));
            }

            if (method === "POST" && path === "/api/meetings/archive") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("archive_meeting", body, actor(body)));
            }

            if (method === "POST" && path === "/api/meetings/reopen") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("reopen_meeting", body, actor(body)));
            }

            const meetingMatch = path.match(/^\/api\/meetings\/(.+)$/);
            if (meetingMatch && method === "GET") {
                const meetingId = decodeURIComponent(meetingMatch[1]);
                const meeting = SqliteMeetingStore.getMeeting(meetingId);
                if (!meeting) return jsonResponse(res, 404, { ok: false, error: `Meeting '${meetingId}' not found.` });
                return jsonResponse(res, 200, meeting);
            }

            // Tasks
            if (method === "POST" && path === "/api/tasks") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("create_task", body, actor(body)));
            }

            if (method === "GET" && path === "/api/tasks") {
                return jsonResponse(res, 200, await call("list_tasks", queryArgs(url, ["limit"]), UNKNOWN_INSTANCE));
            }

            const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/(.+))?$/);
            if (taskMatch) {
                const taskId = decodeURIComponent(taskMatch[1]);
                const action = taskMatch[3];

                if (method === "GET" && !action) {
                    return jsonResponse(res, 200, await call("get_task", { taskId }, UNKNOWN_INSTANCE));
                }
                if (method === "POST" && action === "update") {
                    const body = await parseBody(req);
                    const update = taskUpdateSchema.safeParse(body);
                    if (!update.success) return jsonResponse(res, 400, { ok: false, error: `Invalid task update:\n${z.prettifyError(update.error)}` });
                    if (!getTask(taskId)) return jsonResponse(res, 404, { ok: false, error: `Task '${taskId}' not found.` });
                    return jsonResponse(res, 200, { ok: true, task: updateTask(taskId, update.data) });
                }
                if (method === "POST" && action === "cancel") {
                    return jsonResponse(res, 200, await call("cancel_task", { taskId }, UNKNOWN_INSTANCE));
                }
            }

            // Maintenance
            if (method === "POST" && path === "/api/maintenance/logs") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await call("host_maintenance", body, actor(body)));
            }

            // Events
            if (method === "GET" && path === "/api/events") {
                return jsonResponse(res, 200, await call("list_events", queryArgs(url, ["limit"]), UNKNOWN_INSTANCE));
            }

            jsonResponse(res, 404, { ok: false, error: "Not found" });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (e instanceof HttpError) {
                return jsonResponse(res, e.status, { ok: false, error: message }, e.headers);
            }
            if (e instanceof ToolValidationError || e instanceof z.ZodError) {
                return jsonResponse(res, 400, { ok: false, error: e instanceof z.ZodError ? z.prettifyError(e) : message });
            }
            console.error("[n2n-nexus daemon] Error:", message);
            jsonResponse(res, 500, { ok: false, error: message });
        }
    });

    // server.close() waits for in-flight requests, and a listening Stop hook stays open
    // for minutes: release those first so a shutdown is not held up by them.
    const closing = new AbortController();
    const close = server.close.bind(server);
    server.close = (callback) => {
        closing.abort();
        return close(callback);
    };

    return { server };
}
