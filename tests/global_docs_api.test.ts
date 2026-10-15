import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

describe("Reading global docs and strategy through tools", () => {
    let daemon: DaemonHarness;
    beforeEach(async () => { daemon = await startTestDaemon("global-docs-api"); });
    afterEach(async () => { await daemon.close(); });

    it("reads back what sync_global_doc and update_global_strategy wrote", async () => {
        await daemon.callTool("sync_global_doc", { docId: "protocol", title: "Sync Protocol", content: "# v1" }, "ide-a");
        await daemon.callTool("sync_global_doc", { docId: "glossary", title: "Glossary", content: "# terms" }, "ide-b");
        await daemon.callTool("update_global_strategy", { content: "# Strategy" }, "ide-a");

        const list = await daemon.callTool<{ count: number; docs: { docId: string; title: string; updatedBy: string }[] }>("list_global_docs", {});
        expect(list.payload.result?.count).toBe(2);
        expect(list.payload.result?.docs[0]).toMatchObject({ docId: "glossary", title: "Glossary", updatedBy: "ide-b" });

        const doc = await daemon.callTool<{ title: string; content: string }>("get_global_doc", { docId: "protocol" });
        expect(doc.payload.result).toMatchObject({ docId: "protocol", title: "Sync Protocol", content: "# v1", updatedBy: "ide-a" });

        const missing = await daemon.callTool("get_global_doc", { docId: "nope" });
        expect(missing.status).toBe(400);
        expect(missing.payload.error).toContain("not found");

        const strategy = await daemon.callTool<{ content: string }>("get_global_strategy", {});
        expect(strategy.payload.result?.content).toBe("# Strategy");
    });
});
