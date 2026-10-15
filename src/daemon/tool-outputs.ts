import { z } from "zod";
import { MESSAGE_CATEGORIES } from "../types.js";
import { TASK_STATUSES } from "../storage/tasks.js";

/**
 * Result contracts, one per tool. Handlers are typed against them (so the
 * compiler catches drift), the JSON Schema is published as the tool's
 * `outputSchema`, and the MCP adapter returns the result as
 * `structuredContent`. Every schema has an object root, as 2025-era clients
 * require.
 */

const ack = { ok: z.literal(true), message: z.string() };

const messageSchema = z.strictObject({
    id: z.number().int().optional(),
    from: z.string(),
    text: z.string(),
    category: z.enum(MESSAGE_CATEGORIES).nullish(),
    timestamp: z.string()
});

const taskSchema = z.strictObject({
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

const topologyNode = z.strictObject({ id: z.string(), name: z.string(), summary: z.string(), lastActive: z.string() });

const meetingStatus = z.enum(["active", "closed", "archived"]);

/**
 * Manifest as read back from storage. Deliberately looser than the input
 * contract: manifests written by older releases were not validated, so
 * ids and enum-like fields are plain strings here.
 */
const storedManifest = z.strictObject({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    techStack: z.array(z.string()),
    relations: z.array(z.strictObject({ targetId: z.string(), type: z.string() })),
    lastUpdated: z.string(),
    repositoryUrl: z.string(),
    localPath: z.string(),
    endpoints: z.array(z.strictObject({ name: z.string(), url: z.string(), description: z.string() })),
    apiSpec: z.array(z.strictObject({ method: z.string(), path: z.string(), summary: z.string() })),
    billing: z.strictObject({ plain: z.string(), price: z.string() }).optional(),
    apiDependencies: z.record(z.string(), z.string()).optional(),
    gatewayCompatibility: z.string().optional(),
    api_versions: z.record(z.string(), z.string()).optional(),
    feature_tier: z.string().optional()
});

export const TOOL_OUTPUT_SCHEMAS = {
    sync_project_assets: z.strictObject({ ...ack, projectId: z.string() }),
    upload_project_asset: z.strictObject({ ...ack, projectId: z.string(), fileName: z.string() }),
    update_project: z.strictObject({ ...ack, projectId: z.string() }),
    rename_project: z.strictObject({ ...ack, oldId: z.string(), newId: z.string() }),
    search_projects: z.strictObject({
        query: z.string(),
        count: z.number().int(),
        results: z.array(z.strictObject({ id: z.string(), name: z.string(), description: z.string().optional() }))
    }),
    get_global_topology: z.strictObject({
        mode: z.enum(["list", "focused"]),
        summary: z.strictObject({ totalProjects: z.number().int(), totalEdges: z.number().int() }).optional()
            .describe("list mode only"),
        projects: z.record(z.string(), topologyNode).optional().describe("list mode only"),
        nodes: z.array(topologyNode).optional().describe("focused mode only"),
        edges: z.array(z.strictObject({
            from: z.string(), to: z.string(),
            type: z.string()
        })).optional().describe("focused mode only")
    }),
    get_project: z.strictObject({
        manifest: storedManifest,
        internalDocs: z.string().optional()
    }),
    send_message: z.strictObject({
        ...ack,
        sentTo: z.enum(["meeting", "global"]),
        meetingId: z.string().optional(),
        messageId: z.number().int().optional()
    }),
    read_messages: z.strictObject({
        source: z.enum(["meeting", "global"]),
        meetingId: z.string().optional(),
        messages: z.array(messageSchema),
        count: z.number().int()
    }),
    list_events: z.strictObject({
        count: z.number().int(),
        events: z.array(z.strictObject({
            id: z.number().int(),
            timestamp: z.string(),
            actor: z.string(),
            action: z.string(),
            target: z.string().optional(),
            detail: z.record(z.string(), z.unknown()).optional()
        }))
    }),
    get_global_strategy: z.strictObject({ content: z.string() }),
    update_global_strategy: z.strictObject(ack),
    list_global_docs: z.strictObject({
        count: z.number().int(),
        docs: z.array(z.strictObject({ docId: z.string(), title: z.string(), lastUpdated: z.string(), updatedBy: z.string() }))
    }),
    get_global_doc: z.strictObject({
        docId: z.string(), title: z.string(), lastUpdated: z.string(), updatedBy: z.string(), content: z.string()
    }),
    sync_global_doc: z.strictObject(ack),
    list_meetings: z.strictObject({
        count: z.number().int(),
        activeMeetingId: z.string().nullable(),
        meetings: z.array(z.strictObject({
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
    start_meeting: z.strictObject({ ok: z.literal(true), meetingId: z.string(), topic: z.string(), status: meetingStatus }),
    end_meeting: z.strictObject({ ok: z.literal(true), meetingId: z.string(), status: z.literal("closed"), summary: z.string().optional() }),
    archive_meeting: z.strictObject({ ok: z.literal(true), meetingId: z.string(), status: z.literal("archived") }),
    reopen_meeting: z.strictObject({ ok: z.literal(true), meetingId: z.string(), status: z.literal("active") }),
    create_task: z.strictObject({ task_id: z.string(), status: z.enum(TASK_STATUSES), message: z.string(), task: taskSchema }),
    get_task: taskSchema,
    list_tasks: z.strictObject({ count: z.number().int(), tasks: z.array(taskSchema) }),
    cancel_task: z.strictObject({ ...ack, taskId: z.string() }),
    host_maintenance: z.strictObject({ ...ack, removed: z.number().int(), remaining: z.number().int() }),
    host_delete_project: z.strictObject({ ...ack, projectId: z.string() })
};

export type ToolResult<N extends keyof typeof TOOL_OUTPUT_SCHEMAS> = z.infer<typeof TOOL_OUTPUT_SCHEMAS[N]>;
