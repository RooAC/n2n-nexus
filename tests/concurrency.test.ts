import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

const PARALLEL = 20;

describe("Concurrent writes through the daemon", () => {
    let daemon: DaemonHarness;

    beforeEach(async () => { daemon = await startTestDaemon("concurrency"); });
    afterEach(async () => { await daemon.close(); });

    it("keeps every concurrently patched manifest field and leaves valid JSON", async () => {
        const manifest = {
            id: "web_concurrent", name: "Original", description: "Original", techStack: [], relations: [],
            repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
        };
        const sync = await daemon.callTool("sync_project_assets", { manifest, internalDocs: "# doc" });
        expect(sync.status).toBe(200);

        const patches = Array.from({ length: PARALLEL }, (_, i) =>
            i % 2 === 0 ? { name: `Name-${i}` } : { description: `Desc-${i}` }
        );
        const results = await Promise.all(patches.map((patch) =>
            daemon.callTool("update_project", { projectId: "web_concurrent", patch })
        ));
        expect(results.every((r) => r.status === 200)).toBe(true);

        const saved = JSON.parse(await fs.readFile(path.join(daemon.root, "projects", "web_concurrent", "manifest.json"), "utf8"));
        const registry = JSON.parse(await fs.readFile(path.join(daemon.root, "registry.json"), "utf8"));
        // Both fields were patched at least once, so neither can still hold the original value.
        expect(saved.name).not.toBe("Original");
        expect(saved.description).not.toBe("Original");
        expect(registry.projects.web_concurrent.name).toBe(saved.name);
        expect(registry.projects.web_concurrent.summary).toBe(saved.description);
    });

    it("records every concurrent global message", async () => {
        await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
            daemon.callTool("send_message", { message: `m${i}` }, `ide-${i}`)
        ));
        const read = await daemon.callTool<{ count: number }>("read_messages", { count: 100 }, "reader");
        expect(read.payload.result?.count).toBe(PARALLEL);
    });

    it("indexes every concurrently synced global doc", async () => {
        await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
            daemon.callTool("sync_global_doc", { docId: `doc-${i}`, title: `Doc ${i}`, content: `# ${i}` })
        ));
        const docs = await daemon.request<{ docs: Record<string, unknown> }>("GET", "/api/global/docs");
        expect(Object.keys(docs.payload.docs)).toHaveLength(PARALLEL);
    });
});
