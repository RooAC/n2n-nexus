// list_events: state changes are recorded as events, newest first, filtered by exact action or prefix.
// The event log is shared by the tests of this file, so they look at the newest events and at count deltas.
import { describe, expect, it } from "vitest";
import { useHost } from "./harness.js";

type NexusEvent = { action: string; target?: string | null; actor: string; detail?: unknown };

const host = useHost();
const manifest = (id: string) => ({ id, name: "E", description: "d", techStack: [], relations: [], repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: [] });
const events = async (args: Record<string, unknown>) => (await host.callTool<{ count: number; events: NexusEvent[] }>("list_events", args, "reader")).payload.result!;
const count = async (action: string) => (await events({ action, limit: 500 })).count;

describe("activity events", () => {
    it("records state changes as events instead of chat lines", async () => {
        await host.callTool("sync_project_assets", { manifest: manifest("web_evt"), internalDocs: "# doc" }, "ide-a");
        await host.callTool("upload_project_asset", { projectId: "web_evt", fileName: "a.txt", base64Content: Buffer.from("x").toString("base64") }, "ide-a");
        await host.callTool("rename_project", { oldId: "web_evt", newId: "web_evt2" }, "ide-a");

        const chat = await host.callTool<{ count: number }>("read_messages", { count: 50 }, "chat-reader");
        expect(chat.payload.result?.count).toBe(0);

        const newest = (await events({ limit: 3 })).events;
        expect(newest.map((e) => e.action)).toEqual(["project.rename", "project.asset", "project.sync"]);
        expect(newest[0]).toMatchObject({ actor: "ide-a", target: "web_evt2", detail: { oldId: "web_evt" } });
        expect(await count("project")).toBe(3);
    });

    it("records meeting events with their details", async () => {
        const meetingId = (await host.callTool<{ meetingId: string }>("start_meeting", { topic: "Evt" }, "ide-b")).payload.result!.meetingId;
        await host.callTool("end_meeting", { meetingId, summary: "done" }, "ide-b");

        const newest = (await events({ limit: 2 })).events;
        expect(newest.map((e) => e.action)).toEqual(["meeting.end", "meeting.start"]);
        expect(newest[0]).toMatchObject({ actor: "ide-b", target: meetingId, detail: { topic: "Evt", summary: "done" } });
        const ended = (await events({ action: "meeting.end", limit: 500 })).events;
        expect(ended.map((e) => e.target)).toEqual([meetingId]);
    });

    it("filters by exact action name or exact prefix, without case folding or wildcards", async () => {
        const actions = ["project", "project.sync", "Project", "%", "proj_ct", "project."];
        const before = await Promise.all(actions.map(count));
        await host.callTool("sync_project_assets", { manifest: manifest("web_evt3"), internalDocs: "# doc" }, "ide-a");
        const after = await Promise.all(actions.map(count));
        expect(after.map((n, i) => n - before[i])).toEqual([1, 1, 0, 0, 0, 0]);
        expect(after.slice(2)).toEqual([0, 0, 0, 0]);
    });
});
