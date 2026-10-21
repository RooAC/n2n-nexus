import { promises as fs } from "fs";
import { ProjectManifest } from "../types.js";
import { FILE_ENCODING } from "../constants.js";

import { NexusPaths } from "./paths.js";
import { RegistryStorage } from "./registry.js";
import { ProjectStorage } from "./projects.js";
import { DocStorage } from "./docs.js";
import { fileStoreLock, restoreFile, snapshotFile, writeFileAtomic, writeJsonAtomic } from "./fs-utils.js";

export const BLUEPRINT_PLACEHOLDER = "# Global Coordination Blueprint\n\nShared meeting space.";

export class StorageManager {
    private static initialized = false;

    // --- Path Proxies (Backward Compatibility) ---
    static get globalDir() { return NexusPaths.globalDir; }
    static get globalBlueprint() { return NexusPaths.globalBlueprint; }
    static get projectsRoot() { return NexusPaths.projectsRoot; }
    static get registryFile() { return NexusPaths.registryFile; }

    static async init() {
        if (this.initialized) return;

        await fs.mkdir(NexusPaths.root, { recursive: true });
        await fs.mkdir(this.globalDir, { recursive: true });
        await fs.mkdir(this.projectsRoot, { recursive: true });

        // Self-healing initialization for critical files
        await this.loadJsonSafe(this.registryFile, { projects: {} });

        if (!await this.exists(this.globalBlueprint)) {
            await writeFileAtomic(this.globalBlueprint, BLUEPRINT_PLACEHOLDER);
        }

        await DocStorage.init();

        this.initialized = true;
    }

    static resetInit() {
        this.initialized = false;
    }

    private static async loadJsonSafe<T>(filePath: string, defaultValue: T): Promise<T> {
        try {
            if (!await this.exists(filePath)) {
                await writeJsonAtomic(filePath, defaultValue);
                return defaultValue;
            }
            const content = await fs.readFile(filePath, FILE_ENCODING);
            return JSON.parse(content.replace(/^\uFEFF/, '').trim());
        } catch {
            console.warn(`[Nexus Storage] Repairing corrupted file: ${filePath}`);
            await writeJsonAtomic(filePath, defaultValue);
            return defaultValue;
        }
    }

    static async exists(p: string) {
        try { await fs.access(p); return true; } catch { return false; }
    }

    // Every mutation of the file store takes the lock exclusively and every
    // public read takes it shared. Single files are written atomically (temp
    // file + rename), but some writes span several files (a rename moves the
    // directory before the registry switches ids), and a read between those
    // steps would see a registry entry whose files are gone. Code inside
    // write() must call the sub-modules directly, never these locked
    // StorageManager methods: the lock is not reentrant.
    private static write<T>(fn: () => Promise<T>): Promise<T> {
        return fileStoreLock.withWrite(fn);
    }

    private static read<T>(fn: () => Promise<T>): Promise<T> {
        return fileStoreLock.withRead(fn);
    }

    // --- Registry Methods ---
    static listRegistry() { return this.read(() => RegistryStorage.listRegistry()); }
    static getProjectManifest(id: string) { return this.read(() => RegistryStorage.getProjectManifest(id)); }
    static saveProjectManifest(manifest: ProjectManifest) { return this.write(() => RegistryStorage.saveProjectManifest(manifest)); }
    /**
     * Manifest and internal docs in one critical section, so a concurrent
     * delete cannot interleave. Docs are written first and
     * saveProjectManifest writes the registry last, so the registry only
     * lists the project once all its files are in place. If anything fails,
     * the docs file is put back to its original bytes (removed if it did not
     * exist, with the project directory if this call created it) and the
     * original error is rethrown; saveProjectManifest rolls back its own
     * manifest write.
     */
    static saveProject(manifest: ProjectManifest, docs: string) {
        return this.write(async () => {
            const snapshot = await snapshotFile(NexusPaths.projectDocPath(manifest.id));
            try {
                await ProjectStorage.saveProjectDocs(manifest.id, docs);
                await RegistryStorage.saveProjectManifest(manifest);
            } catch (error) {
                await restoreFile(snapshot);
                throw error;
            }
        });
    }
    static patchProjectManifest(id: string, patch: Partial<ProjectManifest>) { return this.write(() => RegistryStorage.patchProjectManifest(id, patch)); }
    static calculateTopology(projectId?: string) { return this.read(() => RegistryStorage.calculateTopology(projectId)); }

    // --- Project Methods ---
    static getProjectDocs(id: string) { return this.read(() => ProjectStorage.getProjectDocs(id)); }
    static saveProjectDocs(id: string, content: string) { return this.write(() => ProjectStorage.saveProjectDocs(id, content)); }
    /**
     * The existence check runs inside the write lock: writeFileAtomic creates
     * missing directories, so an upload queued behind a delete would otherwise
     * bring the deleted project's directory back.
     */
    static saveAsset(id: string, fileName: string, content: string | Buffer) {
        return this.write(async () => {
            const registry = await RegistryStorage.listRegistry();
            if (!registry.projects[id]) throw new Error(`Project '${id}' not found.`);
            return ProjectStorage.saveAsset(id, fileName, content);
        });
    }
    /** Files first, index last: if the files cannot be removed, the throw leaves the registry entry in place. */
    static deleteProject(id: string) {
        return this.write(async () => {
            await ProjectStorage.deleteProject(id);
            await RegistryStorage.deleteProject(id);
        });
    }
    /** RegistryStorage.renameProject moves the directory, manifests and registry together and rolls back on failure. */
    static renameProject(oldId: string, newId: string) {
        return this.write(async () => {
            if (!await RegistryStorage.getProjectManifest(oldId)) throw new Error(`Project '${oldId}' not found.`);
            const renamed = await RegistryStorage.renameProject(oldId, newId);
            if (renamed === 0) throw new Error(`Project '${oldId}' could not be renamed.`);
            return renamed;
        });
    }

    // --- Doc Methods ---
    static listGlobalDocs() { return this.read(() => DocStorage.listDocs()); }
    static getGlobalDoc(docId: string) { return this.read(() => DocStorage.getDoc(docId)); }
    static saveGlobalDoc(docId: string, title: string, content: string, updatedBy: string) { return this.write(() => DocStorage.saveDoc(docId, title, content, updatedBy)); }
    static deleteGlobalDoc(docId: string) { return this.write(() => DocStorage.deleteDoc(docId)); }
    static getGlobalBlueprint() { return this.read(() => DocStorage.getBlueprint()); }
    static saveGlobalBlueprint(content: string) { return this.write(() => DocStorage.saveBlueprint(content)); }
}
