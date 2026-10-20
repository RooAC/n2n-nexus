import { z } from "zod";
import { MESSAGE_CATEGORIES } from "../types.js";
import { TASK_STATUSES } from "../storage/tasks.js";
import { AGENT_STATUSES, HOOK_CLIENTS } from "./hook-contract.js";

/**
 * Result contracts, one per tool. Every result passes through its contract on
 * the way out of the daemon (`finalizeResult`): undeclared fields are stripped
 * and a result that cannot satisfy the contract becomes an error instead of
 * structuredContent the client would reject. TypeScript only catches drift in
 * object literals, so this runtime pass is the real guarantee. The JSON Schema
 * is published as the tool's `outputSchema` (with additionalProperties:false,
 * which the stripping makes true). Every schema has an object root, as
 * 2025-era clients require.
 */

const ack = { ok: z.literal(true), message: z.string() };

const agentStatus = z.enum(AGENT_STATUSES);
const agentProfileSchema = z.object({
    id: z.string(), name: z.string(), client: z.enum(HOOK_CLIENTS), cwd: z.string(),
    note: z.string(), status: agentStatus, lastActiveAt: z.string()
});
const sentDirectSchema = z.object({
    messageId: z.string(),
    to: z.object({ id: z.string(), name: z.string(), status: agentStatus })
});

const messageSchema = z.object({
    id: z.number().int().optional(),
    from: z.string(),
    text: z.string(),
    category: z.enum(MESSAGE_CATEGORIES).nullish(),
    timestamp: z.string()
});

const taskSchema = z.object({
    id: z.string(),
    status: z.enum(TASK_STATUSES),
    progress: z.number(),
    source_meeting_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    result_uri: z.string().nullable(),
    error_message: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    ttl: z.number().nullable()
});

const topologyNode = z.object({ id: z.string(), name: z.string(), summary: z.string(), lastActive: z.string() });

const meetingStatus = z.enum(["active", "closed", "archived"]);

/**
 * Manifest as read back from storage. Deliberately looser than the input
 * contract: manifests written by older releases were not validated, so
 * ids and enum-like fields are plain strings here.
 */
const storedManifest = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    techStack: z.array(z.string()),
    relations: z.array(z.object({ targetId: z.string(), type: z.string() })),
    lastUpdated: z.string(),
    repositoryUrl: z.string(),
    localPath: z.string(),
    endpoints: z.array(z.object({ name: z.string(), url: z.string(), description: z.string() })),
    apiSpec: z.array(z.object({ method: z.string(), path: z.string(), summary: z.string() })),
    billing: z.object({ plain: z.string(), price: z.string() }).optional(),
    apiDependencies: z.record(z.string(), z.string()).optional(),
    gatewayCompatibility: z.string().optional(),
    api_versions: z.record(z.string(), z.string()).optional(),
    feature_tier: z.string().optional()
});

export const TOOL_OUTPUT_SCHEMAS = {
    sync_project_assets: z.object({ ...ack, projectId: z.string() }),
    upload_project_asset: z.object({ ...ack, projectId: z.string(), fileName: z.string() }),
    update_project: z.object({ ...ack, projectId: z.string() }),
    rename_project: z.object({ ...ack, oldId: z.string(), newId: z.string() }),
    search_projects: z.object({
        query: z.string(),
        count: z.number().int(),
        results: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }))
    }),
    get_global_topology: z.object({
        mode: z.enum(["list", "focused"]),
        summary: z.object({ totalProjects: z.number().int(), totalEdges: z.number().int() }).optional()
            .describe("list mode only"),
        projects: z.record(z.string(), topologyNode).optional().describe("list mode only"),
        nodes: z.array(topologyNode).optional().describe("focused mode only"),
        edges: z.array(z.object({
            from: z.string(), to: z.string(),
            type: z.string()
        })).optional().describe("focused mode only")
    }),
    get_project: z.object({
        manifest: storedManifest,
        internalDocs: z.string().optional()
    }),
    peers: z.object({ self: agentProfileSchema, peers: z.array(agentProfileSchema) }),
    send: sentDirectSchema,
    read: z.object({
        messages: z.array(z.object({
            messageId: z.string(),
            from: z.object({ id: z.string(), name: z.string() }),
            replyTo: z.string().nullable(),
            text: z.string(),
            createdAt: z.string()
        })),
        remaining: z.number().int().describe("Unread messages left after this batch")
    }),
    reply: sentDirectSchema,
    listen: z.object({ listening: z.boolean() }),
    set_profile: z.object({ profile: agentProfileSchema }),
    send_message: z.object({
        ...ack,
        sentTo: z.enum(["meeting", "global"]),
        meetingId: z.string().optional(),
        messageId: z.number().int().optional()
    }),
    read_messages: z.object({
        source: z.enum(["meeting", "global"]),
        meetingId: z.string().optional(),
        messages: z.array(messageSchema),
        count: z.number().int()
    }),
    list_events: z.object({
        count: z.number().int(),
        events: z.array(z.object({
            id: z.number().int(),
            timestamp: z.string(),
            actor: z.string(),
            action: z.string(),
            target: z.string().optional(),
            detail: z.record(z.string(), z.unknown()).optional()
        }))
    }),
    get_global_strategy: z.object({ content: z.string() }),
    update_global_strategy: z.object(ack),
    list_global_docs: z.object({
        count: z.number().int(),
        docs: z.array(z.object({ docId: z.string(), title: z.string(), lastUpdated: z.string(), updatedBy: z.string() }))
    }),
    get_global_doc: z.object({
        docId: z.string(), title: z.string(), lastUpdated: z.string(), updatedBy: z.string(), content: z.string()
    }),
    sync_global_doc: z.object(ack),
    list_meetings: z.object({
        count: z.number().int(),
        activeMeetingId: z.string().nullable(),
        meetings: z.array(z.object({
            id: z.string(),
            topic: z.string(),
            status: meetingStatus,
            initiator: z.string(),
            startTime: z.string(),
            endTime: z.string().optional(),
            participants: z.array(z.string()),
            messageCount: z.number().int(),
            decisionCount: z.number().int(),
            summary: z.string().optional()
        }))
    }),
    start_meeting: z.object({ ok: z.literal(true), meetingId: z.string(), topic: z.string(), status: meetingStatus }),
    end_meeting: z.object({ ok: z.literal(true), meetingId: z.string(), status: z.literal("closed"), summary: z.string().optional() }),
    archive_meeting: z.object({ ok: z.literal(true), meetingId: z.string(), status: z.literal("archived") }),
    reopen_meeting: z.object({ ok: z.literal(true), meetingId: z.string(), status: z.literal("active") }),
    create_task: z.object({ task_id: z.string(), status: z.enum(TASK_STATUSES), message: z.string(), task: taskSchema }),
    get_task: taskSchema,
    list_tasks: z.object({ count: z.number().int(), tasks: z.array(taskSchema) }),
    cancel_task: z.object({ ...ack, taskId: z.string() }),
    host_maintenance: z.object({ ...ack, removed: z.number().int(), remaining: z.number().int() }),
    host_delete_project: z.object({ ...ack, projectId: z.string() })
};

export type ToolResult<N extends keyof typeof TOOL_OUTPUT_SCHEMAS> = z.infer<typeof TOOL_OUTPUT_SCHEMAS[N]>;

export class ResultContractError extends Error {
    constructor(tool: string, issues: string) {
        super(`Result of ${tool} does not match its contract:\n${issues}`);
        this.name = "ResultContractError";
    }
}

/** Validate a handler result against its contract and strip undeclared fields. */
export function finalizeResult(name: keyof typeof TOOL_OUTPUT_SCHEMAS, result: unknown): unknown {
    const parsed = TOOL_OUTPUT_SCHEMAS[name].safeParse(result);
    if (!parsed.success) throw new ResultContractError(name, z.prettifyError(parsed.error));
    return parsed.data;
}
