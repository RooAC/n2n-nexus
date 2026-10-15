import { z } from "zod";
import { MESSAGE_CATEGORIES } from "../types.js";

/**
 * Tool contracts. Each zod schema is the single source of truth: it is
 * exported to MCP clients as JSON Schema (GET /api/tools) and used to
 * validate every call before a handler runs, for both the MCP tool path
 * and the REST endpoints.
 */

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
const safeId = (label: string) => z.string().min(1).regex(SAFE_ID, `${label} may contain only letters, numbers, dots, underscores and hyphens`);

export const projectIdSchema = safeId("Project ID").describe("Project ID with prefix, e.g. 'web_example.com' or 'mcp_nexus'");
const docIdSchema = safeId("Document ID").describe("Stable document ID");
const positiveInt = (max: number) => z.number().int().min(1).max(max);

export const manifestSchema = z.object({
    id: projectIdSchema,
    name: z.string().min(1),
    description: z.string(),
    techStack: z.array(z.string()),
    relations: z.array(z.object({
        targetId: projectIdSchema,
        type: z.enum(["dependency", "parent", "child", "related"])
    })),
    repositoryUrl: z.string(),
    localPath: z.string().describe("Physical disk path of the project"),
    endpoints: z.array(z.object({ name: z.string(), url: z.string(), description: z.string() })),
    apiSpec: z.array(z.object({ method: z.string(), path: z.string(), summary: z.string() })),
    billing: z.object({ plain: z.string(), price: z.string() }).optional(),
    lastUpdated: z.string().optional(),
    apiDependencies: z.record(z.string(), z.string()).optional().describe("projectId → version constraint"),
    gatewayCompatibility: z.string().optional(),
    api_versions: z.record(z.string(), z.string()).optional(),
    feature_tier: z.enum(["standard", "advanced", "team"]).optional()
}).describe("Project manifest");

export const manifestPatchSchema = manifestSchema.omit({ id: true, lastUpdated: true }).partial().strict()
    .describe("Manifest fields to update. 'id' cannot be changed here; use rename_project.");

export const TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

export const TOOL_SCHEMAS = {
    // Session
    register_session_context: z.object({ projectId: projectIdSchema }),

    // Projects
    sync_project_assets: z.object({
        manifest: manifestSchema,
        internalDocs: z.string().describe("Markdown implementation guide")
    }),
    upload_project_asset: z.object({
        fileName: z.string().min(1).describe("Filename only; unsafe characters are replaced"),
        base64Content: z.string().min(1)
    }),
    update_project: z.object({ projectId: projectIdSchema, patch: manifestPatchSchema }),
    rename_project: z.object({ oldId: projectIdSchema, newId: projectIdSchema }),
    search_projects: z.object({
        query: z.string().min(1),
        limit: positiveInt(200).default(10)
    }),
    get_global_topology: z.object({
        projectId: projectIdSchema.optional().describe("Focus on one project (optional)")
    }),

    // Messaging
    send_message: z.object({
        message: z.string().min(1),
        category: z.enum(MESSAGE_CATEGORIES).optional(),
        meetingId: z.string().min(1).optional().describe("Target meeting. Defaults to the active meeting, or global chat when none is active.")
    }),
    read_messages: z.object({
        count: positiveInt(500).default(10),
        meetingId: z.string().min(1).optional()
    }),
    list_events: z.object({
        limit: positiveInt(500).default(20),
        action: z.string().min(1).optional().describe("Exact action or prefix such as 'project' or 'meeting'")
    }),
    update_global_strategy: z.object({ content: z.string().min(1) }),
    sync_global_doc: z.object({
        docId: docIdSchema,
        title: z.string().min(1),
        content: z.string().min(1)
    }),

    // Meetings
    start_meeting: z.object({ topic: z.string().min(1) }),
    end_meeting: z.object({
        meetingId: z.string().min(1).optional().describe("Defaults to the active meeting"),
        summary: z.string().optional()
    }),
    archive_meeting: z.object({ meetingId: z.string().min(1) }),
    reopen_meeting: z.object({ meetingId: z.string().min(1) }),

    // Tasks
    create_task: z.object({
        source_meeting_id: z.string().min(1).optional().describe("Link to a meeting for traceability"),
        metadata: z.record(z.string(), z.unknown()).optional(),
        ttl: positiveInt(Number.MAX_SAFE_INTEGER).optional().describe("TTL in milliseconds; a pending/running task past its TTL is marked failed")
    }),
    get_task: z.object({ taskId: z.string().min(1) }),
    list_tasks: z.object({
        status: z.enum(TASK_STATUSES).optional(),
        limit: positiveInt(500).default(50)
    }),
    cancel_task: z.object({ taskId: z.string().min(1) }),

    // Maintenance
    host_maintenance: z.object({
        action: z.enum(["prune", "clear"]),
        count: z.number().int().min(0).default(0).describe("Oldest N global messages to remove (prune only)")
    }),
    host_delete_project: z.object({ projectId: projectIdSchema })
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolArgs<N extends ToolName> = z.infer<typeof TOOL_SCHEMAS[N]>;

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
    register_session_context: "Declare active project. Format: [prefix]_[name] (e.g. 'web_example.com', 'mcp_nexus').",
    sync_project_assets: "Sync full project manifest + internal docs.",
    upload_project_asset: "Upload binary file (base64) to active project's asset folder.",
    update_project: "Patch project manifest fields (partial update).",
    rename_project: "Rename project ID with cascading relation updates.",
    search_projects: "Search project registry by name or description.",
    get_global_topology: "Default: project list + stats. With projectId: detailed subgraph.",
    send_message: "Post a message. Goes to meetingId if given, else to the active meeting, else to global chat.",
    read_messages: "Read messages this instance has not read yet (cursor advances automatically). Global chat by default; pass meetingId for a meeting.",
    list_events: "Activity log: structured records of state changes (project.sync, project.rename, meeting.end, ...), newest first.",
    update_global_strategy: "Overwrite the master strategy document (global/blueprint.md).",
    sync_global_doc: "Create/update a global shared document.",
    start_meeting: "Start new meeting session. Returns meeting ID.",
    end_meeting: "End active meeting. Locks history.",
    archive_meeting: "Archive closed meeting. Read-only after.",
    reopen_meeting: "Reopen closed/archived meeting.",
    create_task: "Create a task you track yourself. Returns taskId; update it via get_task/cancel_task.",
    get_task: "Get task status and progress by ID.",
    list_tasks: "List tasks with optional status filter.",
    cancel_task: "Cancel pending/running task.",
    host_maintenance: "Manage the global chat stream: 'prune' the oldest N messages or 'clear' all.",
    host_delete_project: "Delete project. Irreversible."
};

export type ToolDefinition = {
    name: ToolName;
    description: string;
    inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

function toInputSchema(schema: z.ZodType): ToolDefinition["inputSchema"] {
    const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    delete json.$schema;
    return json as ToolDefinition["inputSchema"];
}

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: toInputSchema(TOOL_SCHEMAS[name])
}));

export function isToolName(name: string): name is ToolName {
    return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
}

export class ToolValidationError extends Error {
    constructor(tool: string, issues: string) {
        super(`Invalid arguments for ${tool}:\n${issues}`);
        this.name = "ToolValidationError";
    }
}

/** Validate raw arguments against a tool's schema; unknown top-level keys are dropped. */
export function parseToolArgs<N extends ToolName>(name: N, args: unknown): ToolArgs<N> {
    const result = TOOL_SCHEMAS[name].safeParse(args ?? {});
    if (!result.success) throw new ToolValidationError(name, z.prettifyError(result.error));
    return result.data as ToolArgs<N>;
}

/** Schema for POST /api/tasks/:id/update (not an MCP tool). */
export const taskUpdateSchema = z.object({
    status: z.enum(TASK_STATUSES).optional(),
    progress: z.number().min(0).max(1).optional(),
    result_uri: z.string().optional(),
    error_message: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
}).strict();
