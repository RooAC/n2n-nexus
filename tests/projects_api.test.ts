import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

const manifest = (id: string, name: string, description: string) => ({
    id, name, description, techStack: ["node"], relations: [],
    repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
});

describe("Project tools through /api/tools/call", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("projects-api"); });
    afterEach(async () => { await daemon.close(); });

    it("searches by id, name or description with a limit", async () => {
        await daemon.callTool("sync_project_assets", { manifest: manifest("web_shop", "Shop", "storefront"), internalDocs: "" });
        await daemon.callTool("sync_project_assets", { manifest: manifest("api_auth", "Auth", "login service"), internalDocs: "" });
        await daemon.callTool("sync_project_assets", { manifest: manifest("lib_shopkit", "Kit", "shared shop helpers"), internalDocs: "" });

        const byText = await daemon.callTool<{ count: number; results: { id: string }[] }>("search_projects", { query: "shop" });
        expect(byText.payload.result?.results.map((r) => r.id).sort()).toEqual(["lib_shopkit", "web_shop"]);

        const limited = await daemon.callTool<{ count: number }>("search_projects", { query: "shop", limit: 1 });
        expect(limited.payload.result?.count).toBe(1);

        const byName = await daemon.callTool<{ results: { id: string }[] }>("search_projects", { query: "AUTH" });
        expect(byName.payload.result?.results[0].id).toBe("api_auth");
    });

    it("uploads an asset into an existing project named by projectId", async () => {
        const content = Buffer.from("png-bytes");
        const noProject = await daemon.callTool("upload_project_asset", { projectId: "web_assets", fileName: "logo.png", base64Content: content.toString("base64") }, "ide-u");
        expect(noProject.status).toBe(400);
        expect(noProject.payload.error).toContain("not found");

        await daemon.callTool("sync_project_assets", { manifest: manifest("web_assets", "Assets", "d"), internalDocs: "" }, "ide-u");

        const upload = await daemon.callTool<{ ok: boolean; message: string }>(
            "upload_project_asset", { projectId: "web_assets", fileName: "../etc/../logo v2.png", base64Content: content.toString("base64") }, "ide-u"
        );
        expect(upload.status).toBe(200);
        const assetsDir = path.join(daemon.root, "projects", "web_assets", "assets");
        const files = await fs.readdir(assetsDir);
        expect(files).toHaveLength(1);
        expect(files[0]).not.toContain("/");
        expect(await fs.readFile(path.join(assetsDir, files[0]))).toEqual(content);
    });

    it("reports only the successful concurrent rename and records its event", async () => {
        await daemon.callTool("sync_project_assets", {
            manifest: manifest("original", "Original", "rename source"), internalDocs: "# Preserved docs"
        });
        const outcomes = await Promise.all(["target_a", "target_b"].map((newId) =>
            daemon.callTool<{ newId: string }>("rename_project", { oldId: "original", newId })
        ));
        expect(outcomes.map((result) => result.status).sort()).toEqual([200, 400]);
        const winner = outcomes.find((result) => result.status === 200)!.payload.result!.newId;
        const loser = winner === "target_a" ? "target_b" : "target_a";
        const project = await daemon.callTool<{ internalDocs: string }>("get_project", { projectId: winner });
        expect(project.payload.result?.internalDocs).toBe("# Preserved docs");
        expect((await daemon.callTool("get_project", { projectId: "original" })).status).toBe(400);
        expect((await daemon.callTool("get_project", { projectId: loser })).status).toBe(400);
        const events = await daemon.callTool<{ events: { target: string }[] }>("list_events", { action: "project.rename" });
        expect(events.payload.result?.events).toHaveLength(1);
        expect(events.payload.result?.events[0].target).toBe(winner);
    });

    it("fails a rename without source files and restores the registry", async () => {
        await daemon.callTool("sync_project_assets", {
            manifest: manifest("missing_files", "Missing files", "registered source"), internalDocs: ""
        });
        await fs.rm(path.join(daemon.root, "projects", "missing_files"), { recursive: true });

        const result = await daemon.callTool("rename_project", { oldId: "missing_files", newId: "destination" });
        expect(result.status).toBe(400);
        expect(result.payload.error).toContain("could not be renamed");
        expect((await daemon.callTool("get_project", { projectId: "missing_files" })).status).toBe(200);
        expect((await daemon.callTool("get_project", { projectId: "destination" })).status).toBe(400);
        const events = await daemon.callTool<{ events: unknown[] }>("list_events", { action: "project.rename" });
        expect(events.payload.result?.events).toEqual([]);
    });

    it("returns a focused topology and tracks a managed task", async () => {
        await daemon.callTool("sync_project_assets", { manifest: { ...manifest("web_a", "A", "d"), relations: [{ targetId: "web_b", type: "dependency" }] }, internalDocs: "" });
        await daemon.callTool("sync_project_assets", { manifest: manifest("web_b", "B", "d"), internalDocs: "" });

        const topo = await daemon.callTool<{ mode: string; nodes: { id: string }[]; edges: unknown[] }>("get_global_topology", { projectId: "web_a" });
        expect(topo.payload.result?.mode).toBe("focused");
        expect(topo.payload.result?.nodes.map((n) => n.id).sort()).toEqual(["web_a", "web_b"]);
        expect(topo.payload.result?.edges).toHaveLength(1);

        const created = await daemon.callTool<{ task_id: string }>("create_task", { metadata: { kind: "review" } });
        const taskId = created.payload.result!.task_id;
        const fetched = await daemon.callTool<{ status: string; metadata: { kind: string } }>("get_task", { taskId });
        expect(fetched.payload.result).toMatchObject({ status: "pending", metadata: { kind: "review" } });
        const listed = await daemon.callTool<{ count: number }>("list_tasks", { status: "pending" });
        expect(listed.payload.result?.count).toBe(1);
        const cancelled = await daemon.callTool<{ ok: boolean }>("cancel_task", { taskId });
        expect(cancelled.payload.result?.ok).toBe(true);
    });
});

describe("get_project", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("get-project"); });
    afterEach(async () => { await daemon.close(); });

    it("returns the synced manifest and internal docs", async () => {
        await daemon.callTool("sync_project_assets", { manifest: { ...manifest("web_read", "Read", "d"), techStack: ["ts"] }, internalDocs: "# Notes" });

        const full = await daemon.callTool<{ manifest: { id: string; techStack: string[] }; internalDocs: string }>("get_project", { projectId: "web_read" });
        expect(full.payload.result?.manifest).toMatchObject({ id: "web_read", techStack: ["ts"] });
        expect(full.payload.result?.internalDocs).toBe("# Notes");

        const slim = await daemon.request<{ manifest: unknown; internalDocs?: string }>("GET", "/api/projects/web_read?includeDocs=false");
        expect(slim.status).toBe(200);
        expect(slim.payload.internalDocs).toBeUndefined();

        const missing = await daemon.callTool("get_project", { projectId: "web_none" });
        expect(missing.status).toBe(400);
        expect(missing.payload.error).toContain("not found");

        const search = await daemon.request("GET", "/api/projects/search?query=read");
        expect(search.status).toBe(200);
    });
});
