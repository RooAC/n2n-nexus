// GET /api/tools against contract/tools.json, and argument validation of POST /api/tools/call.
import { describe, expect, it } from "vitest";
import { TOOLS_CONTRACT, useHost, type JsonSchema } from "./harness.js";

type Definition = {
    name: string; title: string; description: string; annotations: Record<string, boolean>;
    inputSchema: JsonSchema & { properties: Record<string, JsonSchema>; required?: string[] }; outputSchema?: JsonSchema;
};

const host = useHost();
const definitions = async () => {
    const res = await host.request<{ tools: Definition[] }>("GET", "/api/tools");
    expect(res.status).toBe(200);
    return Object.fromEntries(res.payload.tools.map((t) => [t.name, t]));
};

describe("GET /api/tools", () => {
    it("publishes what contract/tools.json defines: name, title, description, annotations, inputSchema, and outputSchema only when publishOutputSchema", async () => {
        const byName = await definitions();
        const expected = TOOLS_CONTRACT.tools;
        expect(Object.keys(byName).sort()).toEqual(expected.map((t) => t.name).sort());
        for (const t of expected) {
            const want = {
                name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema,
                ...(t.publishOutputSchema ? { outputSchema: t.outputSchema } : {})
            };
            expect(byName[t.name], t.name).toEqual(want);
        }
    });

    it("marks tools read-only, destructive and closed-world as the contract intends", async () => {
        const byName = await definitions();
        const tools = Object.values(byName);
        for (const tool of tools) {
            expect(tool.inputSchema.type).toBe("object");
            expect(tool.inputSchema).not.toHaveProperty("$schema");
            expect(tool.description.length).toBeGreaterThan(0);
            expect(tool.title.length).toBeGreaterThan(0);
        }
        expect(tools.every((t) => t.annotations.openWorldHint === false)).toBe(true);
        expect(new Set(tools.map((t) => t.title)).size).toBe(tools.length);
        expect(byName.host_delete_project.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(byName.host_maintenance.annotations.destructiveHint).toBe(true);
        for (const name of ["get_project", "list_global_docs", "list_meetings", "search_projects", "get_task"]) {
            expect(byName[name].annotations.readOnlyHint, name).toBe(true);
        }
        // read_messages moves the unread cursor and read marks messages read, so neither is read-only.
        expect(byName.read_messages.annotations.readOnlyHint).toBe(false);
        expect(byName.read.annotations.readOnlyHint).toBe(false);
        expect(byName.peers.annotations.readOnlyHint).toBe(true);
        // Only purely additive tools may be non-destructive.
        for (const name of ["rename_project", "cancel_task", "end_meeting", "archive_meeting", "reopen_meeting"]) {
            expect(byName[name].annotations.destructiveHint, name).toBe(true);
        }
        for (const name of ["start_meeting", "create_task", "send_message", "send", "reply"]) {
            expect(byName[name].annotations.destructiveHint, name).toBe(false);
        }
        for (const name of ["get_global_strategy", "list_global_docs"]) {
            expect(byName[name].inputSchema, name).toEqual({ type: "object", properties: {}, additionalProperties: false });
        }
        const category = byName.send_message.inputSchema.properties.category as { enum: string[] };
        expect(category.enum).toEqual(["MEETING_START", "PROPOSAL", "DECISION", "UPDATE", "CHAT"]);
        expect(byName.send_message.inputSchema.required).toEqual(["message"]);
    });

    it("create_task points to update_task", async () => {
        const byName = await definitions();
        expect(byName.create_task.description).toContain("update_task");
        expect(byName.update_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    });
});

describe("POST /api/tools/call: arguments", () => {
    it("answers 400 without a tool and 404 for an unknown tool", async () => {
        const missing = await host.request<{ ok: boolean; error: string }>("POST", "/api/tools/call", { args: {} });
        expect(missing.status).toBe(400);
        expect(missing.payload).toEqual({ ok: false, error: "tool is required" });
        const unknown = await host.callTool("no_such_tool", {});
        expect(unknown.status).toBe(404);
        expect(unknown.payload).toEqual({ ok: false, error: "Unknown tool: 'no_such_tool'" });
    });

    it("rejects wrong types, unknown enum values, unknown keys and unsafe ids with 400", async () => {
        const wrongType = await host.callTool("read_messages", { count: "5" });
        expect(wrongType.status).toBe(400);
        expect(wrongType.payload.error).toContain("Invalid arguments for read_messages");
        expect((await host.callTool("read_messages", { count: "abc" })).status).toBe(400);

        const badCategory = await host.callTool("send_message", { message: "x", category: "SYSTEM" });
        expect(badCategory.status).toBe(400);
        expect(badCategory.payload.error).not.toContain("CHECK constraint");

        expect((await host.callTool("get_project", { projectId: "../escape" })).status).toBe(400);
        expect((await host.callTool("get_global_doc", { docId: "a/b" })).status).toBe(400);

        const idInPatch = await host.callTool("update_project", { projectId: "web_x", patch: { id: "web_y" } });
        expect(idInPatch.status).toBe(400);
        expect(idInPatch.payload.error).toContain("Invalid arguments for update_project");

        const noNewId = await host.callTool("rename_project", { oldId: "web_a" }, "r");
        expect(noNewId.status).toBe(400);
        expect(noNewId.payload.error).toContain("newId");

        const badMeeting = await host.callTool("create_task", { source_meeting_id: "no-such-meeting" });
        expect(badMeeting.status).toBe(400);
        expect(badMeeting.payload.error).toContain("not found");
    });

    it("applies defaults", async () => {
        const search = await host.callTool<{ query: string; count: number; results: unknown[] }>("search_projects", { query: "x" });
        expect(search.status).toBe(200);
        expect(search.payload.result).toEqual({ query: "x", count: 0, results: [] });
        const noArgs = await host.request<{ ok: boolean }>("POST", "/api/tools/call", { tool: "list_meetings", instanceId: "r" });
        expect(noArgs.status).toBe(200);
    });

    it("refuses tools that advance a read cursor without an instanceId", async () => {
        const res = await host.callTool("read_messages", { count: 5 }, null);
        expect(res.status).toBe(400);
        expect(res.payload.ok).toBe(false);
        expect((await host.callTool("read_messages", { count: 5 }, "reader")).status).toBe(200);
    });
});
