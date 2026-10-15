import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";
import { TOOL_DEFINITIONS } from "../src/daemon/tools.js";
import { MESSAGE_CATEGORIES } from "../src/types.js";

describe("Tool contracts", () => {
    it("publishes one JSON Schema per tool, generated from the zod contract", () => {
        expect(TOOL_DEFINITIONS).toHaveLength(26);
        for (const tool of TOOL_DEFINITIONS) {
            expect(tool.inputSchema.type).toBe("object");
            expect(tool.inputSchema).not.toHaveProperty("$schema");
            expect(tool.description.length).toBeGreaterThan(0);
        }
        const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));
        expect(TOOL_DEFINITIONS.every((t) => t.annotations.openWorldHint === false)).toBe(true);
        expect(byName.host_delete_project.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(byName.host_maintenance.annotations.destructiveHint).toBe(true);
        for (const name of ["get_project", "list_global_docs", "list_meetings", "search_projects", "get_task"]) {
            expect(byName[name].annotations.readOnlyHint, name).toBe(true);
        }
        // read_messages moves the unread cursor, so it is not read-only.
        expect(byName.read_messages.annotations.readOnlyHint).toBe(false);
        expect(byName.send_message.annotations.destructiveHint).toBe(false);
        // Only purely additive tools may be non-destructive.
        for (const name of ["rename_project", "cancel_task", "end_meeting", "archive_meeting", "reopen_meeting"]) {
            expect(byName[name].annotations.destructiveHint, name).toBe(true);
        }
        for (const name of ["send_message", "start_meeting", "create_task"]) {
            expect(byName[name].annotations.destructiveHint, name).toBe(false);
        }

        for (const name of ["get_global_strategy", "list_global_docs"]) {
            expect(byName[name].inputSchema, name).toEqual({ type: "object", properties: {}, additionalProperties: false });
        }

        const send = TOOL_DEFINITIONS.find((t) => t.name === "send_message")!;
        expect((send.inputSchema.properties.category as { enum: string[] }).enum).toEqual([...MESSAGE_CATEGORIES]);
        expect(send.inputSchema.required).toEqual(["message"]);
    });
});

describe("Argument validation through the daemon", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("tool-validation"); });
    afterEach(async () => { await daemon.close(); });

    it("rejects wrong types, unknown enum values and unsafe ids with 400", async () => {
        const wrongType = await daemon.callTool("read_messages", { count: "5" });
        expect(wrongType.status).toBe(400);
        expect(wrongType.payload.error).toContain("Invalid arguments for read_messages");

        const badCategory = await daemon.callTool("send_message", { message: "x", category: "SYSTEM" });
        expect(badCategory.status).toBe(400);
        expect(badCategory.payload.error).not.toContain("CHECK constraint");

        const traversal = await daemon.callTool("get_project", { projectId: "../escape" });
        expect(traversal.status).toBe(400);

        const idInPatch = await daemon.callTool("update_project", { projectId: "web_x", patch: { id: "web_y" } });
        expect(idInPatch.status).toBe(400);
        expect(idInPatch.payload.error).toContain("Unrecognized key");

        const badMeeting = await daemon.callTool("create_task", { source_meeting_id: "no-such-meeting" });
        expect(badMeeting.status).toBe(400);
        expect(badMeeting.payload.error).toContain("not found");
    });

    it("applies defaults and validates REST endpoints with the same contract", async () => {
        const search = await daemon.callTool<{ query: string; count: number }>("search_projects", { query: "x" });
        expect(search.status).toBe(200);

        const rename = await daemon.request<{ error: string }>("POST", "/api/projects/rename", { oldId: "web_a", instanceId: "r" });
        expect(rename.status).toBe(400);
        expect(rename.payload.error).toContain("newId");

        const unread = await daemon.request<{ error: string }>("GET", "/api/messages/unread?count=abc&instanceId=r");
        expect(unread.status).toBe(400);

        const taskUpdate = await daemon.request<{ error: string }>("POST", "/api/tasks/nope/update", { progress: 7 });
        expect(taskUpdate.status).toBe(400);
    });
});
