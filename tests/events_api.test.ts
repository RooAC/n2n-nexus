import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";
import { NexusEvent } from "../src/types.js";

describe("Activity events through the daemon", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("events-api"); });
    afterEach(async () => { await daemon.close(); });

    it("records state changes as events instead of chat lines", async () => {
        const manifest = {
            id: "web_evt", name: "E", description: "d", techStack: [], relations: [],
            repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
        };
        await daemon.callTool("sync_project_assets", { manifest, internalDocs: "# doc" }, "ide-a");
        await daemon.callTool("upload_project_asset", { projectId: "web_evt", fileName: "a.txt", base64Content: Buffer.from("x").toString("base64") }, "ide-a");
        await daemon.callTool("rename_project", { oldId: "web_evt", newId: "web_evt2" }, "ide-a");

        const chat = await daemon.callTool<{ count: number }>("read_messages", { count: 50 }, "reader");
        expect(chat.payload.result?.count).toBe(0);

        const events = await daemon.callTool<{ events: NexusEvent[] }>("list_events", { limit: 10 }, "reader");
        expect(events.payload.result?.events.map((e) => e.action)).toEqual(["project.rename", "project.asset", "project.sync"]);
        expect(events.payload.result?.events[0].detail).toEqual({ oldId: "web_evt" });

        const rest = await daemon.request<{ count: number }>("GET", "/api/events?action=project&limit=10");
        expect(rest.payload.count).toBe(3);
    });
});
