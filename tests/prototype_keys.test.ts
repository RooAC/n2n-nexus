import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

const manifest = (id: string) => ({
    id, name: id, description: "d", techStack: [], relations: [],
    repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
});

describe("Ids that collide with Object.prototype keys", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("prototype-keys"); });
    afterEach(async () => { await daemon.close(); });

    it("does not treat 'constructor' or 'toString' as existing projects", async () => {
        for (const id of ["constructor", "toString", "hasOwnProperty"]) {
            const reg = await daemon.callTool<{ ok: boolean }>("register_session_context", { projectId: id });
            expect(reg.payload.result?.ok, id).toBe(false);
            const del = await daemon.callTool("host_delete_project", { projectId: id });
            expect(del.status, id).toBe(400);
        }
    });

    it("stores and reads back projects and docs named like prototype keys", async () => {
        for (const id of ["constructor", "__proto__"]) {
            const sync = await daemon.callTool("sync_project_assets", { manifest: manifest(id), internalDocs: "" });
            expect(sync.status, id).toBe(200);
            const reg = await daemon.callTool<{ ok: boolean }>("register_session_context", { projectId: id });
            expect(reg.payload.result?.ok, id).toBe(true);

            const doc = await daemon.callTool("sync_global_doc", { docId: id, title: `T ${id}`, content: "# c" });
            expect(doc.status, id).toBe(200);
        }
        const topo = await daemon.callTool<{ summary: { totalProjects: number } }>("get_global_topology", {});
        expect(topo.payload.result?.summary.totalProjects).toBe(2);
        const docs = await daemon.request<{ docs: Record<string, { title: string }> }>("GET", "/api/global/docs");
        expect(Object.keys(docs.payload.docs).sort()).toEqual(["__proto__", "constructor"]);
    });
});
