import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StorageManager } from "../src/storage/index.js";
import { ProjectManifest } from "../src/types.js";
import { promises as fs } from "fs";
import path from "path";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "test-storage-read-errors");

function manifestFor(id: string, techStack: string[] = []): ProjectManifest {
    return {
        id, name: id, description: "D", techStack, relations: [],
        lastUpdated: "", repositoryUrl: "", localPath: TEST_ROOT, endpoints: [], apiSpec: []
    };
}

/** readFile of `target` fails with `code`; every other read goes through. */
function failReadOf(target: string, code = "EACCES") {
    const realReadFile = fs.readFile.bind(fs);
    return vi.spyOn(fs, "readFile").mockImplementation((async (file: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        if (String(file) === target) {
            throw Object.assign(new Error(`Injected read failure (${code})`), { code });
        }
        return (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...args);
    }) as typeof fs.readFile);
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

const projectIds = async () => Object.keys((await StorageManager.listRegistry()).projects).sort();

describe("Storage read failures are not treated as empty files", () => {
    beforeEach(async () => {
        process.env.NEXUS_ROOT = TEST_ROOT;
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        StorageManager.resetInit();
        await StorageManager.init();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("does not drop other projects when the registry cannot be read", async () => {
        await StorageManager.saveProjectManifest(manifestFor("prj-a"));
        await StorageManager.saveProjectManifest(manifestFor("prj-b"));

        const failure = failReadOf(StorageManager.registryFile);
        await expect(StorageManager.saveProjectManifest(manifestFor("prj-c"))).rejects.toThrow("Injected read failure");
        failure.mockRestore();

        expect(await projectIds()).toEqual(["prj-a", "prj-b"]);
    });

    it("does not reset the registry on init when it cannot be read", async () => {
        await StorageManager.saveProjectManifest(manifestFor("prj-a"));

        StorageManager.resetInit();
        const failure = failReadOf(StorageManager.registryFile);
        await expect(StorageManager.init()).rejects.toThrow("Injected read failure");
        failure.mockRestore();

        expect(await projectIds()).toEqual(["prj-a"]);
    });

    it("does not drop other docs when the docs index cannot be read", async () => {
        await StorageManager.saveGlobalDoc("d1", "One", "# 1", "ide");
        await StorageManager.saveGlobalDoc("d2", "Two", "# 2", "ide");
        const indexFile = path.join(StorageManager.globalDir, "docs_index.json");

        const failure = failReadOf(indexFile);
        await expect(StorageManager.saveGlobalDoc("d3", "Three", "# 3", "ide")).rejects.toThrow("Injected read failure");
        await expect(StorageManager.deleteGlobalDoc("d1")).rejects.toThrow("Injected read failure");
        failure.mockRestore();

        expect(Object.keys(await StorageManager.listGlobalDocs()).sort()).toEqual(["d1", "d2"]);
        expect(await StorageManager.getGlobalDoc("d1")).toBe("# 1");
    });

    it("still self-heals corrupt or missing files", async () => {
        await fs.writeFile(StorageManager.registryFile, "{ not json");
        StorageManager.resetInit();
        await StorageManager.init();
        expect(JSON.parse(await fs.readFile(StorageManager.registryFile, "utf-8"))).toEqual({ projects: {} });

        await fs.writeFile(StorageManager.registryFile, "{ not json");
        await StorageManager.saveProjectManifest(manifestFor("prj-a"));
        expect(await projectIds()).toEqual(["prj-a"]);

        await fs.rm(StorageManager.registryFile);
        await StorageManager.saveProjectManifest(manifestFor("prj-b"));
        expect(await projectIds()).toEqual(["prj-b"]);

        const indexFile = path.join(StorageManager.globalDir, "docs_index.json");
        await fs.writeFile(indexFile, "{ not json");
        await StorageManager.saveGlobalDoc("d1", "One", "# 1", "ide");
        expect(Object.keys(await StorageManager.listGlobalDocs())).toEqual(["d1"]);
    });

    it("keeps the project directory when the registry write of a delete fails", async () => {
        await StorageManager.saveProject(manifestFor("prj-a", ["Node"]), "# A docs");
        const dir = path.join(StorageManager.projectsRoot, "prj-a");

        const failure = failAtomicWriteIn(TEST_ROOT);
        await expect(StorageManager.deleteProject("prj-a")).rejects.toThrow("Injected write failure");
        failure.mockRestore();

        expect(await projectIds()).toEqual(["prj-a"]);
        expect(await StorageManager.exists(path.join(dir, "manifest.json"))).toBe(true);
        expect((await StorageManager.getProjectManifest("prj-a"))?.techStack).toEqual(["Node"]);
        expect(await StorageManager.getProjectDocs("prj-a")).toBe("# A docs");
    });
});
