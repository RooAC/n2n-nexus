import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { StorageManager } from "../src/storage/index.js";
import { NexusPaths } from "../src/storage/paths.js";
import { ProjectManifest } from "../src/types.js";
import { startTestDaemon, DaemonHarness } from "./helpers/daemon.js";

describe("Daemon project write API", () => {
    let daemon: DaemonHarness;

    beforeEach(async () => { daemon = await startTestDaemon("daemon-projects"); });
    afterEach(async () => { await daemon.close(); });

    it("sync_project_assets -> update_project -> rename_project -> delete_project: one source of truth", async () => {
        const manifestA: ProjectManifest = {
            id: "proj-demo",
            name: "Demo Project",
            description: "Original",
            techStack: ["node"],
            relations: [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: "https://example.com/demo",
            localPath: path.join(daemon.root, "demo"),
            endpoints: [{ name: "api", url: "http://localhost:3000", description: "main" }],
            apiSpec: [{ method: "GET", path: "/health", summary: "health" }]
        };
        await fs.mkdir(manifestA.localPath, { recursive: true });

        const sync = await daemon.request<{ ok: boolean; projectId: string }>("POST", "/api/projects/sync", {
            manifest: manifestA, internalDocs: "# Internal Notes", instanceId: "ide-a"
        });
        expect(sync.status).toBe(200);
        expect(sync.payload).toMatchObject({ ok: true, projectId: "proj-demo" });

        expect((await StorageManager.getProjectManifest("proj-demo"))?.id).toBe("proj-demo");
        expect(await StorageManager.getProjectDocs("proj-demo")).toContain("Internal Notes");

        const update = await daemon.request<{ ok: boolean }>("POST", "/api/projects/update", {
            projectId: "proj-demo", patch: { description: "Updated" }, instanceId: "ide-a"
        });
        expect(update.status).toBe(200);
        expect((await StorageManager.getProjectManifest("proj-demo"))?.description).toBe("Updated");

        const rename = await daemon.request<{ ok: boolean; newId: string }>("POST", "/api/projects/rename", {
            oldId: "proj-demo", newId: "proj-demo-renamed", instanceId: "ide-a"
        });
        expect(rename.status).toBe(200);
        expect(rename.payload.newId).toBe("proj-demo-renamed");
        expect(await StorageManager.getProjectManifest("proj-demo")).toBeNull();
        expect(await StorageManager.getProjectManifest("proj-demo-renamed")).not.toBeNull();
        expect(await StorageManager.exists(NexusPaths.projectDocPath("proj-demo-renamed"))).toBe(true);

        const remove = await daemon.request<{ ok: boolean }>("POST", "/api/projects/delete", {
            projectId: "proj-demo-renamed", instanceId: "ide-a"
        });
        expect(remove.status).toBe(200);
        expect(await StorageManager.getProjectManifest("proj-demo-renamed")).toBeNull();
        expect(await StorageManager.exists(path.join(StorageManager.projectsRoot, "proj-demo-renamed"))).toBe(false);
    });
});
