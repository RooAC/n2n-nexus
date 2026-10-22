import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StorageManager } from "../src/storage/index.js";
import { ProjectManifest } from "../src/types.js";
import { promises as fs } from "fs";
import path from "path";
// Use a temp test directory
const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-storage");
process.env.NEXUS_ROOT = TEST_ROOT;

function manifestFor(id: string, relations: ProjectManifest["relations"] = []): ProjectManifest {
    return {
        id, name: id, description: "D", techStack: [], relations,
        lastUpdated: "", repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
    };
}

function failAtomicWriteIn(dir: string) {
    const realWriteFile = fs.writeFile.bind(fs);
    return vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
        if (path.dirname(String(file)) === dir) {
            throw Object.assign(new Error("Injected write failure"), { code: "EACCES" });
        }
        return realWriteFile(file, ...args);
    });
}

describe("StorageManager", () => {
    beforeEach(async () => {
        // Clean up and re-init with proper delay for filesystem sync
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            await fs.rm(TEST_ROOT, { recursive: true, force: true });
        } catch {
            // Ignore clean up errors
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        // Create root directory first to avoid race condition
        await fs.mkdir(TEST_ROOT, { recursive: true });

        StorageManager.resetInit();
        await StorageManager.init();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should initialize storage structure", async () => {
        expect(await StorageManager.exists(StorageManager.globalDir)).toBe(true);
        expect(await StorageManager.exists(StorageManager.projectsRoot)).toBe(true);
        expect(await StorageManager.exists(StorageManager.registryFile)).toBe(true);
    });

    it("should save and retrieve project manifest", async () => {
        const manifest: ProjectManifest = {
            id: "test-p",
            name: "Test Project",
            description: "Desc",
            techStack: ["Node"],
            relations: [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: "https://github.com/test",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        };
        await StorageManager.saveProjectManifest(manifest);
        const retrieved = await StorageManager.getProjectManifest("test-p");
        expect(retrieved?.name).toBe("Test Project");
    });

    it("should save and retrieve assets", async () => {
        await StorageManager.saveProjectManifest(manifestFor("test-p"));
        const content = Buffer.from("fake-image-data");
        const relPath = await StorageManager.saveAsset("test-p", "logo.png", content);
        expect(relPath).toContain("logo.png");
        const exists = await StorageManager.exists(path.join(TEST_ROOT, relPath));
        expect(exists).toBe(true);
    });

    it("should save and retrieve internal docs", async () => {
        const doc = "# Tech Doc";
        await StorageManager.saveProjectDocs("test-p", doc);
        const retrieved = await StorageManager.getProjectDocs("test-p");
        expect(retrieved).toBe(doc);
    });

    it("should calculate global topology (list mode and focused mode)", async () => {
        // Create Project A
        await StorageManager.saveProjectManifest({
            id: "prj-a", name: "A", description: "D", techStack: [],
            relations: [{ targetId: "prj-b", type: "dependency" }],
            lastUpdated: "",
            repositoryUrl: "",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        });
        // Create Project B
        await StorageManager.saveProjectManifest({
            id: "prj-b", name: "B", description: "D", techStack: [],
            relations: [], lastUpdated: "",
            repositoryUrl: "",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        });

        // Test list mode (default)
        const listResult = await StorageManager.calculateTopology();
        expect(listResult.mode).toBe("list");
        expect(listResult.summary.totalProjects).toBe(2);
        expect(listResult.summary.totalEdges).toBe(1);
        expect(Object.keys(listResult.projects)).toHaveLength(2);

        // Test focused mode
        const focusedResult = await StorageManager.calculateTopology("prj-a");
        expect(focusedResult.mode).toBe("focused");
        expect(focusedResult.nodes).toHaveLength(2); // prj-a + prj-b
        expect(focusedResult.edges).toHaveLength(1);
        expect(focusedResult.edges[0]).toMatchObject({ from: "prj-a", to: "prj-b", type: "dependency" });
    });

    it("should fail when patching a missing project", async () => {
        await expect(StorageManager.patchProjectManifest("missing-project", { description: "nope" }))
            .rejects
            .toThrow("Project 'missing-project' not found.");
    });

    it("should save, list, read, and delete global docs", async () => {
        await StorageManager.saveGlobalDoc("release-notes", "Release Notes", "# Notes", "tester");

        const docs = await StorageManager.listGlobalDocs();
        expect(docs["release-notes"]).toMatchObject({
            title: "Release Notes",
            updatedBy: "tester"
        });

        await expect(StorageManager.getGlobalDoc("release-notes")).resolves.toBe("# Notes");

        await StorageManager.deleteGlobalDoc("release-notes");
        const docsAfterDelete = await StorageManager.listGlobalDocs();
        expect(docsAfterDelete["release-notes"]).toBeUndefined();
        await expect(StorageManager.getGlobalDoc("release-notes")).resolves.toBe("");
    });

    it("should store the global strategy in blueprint.md", async () => {
        await StorageManager.saveGlobalBlueprint("# Strategy\n\nShip it.");
        expect(await fs.readFile(StorageManager.globalBlueprint, "utf-8")).toBe("# Strategy\n\nShip it.");
        expect(await StorageManager.getGlobalBlueprint()).toBe("# Strategy\n\nShip it.");
    });

    it("should reject path traversal in project and document identifiers", async () => {
        await expect(StorageManager.saveGlobalDoc("../escape", "Bad", "x", "tester"))
            .rejects
            .toThrow("Invalid document id");

        await expect(StorageManager.saveProjectManifest({
            id: "../escape",
            name: "Bad",
            description: "D",
            techStack: [],
            relations: [],
            lastUpdated: "",
            repositoryUrl: "",
            localPath: TEST_ROOT,
            endpoints: [],
            apiSpec: []
        })).rejects.toThrow("Invalid project id");
    });

    it("should delete project correctly", async () => {
        await StorageManager.saveProjectManifest({
            id: "prj-del", name: "D", description: "D", techStack: [],
            relations: [], lastUpdated: "", repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
        });

        expect(await StorageManager.getProjectManifest("prj-del")).not.toBeNull();

        await StorageManager.deleteProject("prj-del");

        expect(await StorageManager.getProjectManifest("prj-del")).toBeNull();
        const exists = await StorageManager.exists(path.join(StorageManager.projectsRoot, "prj-del"));
        expect(exists).toBe(false);
    });

    it("should cascade project rename through relations", async () => {
        await StorageManager.saveProjectManifest({
            id: "prj-source", name: "Source", description: "D", techStack: [],
            relations: [{ targetId: "prj-target", type: "dependency" }],
            lastUpdated: "", repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
        });
        await StorageManager.saveProjectManifest({
            id: "prj-target", name: "Target", description: "D", techStack: [],
            relations: [], lastUpdated: "", repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
        });

        await StorageManager.renameProject("prj-target", "prj-renamed");

        const source = await StorageManager.getProjectManifest("prj-source");
        expect(source?.relations[0]).toMatchObject({ targetId: "prj-renamed", type: "dependency" });

        const topology = await StorageManager.calculateTopology("prj-source");
        expect(topology.edges).toContainEqual({ from: "prj-source", to: "prj-renamed", type: "dependency" });
    });

    it("should restore registry, directories and manifests when a rename fails midway", async () => {
        await StorageManager.saveProject(manifestFor("prj-a"), "# A docs");
        await StorageManager.saveProjectManifest(manifestFor("prj-b", [{ targetId: "prj-a", type: "dependency" }]));
        const dirA = path.join(StorageManager.projectsRoot, "prj-a");
        const dirA2 = path.join(StorageManager.projectsRoot, "prj-a2");
        const dirB = path.join(StorageManager.projectsRoot, "prj-b");
        const manifestA = await fs.readFile(path.join(dirA, "manifest.json"), "utf-8");
        const manifestB = await fs.readFile(path.join(dirB, "manifest.json"), "utf-8");

        // Fail B's atomic write after A's directory and manifest have changed.
        const writeFailure = failAtomicWriteIn(dirB);
        try {
            await expect(StorageManager.renameProject("prj-a", "prj-a2")).rejects.toThrow("Injected write failure");

            const registry = await StorageManager.listRegistry();
            expect(Object.keys(registry.projects)).toContain("prj-a");
            expect(Object.keys(registry.projects)).not.toContain("prj-a2");
            expect(await StorageManager.exists(dirA)).toBe(true);
            expect(await StorageManager.exists(dirA2)).toBe(false);
            expect(await StorageManager.getProjectDocs("prj-a")).toBe("# A docs");
            expect(await fs.readFile(path.join(dirA, "manifest.json"), "utf-8")).toBe(manifestA);
            expect(await fs.readFile(path.join(dirB, "manifest.json"), "utf-8")).toBe(manifestB);
        } finally {
            writeFailure.mockRestore();
        }
    });

    it("should keep the registry entry when deleting the project files fails", async () => {
        await StorageManager.saveProject(manifestFor("prj-locked"), "# Locked");
        const dir = path.join(StorageManager.projectsRoot, "prj-locked");

        const realRm = fs.rm.bind(fs);
        const deleteFailure = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
            if (String(target) === dir) {
                throw Object.assign(new Error("Injected delete failure"), { code: "EACCES" });
            }
            return realRm(target, options);
        });
        try {
            await expect(StorageManager.deleteProject("prj-locked")).rejects.toThrow("Injected delete failure");

            const registry = await StorageManager.listRegistry();
            expect(Object.keys(registry.projects)).toContain("prj-locked");
            expect(await StorageManager.exists(path.join(dir, "manifest.json"))).toBe(true);
            expect(await StorageManager.getProjectDocs("prj-locked")).toBe("# Locked");
        } finally {
            deleteFailure.mockRestore();
        }
    });

    it("should not recreate a deleted project when uploads race the delete", async () => {
        const dir = path.join(StorageManager.projectsRoot, "prj-race");
        for (let round = 0; round < 10; round++) {
            await StorageManager.saveProjectManifest(manifestFor("prj-race"));
            const uploads = Array.from({ length: 5 }, (_, i) => () => StorageManager.saveAsset("prj-race", `f${i}.txt`, `round ${round}`));
            // Put the delete at a different position in the queue each round.
            const ops = [...uploads];
            ops.splice(round % (uploads.length + 1), 0, () => StorageManager.deleteProject("prj-race"));
            const results = await Promise.allSettled(ops.map((op) => op()));

            // The write lock is FIFO: uploads queued before the delete succeed, those after it are refused.
            const deleteAt = round % (uploads.length + 1);
            expect(results[deleteAt].status).toBe("fulfilled");
            expect(results.slice(0, deleteAt).map((r) => r.status)).toEqual(Array(deleteAt).fill("fulfilled"));
            for (const r of results.slice(deleteAt + 1)) {
                expect(r.status).toBe("rejected");
                expect(((r as PromiseRejectedResult).reason as Error).message).toBe("Project 'prj-race' not found.");
            }
            expect(await StorageManager.exists(dir)).toBe(false);
        }
    });

    it("should reject an upload to a deleted project without recreating its directory", async () => {
        await StorageManager.saveProjectManifest(manifestFor("prj-gone"));
        await StorageManager.deleteProject("prj-gone");

        await expect(StorageManager.saveAsset("prj-gone", "late.txt", "late"))
            .rejects.toThrow("Project 'prj-gone' not found.");
        expect(await StorageManager.exists(path.join(StorageManager.projectsRoot, "prj-gone"))).toBe(false);
    });

    it("should never return an entry with empty content while a rename is in progress", async () => {
        const manifest = { ...manifestFor("prj-live"), techStack: ["Node", "TypeScript"] };
        await StorageManager.saveProject(manifest, "# Live docs");

        // Slow the directory move down so reads land between it and the registry write.
        const realRename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (String(from) === path.join(StorageManager.projectsRoot, "prj-live")) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                await realRename(from, to);
                await new Promise((resolve) => setTimeout(resolve, 50));
                return;
            }
            return realRename(from, to);
        });

        const rename = StorageManager.renameProject("prj-live", "prj-live2");
        const reads: Promise<{ m: Awaited<ReturnType<typeof StorageManager.getProjectManifest>>; docs: string }>[] = [];
        for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            reads.push((async () => {
                const [m, docs] = await Promise.all([
                    StorageManager.getProjectManifest("prj-live"),
                    StorageManager.getProjectDocs("prj-live")
                ]);
                return { m, docs };
            })());
        }
        await rename;
        for (const { m, docs } of await Promise.all(reads)) {
            if (m === null) {
                expect(docs).toBe("");
            } else {
                expect(m.techStack).toEqual(["Node", "TypeScript"]);
                expect(docs).toBe("# Live docs");
            }
        }
        expect(await StorageManager.getProjectManifest("prj-live")).toBeNull();
        expect((await StorageManager.getProjectManifest("prj-live2"))?.techStack).toEqual(["Node", "TypeScript"]);
    });

    it("should leave no registry entry or directory when creating a project fails", async () => {
        const dir = path.join(StorageManager.projectsRoot, "prj-new");
        // mkdir of the project directory fails.
        const realMkdir = fs.mkdir.bind(fs);
        const createFailure = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
            if (String(target) === dir) {
                throw Object.assign(new Error("Injected mkdir failure"), { code: "EACCES" });
            }
            return realMkdir(target, options);
        });
        try {
            await expect(StorageManager.saveProject(manifestFor("prj-new"), "# New")).rejects.toThrow("Injected mkdir failure");
            expect(Object.keys((await StorageManager.listRegistry()).projects)).not.toContain("prj-new");
            expect(await StorageManager.exists(dir)).toBe(false);
        } finally {
            createFailure.mockRestore();
        }

        // The registry write fails after docs and manifest were written: both are removed with the new directory.
        const writeFailure = failAtomicWriteIn(TEST_ROOT);
        try {
            await expect(StorageManager.saveProject(manifestFor("prj-new"), "# New")).rejects.toThrow("Injected write failure");
            expect(Object.keys((await StorageManager.listRegistry()).projects)).not.toContain("prj-new");
            expect(await StorageManager.exists(dir)).toBe(false);
        } finally {
            writeFailure.mockRestore();
        }
    });

    it("should restore the manifest when the registry write of an update fails", async () => {
        await StorageManager.saveProject({ ...manifestFor("prj-upd"), techStack: ["Old"] }, "# Old docs");
        const manifestPath = path.join(StorageManager.projectsRoot, "prj-upd", "manifest.json");
        const registryBefore = await fs.readFile(StorageManager.registryFile);
        const manifestBefore = await fs.readFile(manifestPath);

        // registry.json and its atomic-write temp file live in the root directory.
        const writeFailure = failAtomicWriteIn(TEST_ROOT);
        try {
            await expect(StorageManager.patchProjectManifest("prj-upd", { name: "New", description: "New desc", techStack: ["New"] }))
                .rejects.toThrow("Injected write failure");
            expect(await fs.readFile(StorageManager.registryFile)).toEqual(registryBefore);
            expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
            const entry = (await StorageManager.listRegistry()).projects["prj-upd"];
            expect(entry).toMatchObject({ name: "prj-upd", summary: "D" });
        } finally {
            writeFailure.mockRestore();
        }
    });

    it("should keep the registry unchanged when the manifest write of an update fails", async () => {
        await StorageManager.saveProject({ ...manifestFor("prj-upd"), techStack: ["Old"] }, "# Old docs");
        const dir = path.join(StorageManager.projectsRoot, "prj-upd");
        const registryBefore = await fs.readFile(StorageManager.registryFile);
        const manifestBefore = await fs.readFile(path.join(dir, "manifest.json"));

        const writeFailure = failAtomicWriteIn(dir);
        try {
            await expect(StorageManager.patchProjectManifest("prj-upd", { name: "New", description: "New desc", techStack: ["New"] }))
                .rejects.toThrow("Injected write failure");
            expect(await fs.readFile(StorageManager.registryFile)).toEqual(registryBefore);
            expect(await fs.readFile(path.join(dir, "manifest.json"))).toEqual(manifestBefore);
        } finally {
            writeFailure.mockRestore();
        }
    });
});
