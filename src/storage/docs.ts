import { promises as fs } from "node:fs";
import { NexusPaths } from "./paths.js";
import { FILE_ENCODING } from "../constants.js";
import { toDict, writeFileAtomic, writeJsonAtomic } from "./fs-utils.js";
import { GlobalDocIndex } from "../types.js";

export class DocStorage {
    private static async ensureDirectory(): Promise<void> {
        await fs.mkdir(NexusPaths.docsDir(), { recursive: true });
        try {
            await fs.access(NexusPaths.docsIndexFile);
        } catch {
            await writeJsonAtomic(NexusPaths.docsIndexFile, {});
        }
    }

    private static async readIndex(): Promise<GlobalDocIndex> {
        await this.ensureDirectory();
        try {
            const raw = await fs.readFile(NexusPaths.docsIndexFile, FILE_ENCODING);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") return toDict(Object.entries(parsed as GlobalDocIndex));
        } catch {
            // fall through
        }
        return toDict();
    }

    private static async writeIndex(index: GlobalDocIndex): Promise<void> {
        await this.ensureDirectory();
        await writeJsonAtomic(NexusPaths.docsIndexFile, index);
    }

    static async init(): Promise<void> {
        await this.ensureDirectory();
    }

    /** The master strategy document (global/blueprint.md). */
    static async getBlueprint(): Promise<string> {
        try {
            return await fs.readFile(NexusPaths.globalBlueprint, FILE_ENCODING);
        } catch {
            return "";
        }
    }

    static async saveBlueprint(content: string): Promise<void> {
        await writeFileAtomic(NexusPaths.globalBlueprint, content);
    }

    static async listDocs(): Promise<GlobalDocIndex> {
        await this.ensureDirectory();
        return this.readIndex();
    }

    static async getDoc(docId: string): Promise<string> {
        await this.ensureDirectory();
        const filePath = NexusPaths.docFile(docId);
        try {
            return await fs.readFile(filePath, FILE_ENCODING);
        } catch {
            return "";
        }
    }

    static async saveDoc(docId: string, title: string, content: string, updatedBy: string): Promise<void> {
        await this.ensureDirectory();
        const index = await this.readIndex();
        const filePath = NexusPaths.docFile(docId);
        await writeFileAtomic(filePath, content);
        index[docId] = {
            title,
            lastUpdated: new Date().toISOString(),
            updatedBy
        };
        await this.writeIndex(index);
    }

    static async deleteDoc(docId: string): Promise<void> {
        await this.ensureDirectory();
        const index = await this.readIndex();
        const filePath = NexusPaths.docFile(docId);
        delete index[docId];
        await this.writeIndex(index);
        await fs.rm(filePath, { force: true });
    }
}
