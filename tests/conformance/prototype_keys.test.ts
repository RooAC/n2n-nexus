// Ids that collide with Object.prototype keys are ordinary ids.
import { describe, expect, it } from "vitest";
import { useHost } from "./harness.js";

const host = useHost();
const manifest = (id: string) => ({ id, name: id, description: "d", techStack: [], relations: [], repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: [] });

describe("ids that collide with Object.prototype keys", () => {
    it("does not treat 'constructor' or 'toString' as existing projects", async () => {
        for (const id of ["constructor", "toString", "hasOwnProperty"]) {
            expect((await host.callTool("get_project", { projectId: id })).status, id).toBe(400);
            expect((await host.callTool("host_delete_project", { projectId: id })).status, id).toBe(400);
        }
    });

    it("stores and reads back projects and docs named like prototype keys", async () => {
        for (const id of ["constructor", "__proto__"]) {
            expect((await host.callTool("sync_project_assets", { manifest: manifest(id), internalDocs: "" })).status, id).toBe(200);
            const got = await host.callTool<{ manifest: { id: string } }>("get_project", { projectId: id });
            expect(got.payload.result?.manifest.id, id).toBe(id);
            expect((await host.callTool("sync_global_doc", { docId: id, title: `T ${id}`, content: "# c" })).status, id).toBe(200);
        }
        const topo = await host.callTool<{ summary: { totalProjects: number } }>("get_global_topology", {});
        expect(topo.payload.result?.summary.totalProjects).toBe(2);
        const docs = await host.callTool<{ docs: { docId: string; title: string }[] }>("list_global_docs", {});
        expect(docs.payload.result?.docs.map((d) => d.docId).sort()).toEqual(["__proto__", "constructor"]);
        expect((await host.callTool<{ title: string }>("get_global_doc", { docId: "__proto__" })).payload.result?.title).toBe("T __proto__");
    });
});
