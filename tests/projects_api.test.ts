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

    it("uploads an asset into the registered project only", async () => {
        const content = Buffer.from("png-bytes");
        const noSession = await daemon.callTool("upload_project_asset", { fileName: "logo.png", base64Content: content.toString("base64") }, "ide-u");
        expect(noSession.status).toBe(400);
        expect(noSession.payload.error).toContain("register_session_context");

        await daemon.callTool("sync_project_assets", { manifest: manifest("web_assets", "Assets", "d"), internalDocs: "" }, "ide-u");
        const registered = await daemon.callTool<{ ok: boolean }>("register_session_context", { projectId: "web_assets" }, "ide-u");
        expect(registered.payload.result?.ok).toBe(true);

        const upload = await daemon.callTool<{ ok: boolean; message: string }>(
            "upload_project_asset", { fileName: "../etc/../logo v2.png", base64Content: content.toString("base64") }, "ide-u"
        );
        expect(upload.status).toBe(200);
        const assetsDir = path.join(daemon.root, "projects", "web_assets", "assets");
        const files = await fs.readdir(assetsDir);
        expect(files).toHaveLength(1);
        expect(files[0]).not.toContain("/");
        expect(await fs.readFile(path.join(assetsDir, files[0]))).toEqual(content);
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
