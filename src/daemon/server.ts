import http from "node:http";
import net from "node:net";
import { URL } from "node:url";

import { StorageManager } from "../storage/index.js";
import { SqliteMeetingStore } from "../storage/sqlite-meeting.js";
import { GlobalMessageStore } from "../storage/global-messages.js";
import { EventStore } from "../storage/events.js";
import { runMigrations } from "../storage/migrations.js";
import { createTask, updateTask, getTask, listTasks, cancelTask } from "../storage/tasks.js";
import { DiscussionMessage } from "../types.js";
import { MAX_BODY_BYTES } from "../constants.js";
import { TOOL_DEFINITIONS, ToolArgs, ToolName, isToolName, parseToolArgs, taskUpdateSchema, ToolValidationError } from "./tools.js";
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
// Per-instance session context (in-memory)
// ---------------------------------------------------------------------------

type SessionCtx = { currentProject: string | null };
const sessions = new Map<string, SessionCtx>();

function getSession(instanceId: string): SessionCtx {
    if (!sessions.has(instanceId)) sessions.set(instanceId, { currentProject: null });
    return sessions.get(instanceId)!;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function toolRegisterSessionContext(args: ToolArgs<"register_session_context">, instanceId: string) {
    const manifest = await StorageManager.getProjectManifest(args.projectId);
    if (!manifest) {
        return { ok: false, message: `Project '${args.projectId}' not found in registry.` };
    }
    getSession(instanceId).currentProject = args.projectId;
    EventStore.record(instanceId, "session.register", args.projectId);
    return { ok: true, message: `Session context registered for project: ${args.projectId}.` };
}

async function toolSyncProjectAssets(args: ToolArgs<"sync_project_assets">, instanceId: string) {
    const m = { ...args.manifest, lastUpdated: args.manifest.lastUpdated ?? new Date().toISOString() };

    await StorageManager.saveProjectManifest(m);
    await StorageManager.saveProjectDocs(m.id, args.internalDocs);
    EventStore.record(instanceId, "project.sync", m.id);
    return { ok: true, projectId: m.id, message: `Project '${m.id}' manifest and docs synced.` };
}

async function toolUploadAsset(args: ToolArgs<"upload_project_asset">, instanceId: string) {
    const session = getSession(instanceId);
    if (!session.currentProject) throw new Error("No active project. Call register_session_context first.");
    const sanitized = args.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const buf = Buffer.from(args.base64Content, "base64");
    await StorageManager.saveAsset(session.currentProject, sanitized, buf);
    EventStore.record(instanceId, "project.asset", session.currentProject, { fileName: sanitized, bytes: buf.length });
    return { ok: true, message: `Asset '${sanitized}' saved to project '${session.currentProject}'.` };
}

async function toolUpdateProject(args: ToolArgs<"update_project">, instanceId: string) {

    await StorageManager.patchProjectManifest(args.projectId, args.patch);
    EventStore.record(instanceId, "project.update", args.projectId, { fields: Object.keys(args.patch) });
    return { ok: true, projectId: args.projectId, message: `Project '${args.projectId}' updated.` };
}

async function toolRenameProject(args: ToolArgs<"rename_project">, instanceId: string) {
    if (args.oldId === args.newId) throw new Error("oldId and newId are identical.");
    const exists = await StorageManager.getProjectManifest(args.oldId);
    if (!exists) throw new Error(`Project '${args.oldId}' not found.`);

    await StorageManager.renameProject(args.oldId, args.newId);
    EventStore.record(instanceId, "project.rename", args.newId, { oldId: args.oldId });
    return { ok: true, oldId: args.oldId, newId: args.newId, message: `Project renamed '${args.oldId}' → '${args.newId}'.` };
}

async function toolSearchProjects(args: ToolArgs<"search_projects">) {
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

async function toolGetGlobalTopology(args: ToolArgs<"get_global_topology">) {
    return StorageManager.calculateTopology(args.projectId);
}

async function toolSendMessage(args: ToolArgs<"send_message">, instanceId: string) {
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

async function toolReadMessages(args: ToolArgs<"read_messages">, instanceId: string) {
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

async function toolUpdateGlobalStrategy(args: ToolArgs<"update_global_strategy">, instanceId: string) {
    await StorageManager.saveGlobalBlueprint(args.content);
    EventStore.record(instanceId, "strategy.update");
    return { ok: true, message: "Global strategy updated." };
}

async function toolSyncGlobalDoc(args: ToolArgs<"sync_global_doc">, instanceId: string) {
    await StorageManager.saveGlobalDoc(args.docId, args.title, args.content, instanceId);
    EventStore.record(instanceId, "doc.sync", args.docId, { title: args.title });
    return { ok: true, message: `Global document '${args.title}' (${args.docId}) synchronized.` };
}

async function toolStartMeeting(args: ToolArgs<"start_meeting">, instanceId: string) {
    const meeting = SqliteMeetingStore.startMeeting(args.topic, instanceId);
    EventStore.record(instanceId, "meeting.start", meeting.id, { topic: meeting.topic });
    return { ok: true, meetingId: meeting.id, topic: meeting.topic, status: meeting.status };
}

async function toolEndMeeting(args: ToolArgs<"end_meeting">, instanceId: string) {
    const id = args.meetingId ?? SqliteMeetingStore.getActiveMeetingId();
    if (!id) throw new Error("No active meeting found to end.");

    const meeting = SqliteMeetingStore.endMeeting(id, args.summary, instanceId);
    EventStore.record(instanceId, "meeting.end", id, { topic: meeting.topic, summary: args.summary });
    return { ok: true, meetingId: id, status: "closed", summary: meeting.summary };
}

async function toolArchiveMeeting(args: ToolArgs<"archive_meeting">, instanceId: string) {
    const meeting = SqliteMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
    SqliteMeetingStore.archiveMeeting(args.meetingId, instanceId);
    EventStore.record(instanceId, "meeting.archive", args.meetingId);
    return { ok: true, meetingId: args.meetingId, status: "archived" };
}

async function toolReopenMeeting(args: ToolArgs<"reopen_meeting">, instanceId: string) {
    const meeting = SqliteMeetingStore.getMeeting(args.meetingId);
    if (!meeting) throw new Error(`Meeting '${args.meetingId}' not found.`);
    SqliteMeetingStore.reopenMeeting(args.meetingId, instanceId);
    EventStore.record(instanceId, "meeting.reopen", args.meetingId);
    return { ok: true, meetingId: args.meetingId, status: "active" };
}

async function toolCreateTask(args: ToolArgs<"create_task">) {
    if (args.source_meeting_id && !SqliteMeetingStore.getMeeting(args.source_meeting_id)) {
        throw new Error(`Meeting '${args.source_meeting_id}' not found.`);
    }
    const task = createTask({ source_meeting_id: args.source_meeting_id, metadata: args.metadata, ttl: args.ttl });
    return { task_id: task.id, status: task.status, message: "Task created.", task };
}

async function toolGetTask(args: ToolArgs<"get_task">) {
    const task = getTask(args.taskId);
    if (!task) throw new Error(`Task '${args.taskId}' not found.`);
    return task;
}

async function toolListTasks(args: ToolArgs<"list_tasks">) {
    const tasks = listTasks(args.status, args.limit);
    return { count: tasks.length, tasks };
}

async function toolCancelTask(args: ToolArgs<"cancel_task">) {
    const ok = cancelTask(args.taskId);
    if (!ok) throw new Error(`Task '${args.taskId}' not found or cannot be cancelled.`);
    return { ok: true, taskId: args.taskId, message: "Task cancelled." };
}

async function toolHostMaintenance(args: ToolArgs<"host_maintenance">, instanceId: string) {
    const removed = args.action === "clear"
        ? GlobalMessageStore.clear()
        : GlobalMessageStore.pruneOldest(args.count);
    EventStore.record(instanceId, `maintenance.${args.action}`, undefined, { removed });
    return { ok: true, removed, remaining: GlobalMessageStore.count(), message: `Removed ${removed} global messages.` };
}

async function toolListEvents(args: ToolArgs<"list_events">) {
    const events = EventStore.list(args.limit, args.action);
    return { count: events.length, events };
}

async function toolHostDeleteProject(args: ToolArgs<"host_delete_project">, instanceId: string) {
    const exists = await StorageManager.getProjectManifest(args.projectId);
    if (!exists) throw new Error(`Project '${args.projectId}' not found.`);

    await StorageManager.deleteProject(args.projectId);
    EventStore.record(instanceId, "project.delete", args.projectId);
    return { ok: true, projectId: args.projectId, message: `Project '${args.projectId}' deleted.` };
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchTool(name: ToolName, rawArgs: unknown, instanceId: string): Promise<unknown> {
    switch (name) {
        case "register_session_context":  return toolRegisterSessionContext(parseToolArgs(name, rawArgs), instanceId);
        case "sync_project_assets":       return toolSyncProjectAssets(parseToolArgs(name, rawArgs), instanceId);
        case "upload_project_asset":      return toolUploadAsset(parseToolArgs(name, rawArgs), instanceId);
        case "update_project":            return toolUpdateProject(parseToolArgs(name, rawArgs), instanceId);
        case "rename_project":            return toolRenameProject(parseToolArgs(name, rawArgs), instanceId);
        case "search_projects":           return toolSearchProjects(parseToolArgs(name, rawArgs));
        case "get_global_topology":       return toolGetGlobalTopology(parseToolArgs(name, rawArgs));
        case "send_message":              return toolSendMessage(parseToolArgs(name, rawArgs), instanceId);
        case "read_messages":             return toolReadMessages(parseToolArgs(name, rawArgs), instanceId);
        case "list_events":               return toolListEvents(parseToolArgs(name, rawArgs));
        case "update_global_strategy":    return toolUpdateGlobalStrategy(parseToolArgs(name, rawArgs), instanceId);
        case "sync_global_doc":           return toolSyncGlobalDoc(parseToolArgs(name, rawArgs), instanceId);
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

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
}

class HttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

/**
 * Run a tool for an HTTP request. Validation failures and handler rejections
 * are the caller's fault and surface as 400, not as daemon errors.
 */
async function callTool(name: ToolName, args: unknown, instanceId: string): Promise<unknown> {
    try {
        return await dispatchTool(name, args, instanceId);
    } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
}

function actor(body: Record<string, unknown>): string {
    return typeof body.instanceId === "string" && body.instanceId ? body.instanceId : "unknown";
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
        req.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (received === 0) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "Invalid JSON")); }
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
}): Promise<{ server: http.Server }> {
    await initializeStorage();
    const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    const allowedHosts = options.allowedHosts ?? allowedHostsFromEnv();

    const server = http.createServer(async (req, res) => {
        const method = req.method || "GET";
        const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
        const path = url.pathname;
        const parseBody = (r: http.IncomingMessage) => parseRequestBody(r, maxBodyBytes);

        try {
            const guard = rejectBrowserRequest(req, allowedHosts);
            if (guard) {
                req.resume();
                return jsonResponse(res, guard.status, { ok: false, error: guard.message });
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
                const instanceId = (body.instanceId as string) || "unknown";

                if (!toolName) return jsonResponse(res, 400, { ok: false, error: "tool is required" });
                if (!isToolName(toolName)) {
                    return jsonResponse(res, 404, { ok: false, error: `Unknown tool: '${toolName}'` });
                }
                return jsonResponse(res, 200, { ok: true, result: await callTool(toolName, args, instanceId) });
            }

            // Messages
            if (method === "POST" && path === "/api/messages/send") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("send_message", body, actor(body)));
            }

            if (method === "GET" && path === "/api/messages/unread") {
                const result = await callTool("read_messages", queryArgs(url, ["count"]), url.searchParams.get("instanceId") || "unknown");
                return jsonResponse(res, 200, result);
            }

            // Projects
            if (method === "POST" && path === "/api/projects/sync") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("sync_project_assets", { internalDocs: "", ...body }, actor(body)));
            }

            if (method === "POST" && path === "/api/projects/update") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("update_project", body, actor(body)));
            }

            if (method === "POST" && path === "/api/projects/rename") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("rename_project", body, actor(body)));
            }

            if (method === "POST" && path === "/api/projects/delete") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("host_delete_project", body, actor(body)));
            }

            if (method === "GET" && path === "/api/projects/search") {
                return jsonResponse(res, 200, await callTool("search_projects", queryArgs(url, ["limit"]), "unknown"));
            }

            if (method === "GET" && path === "/api/projects/topology") {
                return jsonResponse(res, 200, await callTool("get_global_topology", queryArgs(url, []), "unknown"));
            }

            // Session
            if (method === "POST" && path === "/api/session/register") {
                const body = await parseBody(req);
                const result = await callTool("register_session_context", body, actor(body)) as { ok: boolean };
                return jsonResponse(res, result.ok ? 200 : 404, result);
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
                    await callTool("sync_global_doc", { ...body, docId }, actor(body));
                    return jsonResponse(res, 200, { ok: true, docId });
                }
            }

            if (method === "GET" && path === "/api/global/strategy") {
                return jsonResponse(res, 200, { content: await StorageManager.getGlobalBlueprint() });
            }

            if (method === "POST" && path === "/api/global/strategy") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("update_global_strategy", body, actor(body)));
            }

            // Meetings
            if (method === "POST" && path === "/api/meetings/start") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("start_meeting", body, actor(body)));
            }

            if (method === "POST" && path === "/api/meetings/end") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("end_meeting", body, actor(body)));
            }

            if (method === "POST" && path === "/api/meetings/archive") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("archive_meeting", body, actor(body)));
            }

            if (method === "POST" && path === "/api/meetings/reopen") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("reopen_meeting", body, actor(body)));
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
                return jsonResponse(res, 200, await callTool("create_task", body, actor(body)));
            }

            if (method === "GET" && path === "/api/tasks") {
                return jsonResponse(res, 200, await callTool("list_tasks", queryArgs(url, ["limit"]), "unknown"));
            }

            const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/(.+))?$/);
            if (taskMatch) {
                const taskId = decodeURIComponent(taskMatch[1]);
                const action = taskMatch[3];

                if (method === "GET" && !action) {
                    return jsonResponse(res, 200, await callTool("get_task", { taskId }, "unknown"));
                }
                if (method === "POST" && action === "update") {
                    const body = await parseBody(req);
                    const update = taskUpdateSchema.safeParse(body);
                    if (!update.success) return jsonResponse(res, 400, { ok: false, error: `Invalid task update:\n${z.prettifyError(update.error)}` });
                    if (!getTask(taskId)) return jsonResponse(res, 404, { ok: false, error: `Task '${taskId}' not found.` });
                    return jsonResponse(res, 200, { ok: true, task: updateTask(taskId, update.data) });
                }
                if (method === "POST" && action === "cancel") {
                    return jsonResponse(res, 200, await callTool("cancel_task", { taskId }, "unknown"));
                }
            }

            // Maintenance
            if (method === "POST" && path === "/api/maintenance/logs") {
                const body = await parseBody(req);
                return jsonResponse(res, 200, await callTool("host_maintenance", body, actor(body)));
            }

            // Events
            if (method === "GET" && path === "/api/events") {
                return jsonResponse(res, 200, await callTool("list_events", queryArgs(url, ["limit"]), "unknown"));
            }

            jsonResponse(res, 404, { ok: false, error: "Not found" });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (e instanceof HttpError) {
                return jsonResponse(res, e.status, { ok: false, error: message });
            }
            if (e instanceof ToolValidationError || e instanceof z.ZodError) {
                return jsonResponse(res, 400, { ok: false, error: e instanceof z.ZodError ? z.prettifyError(e) : message });
            }
            console.error("[n2n-nexus daemon] Error:", message);
            jsonResponse(res, 500, { ok: false, error: message });
        }
    });

    return { server };
}
