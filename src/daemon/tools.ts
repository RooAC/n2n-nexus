import { z } from "zod";
import { MESSAGE_CATEGORIES } from "../types.js";
import { TASK_STATUSES } from "../storage/tasks.js";
import { TOOL_OUTPUT_SCHEMAS } from "./tool-outputs.js";

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

/** Tools without parameters: the spec recommends a schema that accepts only `{}`. */
const noParams = z.strictObject({});


export const TOOL_SCHEMAS = {
    // Projects
    sync_project_assets: z.object({
        manifest: manifestSchema,
        internalDocs: z.string().describe("Markdown implementation guide")
    }),
    upload_project_asset: z.object({
        projectId: projectIdSchema,
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
    get_project: z.object({
        projectId: projectIdSchema,
        includeDocs: z.boolean().default(true).describe("Also return the internal docs (Markdown)")
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
    get_global_strategy: noParams,
    update_global_strategy: z.object({ content: z.string().min(1) }),
    list_global_docs: noParams,
    get_global_doc: z.object({ docId: docIdSchema }),
    sync_global_doc: z.object({
        docId: docIdSchema,
        title: z.string().min(1),
        content: z.string().min(1)
    }),

    // Meetings
    list_meetings: z.object({
        status: z.enum(["active", "closed", "archived"]).optional(),
        limit: positiveInt(200).default(20)
    }),
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
    sync_project_assets: "Sync full project manifest + internal docs.",
    upload_project_asset: "Upload a binary file (base64) to a project's asset folder.",
    update_project: "Patch project manifest fields (partial update).",
    rename_project: "Rename project ID with cascading relation updates.",
    search_projects: "Search project registry by name or description.",
    get_global_topology: "Default: project list + stats. With projectId: detailed subgraph.",
    get_project: "Read a project's full manifest and, by default, its internal docs.",
    send_message: "Post a message. Goes to meetingId if given, else to the active meeting, else to global chat.",
    read_messages: "Read messages this instance has not read yet (cursor advances automatically). Global chat by default; pass meetingId for a meeting.",
    list_events: "Activity log: structured records of state changes (project.sync, project.rename, meeting.end, ...), newest first.",
    get_global_strategy: "Read the master strategy document (global/blueprint.md).",
    update_global_strategy: "Overwrite the master strategy document (global/blueprint.md).",
    list_global_docs: "List global shared documents: id, title, last update and author.",
    get_global_doc: "Read a global shared document by docId, with its title and metadata.",
    sync_global_doc: "Create/update a global shared document.",
    list_meetings: "List meetings, newest first: id, topic, status, initiator, participants, message/decision counts, summary. Read messages with read_messages(meetingId).",
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

/** Human-readable names clients show in their UI (MCP `title`). */
const TOOL_TITLES: Record<ToolName, string> = {
    sync_project_assets: "Sync Project",
    upload_project_asset: "Upload Project Asset",
    update_project: "Update Project",
    rename_project: "Rename Project",
    search_projects: "Search Projects",
    get_global_topology: "Project Topology",
    get_project: "Read Project",
    send_message: "Send Message",
    read_messages: "Read Messages",
    list_events: "Activity Log",
    get_global_strategy: "Read Strategy",
    update_global_strategy: "Update Strategy",
    list_global_docs: "List Shared Docs",
    get_global_doc: "Read Shared Doc",
    sync_global_doc: "Save Shared Doc",
    list_meetings: "List Meetings",
    start_meeting: "Start Meeting",
    end_meeting: "End Meeting",
    archive_meeting: "Archive Meeting",
    reopen_meeting: "Reopen Meeting",
    create_task: "Create Task",
    get_task: "Read Task",
    list_tasks: "List Tasks",
    cancel_task: "Cancel Task",
    host_maintenance: "Prune Global Chat",
    host_delete_project: "Delete Project"
};

/**
 * MCP tool annotations: behaviour hints clients use to decide, for example,
 * whether to ask the user before a call. All tools act on the local daemon
 * only, so openWorldHint is false throughout.
 */
export type ToolAnnotations = {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: false;
};

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/**
 * Changes state. `destructive` follows the MCP definition: false only when the
 * tool makes purely additive updates; anything that rewrites or removes
 * existing state (status changes included) is destructive. `idempotent` =
 * repeating the same call has no further effect.
 */
const write = (destructive: boolean, idempotent: boolean): ToolAnnotations =>
    ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });

const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
    sync_project_assets: write(true, true),       // replaces manifest and docs
    upload_project_asset: write(true, true),      // overwrites a same-named asset
    update_project: write(true, true),            // replaces the patched fields
    rename_project: write(true, false),           // removes the old id, rewrites relations
    search_projects: readOnly,
    get_global_topology: readOnly,
    get_project: readOnly,
    send_message: write(false, false),
    read_messages: write(false, false),           // only advances this instance's own unread cursor (bookkeeping, not shared data)
    list_events: readOnly,
    get_global_strategy: readOnly,
    update_global_strategy: write(true, true),    // overwrites the document
    list_global_docs: readOnly,
    get_global_doc: readOnly,
    sync_global_doc: write(true, true),           // overwrites the document
    list_meetings: readOnly,
    start_meeting: write(false, false),
    end_meeting: write(true, false),              // closes the meeting, sets summary
    archive_meeting: write(true, false),          // changes status
    reopen_meeting: write(true, false),           // changes status
    create_task: write(false, false),
    get_task: readOnly,
    list_tasks: readOnly,
    cancel_task: write(true, true),               // irreversible status change
    host_maintenance: write(true, false),         // deletes chat messages
    host_delete_project: write(true, true)        // irreversible
};

export type ToolDefinition = {
    name: ToolName;
    title: string;
    description: string;
    outputSchema?: Record<string, unknown>;
    inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    annotations: ToolAnnotations;
};

function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
    const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
    delete json.$schema;
    return json;
}

function toInputSchema(schema: z.ZodType): ToolDefinition["inputSchema"] {
    const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    delete json.$schema;
    return json as ToolDefinition["inputSchema"];
}

// Compile-time check: every tool has a result contract and no contract lacks a tool.
const _outputsCover: Record<ToolName, z.ZodType> = TOOL_OUTPUT_SCHEMAS;
const _outputsMatch: Record<keyof typeof TOOL_OUTPUT_SCHEMAS, unknown> = TOOL_SCHEMAS;
void _outputsCover; void _outputsMatch;

export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

/**
 * Tools whose outputSchema is published in tools/list. Every tool has a result
 * contract (and every result is sent as structuredContent), but the schemas of
 * write tools only describe a short acknowledgement and nearly doubled the
 * tools/list payload that sits in every model context, so only tools that
 * return data publish theirs.
 */
const PUBLISHED_OUTPUT_SCHEMAS = new Set<ToolName>([
    "search_projects", "get_global_topology", "get_project",
    "read_messages", "list_events",
    "get_global_strategy", "list_global_docs", "get_global_doc",
    "list_meetings", "get_task", "list_tasks"
]);

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_NAMES.map((name) => ({
    name,
    title: TOOL_TITLES[name],
    description: TOOL_DESCRIPTIONS[name],
    ...(PUBLISHED_OUTPUT_SCHEMAS.has(name) ? { outputSchema: toOutputSchema(TOOL_OUTPUT_SCHEMAS[name]) } : {}),
    inputSchema: toInputSchema(TOOL_SCHEMAS[name]),
    annotations: TOOL_ANNOTATIONS[name]
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
