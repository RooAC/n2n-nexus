import { promises as fs } from "fs";
import { ProjectManifest } from "../types.js";
import { FILE_ENCODING } from "../constants.js";

import { NexusPaths } from "./paths.js";
import { RegistryStorage } from "./registry.js";
import { ProjectStorage } from "./projects.js";
import { DocStorage } from "./docs.js";
import { fileWriteLock, writeFileAtomic, writeJsonAtomic } from "./fs-utils.js";

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

    // Every mutation of the file store goes through this lock; reads are
    // lock-free because writes are atomic (temp file + rename).
    private static write<T>(fn: () => Promise<T>): Promise<T> {
        return fileWriteLock.withLock(fn);
    }

    // --- Registry Methods ---
    static listRegistry() { return RegistryStorage.listRegistry(); }
    static getProjectManifest(id: string) { return RegistryStorage.getProjectManifest(id); }
    static saveProjectManifest(manifest: ProjectManifest) { return this.write(() => RegistryStorage.saveProjectManifest(manifest)); }
    /** Manifest and internal docs in one critical section, so a concurrent delete cannot interleave. */
    static saveProject(manifest: ProjectManifest, docs: string) {
        return this.write(async () => {
            await RegistryStorage.saveProjectManifest(manifest);
            await ProjectStorage.saveProjectDocs(manifest.id, docs);
        });
    }
    static patchProjectManifest(id: string, patch: Partial<ProjectManifest>) { return this.write(() => RegistryStorage.patchProjectManifest(id, patch)); }
    static calculateTopology(projectId?: string) { return RegistryStorage.calculateTopology(projectId); }

    // --- Project Methods ---
    static getProjectDocs(id: string) { return ProjectStorage.getProjectDocs(id); }
    static saveProjectDocs(id: string, content: string) { return this.write(() => ProjectStorage.saveProjectDocs(id, content)); }
    static saveAsset(id: string, fileName: string, content: string | Buffer) { return this.write(() => ProjectStorage.saveAsset(id, fileName, content)); }
    static deleteProject(id: string) {
        return this.write(async () => {
            await ProjectStorage.deleteProject(id);
            await RegistryStorage.deleteProject(id);
        });
    }
    static renameProject(oldId: string, newId: string) {
        return this.write(async () => {
            if (!await RegistryStorage.getProjectManifest(oldId)) throw new Error(`Project '${oldId}' not found.`);
            const renamed = await RegistryStorage.renameProject(oldId, newId);
            if (renamed === 0) throw new Error(`Project '${oldId}' could not be renamed.`);
            try {
                const result = await ProjectStorage.renameProject(oldId, newId);
                if (result === 0) throw new Error(`Project '${oldId}' could not be renamed.`);
                return result;
            } catch (error) {
                await RegistryStorage.renameProject(newId, oldId).catch(() => { });
                throw error;
            }
        });
    }

    // --- Doc Methods ---
    static listGlobalDocs() { return DocStorage.listDocs(); }
    static getGlobalDoc(docId: string) { return DocStorage.getDoc(docId); }
    static saveGlobalDoc(docId: string, title: string, content: string, updatedBy: string) { return this.write(() => DocStorage.saveDoc(docId, title, content, updatedBy)); }
    static deleteGlobalDoc(docId: string) { return this.write(() => DocStorage.deleteDoc(docId)); }
    static getGlobalBlueprint() { return DocStorage.getBlueprint(); }
    static saveGlobalBlueprint(content: string) { return this.write(() => DocStorage.saveBlueprint(content)); }
}
