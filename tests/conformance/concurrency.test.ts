// Concurrent writes through the host lose nothing.
import { describe, expect, it } from "vitest";
import { useHost } from "./harness.js";

const PARALLEL = 20;
const host = useHost({ rateLimit: 0 });

describe("concurrent writes", () => {
    it("keeps every concurrently patched manifest field, and search sees the final values", async () => {
        const manifest = {
            id: "web_concurrent", name: "Original", description: "Original", techStack: [], relations: [],
            repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
        };
        expect((await host.callTool("sync_project_assets", { manifest, internalDocs: "# doc" })).status).toBe(200);

        const patches = Array.from({ length: PARALLEL }, (_, i) => i % 2 === 0 ? { name: `Name-${i}` } : { description: `Desc-${i}` });
        const results = await Promise.all(patches.map((patch) => host.callTool("update_project", { projectId: "web_concurrent", patch })));
        expect(results.map((r) => r.status)).toEqual(patches.map(() => 200));

        const saved = (await host.callTool<{ manifest: { name: string; description: string } }>("get_project", { projectId: "web_concurrent" })).payload.result!.manifest;
        // Both fields were patched at least once, so neither can still hold the original value.
        expect(saved.name).not.toBe("Original");
        expect(saved.description).not.toBe("Original");
        const search = await host.callTool<{ results: { id: string; name: string; description?: string }[] }>("search_projects", { query: "web_concurrent" });
        expect(search.payload.result?.results).toEqual([{ id: "web_concurrent", name: saved.name, description: saved.description }]);
    });

    it("records every concurrent global message", async () => {
        await Promise.all(Array.from({ length: PARALLEL }, (_, i) => host.callTool("send_message", { message: `m${i}` }, `ide-${i}`)));
        const read = await host.callTool<{ count: number; messages: { text: string }[] }>("read_messages", { count: 100 }, "reader");
        expect(read.payload.result?.count).toBe(PARALLEL);
        expect(read.payload.result?.messages.map((m) => m.text).sort()).toEqual(Array.from({ length: PARALLEL }, (_, i) => `m${i}`).sort());
    });

    it("indexes every concurrently synced global doc", async () => {
        await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
            host.callTool("sync_global_doc", { docId: `doc-${i}`, title: `Doc ${i}`, content: `# ${i}` })));
        const docs = await host.callTool<{ count: number }>("list_global_docs", {});
        expect(docs.payload.result?.count).toBe(PARALLEL);
    });
});
