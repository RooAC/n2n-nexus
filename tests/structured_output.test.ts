import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { NexusServer } from "../src/server/nexus.js";
import { TOOL_NAMES } from "../src/daemon/tools.js";
import { TOOL_OUTPUT_SCHEMAS } from "../src/daemon/tool-outputs.js";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";
import { StorageManager } from "../src/storage/index.js";

const ERAS = {
    "2025-11-25": undefined,
    "2026-07-28": { mode: { pin: "2026-07-28" } }
} as const;

const manifest = (id: string, relations: { targetId: string; type: string }[] = []) => ({
    id, name: id, description: "d", techStack: ["ts"], relations,
    repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
});

describe.each(Object.entries(ERAS))("structuredContent for every tool, %s client", (_era, versionNegotiation) => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("structured-output"); });
    afterEach(async () => { await daemon.close(); });

    it("returns results that match each tool's contract and published outputSchema", async () => {
        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        process.env.NEXUS_INSTANCE_ID = "structured";
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await new NexusServer().run({ transport: serverSide });
        const client = new Client({ name: "ide", version: "1" }, versionNegotiation ? { versionNegotiation } : {});
        await client.connect(clientSide);
        // After listTools the SDK client validates structuredContent against each published outputSchema.
        await client.listTools();

        const called = new Set<string>();
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const res = await client.callTool({ name, arguments: args });
            expect(res.isError, `${name}: ${JSON.stringify(res.content)}`).toBeFalsy();
            const structured = res.structuredContent as Record<string, unknown>;
            expect(structured, name).toBeDefined();
            // Same data in the text block (backwards compatibility).
            expect(JSON.parse((res.content as { text: string }[])[0].text)).toEqual(structured);
            // Strict contract check: no fields beyond the declared ones.
            const schema = TOOL_OUTPUT_SCHEMAS[name as keyof typeof TOOL_OUTPUT_SCHEMAS];
            expect(schema.parse(structured), name).toEqual(structured);
            called.add(name);
            return structured;
        };

        await call("sync_project_assets", { manifest: manifest("web_b"), internalDocs: "# b" });
        await call("sync_project_assets", { manifest: manifest("web_a", [{ targetId: "web_b", type: "dependency" }]), internalDocs: "# a" });
        await call("upload_project_asset", { projectId: "web_a", fileName: "a.txt", base64Content: Buffer.from("x").toString("base64") });
        await call("update_project", { projectId: "web_a", patch: { description: "new" } });
        await call("search_projects", { query: "web" });
        await call("get_global_topology", {});
        await call("get_global_topology", { projectId: "web_a" });
        await call("get_project", { projectId: "web_a" });
        await call("get_project", { projectId: "web_a", includeDocs: false });
        await call("send_message", { message: "global hi", category: "UPDATE" });
        await call("read_messages", { count: 5 });
        const directory = await call("list_sessions");
        const self = directory.self as { sessionId: string };
        await call("update_session", { name: "contract-test", projectId: "web_a" });
        const direct = await call("send_message", { to: self.sessionId, message: "direct hi" });
        await call("read_inbox");
        await call("get_message", { messageId: direct.messageId });
        await call("acknowledge_message", { messageId: direct.messageId });
        const meeting = await call("start_meeting", { topic: "Plan" });
        await call("send_message", { message: "in meeting", category: "DECISION" });
        await call("read_messages", { meetingId: meeting.meetingId, count: 5 });
        await call("list_meetings", {});
        await call("end_meeting", { meetingId: meeting.meetingId, summary: "done" });
        await call("archive_meeting", { meetingId: meeting.meetingId });
        await call("reopen_meeting", { meetingId: meeting.meetingId });
        await call("update_global_strategy", { content: "# S" });
        await call("get_global_strategy", {});
        await call("sync_global_doc", { docId: "d1", title: "D1", content: "# d" });
        await call("list_global_docs", {});
        await call("get_global_doc", { docId: "d1" });
        const task = await call("create_task", { metadata: { k: "v" }, ttl: 60000 });
        await call("get_task", { taskId: task.task_id });
        await call("list_tasks", {});
        await call("cancel_task", { taskId: task.task_id });
        await call("list_events", { limit: 50 });
        await call("rename_project", { oldId: "web_b", newId: "web_c" });
        await call("host_maintenance", { action: "prune", count: 1 });
        await call("host_delete_project", { projectId: "web_c" });

        expect([...called].sort()).toEqual([...TOOL_NAMES].sort());
        await client.close();
    });
});

describe("Result contracts at runtime", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("result-contracts"); });
    afterEach(async () => { await daemon.close(); vi.restoreAllMocks(); });

    it("strips fields a handler returns beyond its contract", async () => {
        await daemon.callTool("sync_project_assets", { manifest: manifest("web_drift"), internalDocs: "" });
        const real = StorageManager.getProjectManifest.bind(StorageManager);
        vi.spyOn(StorageManager, "getProjectManifest").mockImplementation(async (id: string) => {
            const m = await real(id);
            return m && ({ ...m, internalSecret: "x" } as typeof m);
        });
        const res = await daemon.callTool<{ manifest: Record<string, unknown> }>("get_project", { projectId: "web_drift" });
        expect(res.status).toBe(200);
        expect(res.payload.result?.manifest).not.toHaveProperty("internalSecret");
        expect(res.payload.result?.manifest.id).toBe("web_drift");
    });

    it("turns a result that cannot meet its contract into a server error", async () => {
        await daemon.callTool("sync_project_assets", { manifest: manifest("web_broken"), internalDocs: "" });
        vi.spyOn(console, "error").mockImplementation(() => { });
        vi.spyOn(StorageManager, "getProjectManifest").mockResolvedValue({ id: "web_broken" } as never);
        const res = await daemon.callTool("get_project", { projectId: "web_broken" });
        expect(res.status).toBe(500);
        expect(res.payload.error).toContain("does not match its contract");
    });
});

describe("Manifests written by earlier releases", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("legacy-manifests"); });
    afterEach(async () => { await daemon.close(); });

    it("are read back in a shape that satisfies the published outputSchema", async () => {
        const fsp = await import("node:fs/promises");
        const path = await import("node:path");
        await daemon.callTool("sync_project_assets", { manifest: manifest("web_target"), internalDocs: "" });
        // Constructed sample, not captured from a real install: before 0.6, update_project
        // wrote patches unvalidated, so nested entries could carry extra fields or miss some.
        const dir = path.join(daemon.root, "projects", "web_legacy");
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
            id: "web_legacy", name: "Legacy", description: "old",
            techStack: ["node", 42],
            relations: [
                { targetId: "web_target", type: "dependency", note: "extra field" },
                { targetId: "web_target" },
                { type: "child" },
                "garbage"
            ],
            endpoints: [{ name: "api", url: "http://x", extra: true }, { name: "partial" }],
            apiSpec: [{ method: "GET" }],
            feature_tier: "platinum",
            lastUpdated: "2026-01-01T00:00:00.000Z", repositoryUrl: "", localPath: "/tmp/x"
        }));
        const registryFile = path.join(daemon.root, "registry.json");
        const registry = JSON.parse(await fsp.readFile(registryFile, "utf8"));
        registry.projects.web_legacy = { name: "Legacy", summary: "old", lastActive: "2026-01-01T00:00:00.000Z" };
        await fsp.writeFile(registryFile, JSON.stringify(registry));

        process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
        process.env.NEXUS_INSTANCE_ID = "legacy";
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await new NexusServer().run({ transport: serverSide });
        // The 2026-07-28 client validates structuredContent against outputSchema.
        const client = new Client({ name: "ide", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        await client.connect(clientSide);
        await client.listTools();

        const project = await client.callTool({ name: "get_project", arguments: { projectId: "web_legacy" } });
        expect(project.isError).toBeFalsy();
        const m = (project.structuredContent as { manifest: Record<string, unknown> }).manifest;
        expect(m.relations).toEqual([
            { targetId: "web_target", type: "dependency" },
            { targetId: "web_target", type: "related" }
        ]);
        expect(m.endpoints).toEqual([
            { name: "api", url: "http://x", description: "" },
            { name: "partial", url: "", description: "" }
        ]);
        expect(m.techStack).toEqual(["node"]);
        expect(m).not.toHaveProperty("feature_tier");

        const topo = await client.callTool({ name: "get_global_topology", arguments: { projectId: "web_legacy" } });
        expect(topo.isError).toBeFalsy();
        expect((topo.structuredContent as { edges: unknown[] }).edges).toContainEqual({ from: "web_legacy", to: "web_target", type: "related" });
        await client.close();
    });
});
