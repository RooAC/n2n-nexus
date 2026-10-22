import { promises as fs } from "node:fs";
import path from "node:path";
import { AsyncRWLock } from "../utils/async-rwlock.js";
import { FILE_ENCODING } from "../constants.js";

/**
 * Guards the file store inside the daemon. HTTP requests are handled
 * concurrently: writes take it exclusively, so read-modify-write sequences on
 * registry.json, manifests and the docs index are queued; reads take it
 * shared, so they never observe a multi-file write (such as a rename) halfway.
 */
export const fileStoreLock = new AsyncRWLock();

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
        for (let attempt = 0; ; attempt++) {
            try {
                await fs.rename(tmp, filePath);
                break;
            } catch (error) {
                // Windows can briefly deny replacement while another process reads the target.
                const code = (error as NodeJS.ErrnoException).code;
                if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 4) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
            }
        }
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

/**
 * State of a file before a write, for rollback: its bytes (null when it did
 * not exist) and whether its directory is about to be created by that write.
 */
export type FileSnapshot = { path: string; original: Buffer | null; createsDir: boolean };

export async function snapshotFile(filePath: string): Promise<FileSnapshot> {
    const dir = path.dirname(filePath);
    let createsDir = false;
    try {
        await fs.access(dir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        createsDir = true;
    }
    let original: Buffer | null = null;
    if (!createsDir) {
        try {
            original = await fs.readFile(filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    return { path: filePath, original, createsDir };
}

/**
 * Puts a file back as snapshotFile recorded it: original bytes rewritten,
 * a file that did not exist removed, and a directory the write created
 * removed with everything in it. Best effort: an undo failure is swallowed
 * so the caller can rethrow the error that caused the rollback.
 */
export async function restoreFile(snapshot: FileSnapshot): Promise<void> {
    try {
        if (snapshot.createsDir) {
            await fs.rm(path.dirname(snapshot.path), { recursive: true, force: true });
        } else if (snapshot.original === null) {
            await fs.rm(snapshot.path, { force: true });
        } else {
            await writeFileAtomic(snapshot.path, snapshot.original);
        }
    } catch {
        // Best effort, see above.
    }
}
