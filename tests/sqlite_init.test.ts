import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { closeDatabase, initDatabase } from "../src/storage/sqlite.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "sqlite-init");
const HOLDER = path.join(__dirname, "helpers", "sqlite-lock-holder.mjs");

/** Another process holding a write lock on the database file for `ms`; resolves once it has the lock. */
function holdLock(dbPath: string, ms: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HOLDER, dbPath, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
        child.on("error", reject);
        child.once("exit", (code, signal) => reject(new Error(`lock holder exited before HOLDING (code ${code}, signal ${signal})`)));
        child.stdout.on("data", (chunk) => { if (String(chunk).includes("HOLDING")) resolve(child); });
    });
}

describe("initDatabase with a concurrent first start", () => {
    let holder: ChildProcess | undefined;

    beforeEach(() => {
        closeDatabase();
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        fs.mkdirSync(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
    });
    afterEach(async () => {
        closeDatabase();
        if (holder && holder.exitCode === null && holder.signalCode === null) {
            holder.kill("SIGKILL");
            await new Promise((resolve) => holder!.once("exit", resolve));
        }
    });

    it("waits for another process that is writing the fresh database and ends up in WAL mode", async () => {
        holder = await holdLock(path.join(TEST_ROOT, "nexus.db"), 600);
        const started = Date.now();
        const db = initDatabase();
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        expect(tables.map((t) => t.name)).toContain("meetings");
    });

    it("gives up with the SQLite error when the lock is never released in time", async () => {
        holder = await holdLock(path.join(TEST_ROOT, "nexus.db"), 20_000);
        expect(() => initDatabase({ busyWaitMs: 300 })).toThrow(/database is locked \(gave up after \d+ ms/);
        holder.kill("SIGKILL");
        await new Promise((resolve) => holder!.once("exit", resolve));
        expect(initDatabase().pragma("journal_mode", { simple: true })).toBe("wal");
    });
});
