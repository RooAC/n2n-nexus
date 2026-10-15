import { promises as fs } from "node:fs";
import path from "node:path";
import { AsyncMutex } from "../utils/async-mutex.js";
import { FILE_ENCODING } from "../constants.js";

/**
 * Serializes every file-store write inside the daemon. HTTP requests are
 * handled concurrently, so read-modify-write sequences on registry.json,
 * manifests and the docs index must be queued behind one lock.
 */
export const fileWriteLock = new AsyncMutex();

/**
 * Write to a temp file in the same directory, then rename over the target so
 * readers never observe a partially written file.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
        await fs.writeFile(tmp, data, typeof data === "string" ? FILE_ENCODING : undefined);
        await fs.rename(tmp, filePath);
    } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => { });
        throw e;
    }
}

/**
 * Copy entries into an object without a prototype. Registry and index maps
 * are keyed by user-supplied ids; on a plain object ids such as
 * "constructor" or "__proto__" hit Object.prototype on lookup or rewrite the
 * prototype on assignment.
 */
export function toDict<T>(entries: Iterable<[string, T]> = []): Record<string, T> {
    const dict = Object.create(null) as Record<string, T>;
    for (const [k, v] of entries) dict[k] = v;
    return dict;
}

export function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    return writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}
