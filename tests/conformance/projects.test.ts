// Project tools: sync, update, rename, delete and asset upload.
import { describe, expect, it } from "vitest";
import { useHost } from "./harness.js";

type Manifest = { id: string; name: string; description: string };

const host = useHost();
const project = (projectId: string, includeDocs = true) =>
    host.callTool<{ manifest: Manifest; internalDocs?: string }>("get_project", { projectId, includeDocs }, "ide-a");
const emptyManifest = (id: string) => ({
    id, name: id, description: "", techStack: [], relations: [], repositoryUrl: "", localPath: "/tmp/x", endpoints: [], apiSpec: []
});

describe("project tools", () => {
    it("sync_project_assets -> update_project -> rename_project -> host_delete_project: one source of truth", async () => {
        const manifestA = {
            id: "proj-demo",
            name: "Demo Project",
            description: "Original",
            techStack: ["node"],
            relations: [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: "https://example.com/demo",
            localPath: "/tmp/demo",
            endpoints: [{ name: "api", url: "http://localhost:3000", description: "main" }],
            apiSpec: [{ method: "GET", path: "/health", summary: "health" }]
        };
        const sync = await host.callTool<{ ok: boolean; projectId: string }>("sync_project_assets", { manifest: manifestA, internalDocs: "# Internal Notes" }, "ide-a");
        expect(sync.status).toBe(200);
        expect(sync.payload.result).toMatchObject({ ok: true, projectId: "proj-demo" });

        const synced = await project("proj-demo");
        expect(synced.payload.result?.manifest).toMatchObject({ id: "proj-demo", name: "Demo Project", description: "Original", techStack: ["node"] });
        expect(synced.payload.result?.internalDocs).toContain("Internal Notes");
        expect((await project("proj-demo", false)).payload.result).not.toHaveProperty("internalDocs");

        const update = await host.callTool("update_project", { projectId: "proj-demo", patch: { description: "Updated" } }, "ide-a");
        expect(update.status).toBe(200);
        expect((await project("proj-demo")).payload.result?.manifest.description).toBe("Updated");

        const rename = await host.callTool<{ ok: boolean; newId: string }>("rename_project", { oldId: "proj-demo", newId: "proj-demo-renamed" }, "ide-a");
        expect(rename.status).toBe(200);
        expect(rename.payload.result?.newId).toBe("proj-demo-renamed");
        const old = await project("proj-demo");
        expect(old.status).toBe(400);
        expect(old.payload.error).toContain("not found");
        const renamed = await project("proj-demo-renamed");
        expect(renamed.payload.result?.manifest).toMatchObject({ id: "proj-demo-renamed", description: "Updated" });
        expect(renamed.payload.result?.internalDocs).toContain("Internal Notes");   // the docs moved with it

        const remove = await host.callTool("host_delete_project", { projectId: "proj-demo-renamed" }, "ide-a");
        expect(remove.status).toBe(200);
        expect((await project("proj-demo-renamed")).status).toBe(400);
        const search = await host.callTool<{ count: number }>("search_projects", { query: "proj-demo" });
        expect(search.payload.result?.count).toBe(0);
        expect((await host.callTool("host_delete_project", { projectId: "proj-demo-renamed" }, "ide-a")).status).toBe(400);
    });

    it("upload_project_asset reports the name the asset is saved under", async () => {
        expect((await host.callTool("sync_project_assets", { manifest: emptyManifest("proj-asset"), internalDocs: "" }, "ide-a")).status).toBe(200);
        const upload = await host.callTool<{ fileName: string; message: string }>("upload_project_asset", {
            projectId: "proj-asset", fileName: "logo..png", base64Content: Buffer.from("png").toString("base64")
        }, "ide-a");
        expect(upload.status).toBe(200);
        expect(upload.payload.result?.fileName).toBe("logo_png");
        expect(upload.payload.result?.message).toContain("logo_png");

        const missing = await host.callTool("upload_project_asset", { projectId: "no-such-project", fileName: "a.txt", base64Content: "eA==" }, "ide-a");
        expect(missing.status).toBe(400);
        expect(missing.payload.error).toContain("not found");
    });

    it("upload_project_asset refuses a file name that sanitizes to '.' and keeps accepting others", async () => {
        expect((await host.callTool("sync_project_assets", { manifest: emptyManifest("proj-dot"), internalDocs: "" }, "ide-a")).status).toBe(200);
        const content = Buffer.from("x").toString("base64");

        const bad = await host.callTool("upload_project_asset", { projectId: "proj-dot", fileName: ".", base64Content: content }, "ide-a");
        expect(bad.status).toBe(400);
        expect(bad.payload.error).toContain("Invalid fileName '.'");

        const good = await host.callTool<{ fileName: string }>("upload_project_asset", { projectId: "proj-dot", fileName: "ok.txt", base64Content: content }, "ide-a");
        expect(good.status).toBe(200);
        expect(good.payload.result?.fileName).toBe("ok.txt");
    });
});
