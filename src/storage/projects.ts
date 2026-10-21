import { promises as fs } from "node:fs";
import path from "node:path";
import { NexusPaths } from "./paths.js";
import { FILE_ENCODING } from "../constants.js";
import { writeFileAtomic } from "./fs-utils.js";

export class ProjectStorage {
    private static projectFilePath(projectId: string) {
        return {
            docsPath: NexusPaths.projectDocPath(projectId),
            assetsDir: NexusPaths.projectAssetsDir(projectId),
            manifestPath: NexusPaths.projectManifestPath(projectId),
            projectDir: NexusPaths.projectDir(projectId)
        };
    }

    static async getProjectDocs(projectId: string): Promise<string> {
        const paths = this.projectFilePath(projectId);
        try {
            return await fs.readFile(paths.docsPath, FILE_ENCODING);
        } catch {
            return "";
        }
    }

    static async saveProjectDocs(projectId: string, content: string): Promise<void> {
        const paths = this.projectFilePath(projectId);
        await writeFileAtomic(paths.docsPath, content);
    }

    static async saveAsset(projectId: string, fileName: string, content: string | Buffer): Promise<string> {
        const safeName = this.sanitizeFileName(fileName);
        // "." would resolve to the assets directory itself and writeFileAtomic would create a file in its place.
        if (safeName === ".") throw new Error(`Invalid fileName '${fileName}': it names no file.`);
        const paths = this.projectFilePath(projectId);
        const assetPath = path.join(paths.assetsDir, safeName);
        await writeFileAtomic(assetPath, content);
        return path.relative(NexusPaths.root, assetPath);
    }

    /**
     * Removes the project directory. A missing directory counts as deleted
     * (force); any other failure is thrown so the caller keeps the registry
     * entry instead of indexing a project whose files are still on disk.
     */
    static async deleteProject(projectId: string): Promise<number> {
        const paths = this.projectFilePath(projectId);
        await fs.rm(paths.projectDir, { recursive: true, force: true });
        return 1;
    }

    private static sanitizeFileName(fileName: string): string {
        return fileName
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\.\./g, "_");
    }
}
