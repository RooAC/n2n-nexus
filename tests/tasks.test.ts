import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createTask, updateTask, getTask, cancelTask, runTaskMaintenance } from "../src/storage/tasks.js";
import { closeDatabase, initDatabase, getDatabase } from "../src/storage/sqlite.js";
import { TASK_CLEANUP_MAX_AGE_MS } from "../src/constants.js";

const TEST_ROOT = path.join(process.cwd(), "tests", "tmp", "tasks");
const HOUR = 60 * 60 * 1000;

describe("Task lifecycle", () => {
    beforeEach(async () => {
        closeDatabase();
        await fs.rm(TEST_ROOT, { recursive: true, force: true });
        await fs.mkdir(TEST_ROOT, { recursive: true });
        process.env.NEXUS_ROOT = TEST_ROOT;
        initDatabase();
    });
    afterEach(() => closeDatabase());

    it("cancels only pending or running tasks", () => {
        const task = createTask({ metadata: { kind: "demo" } });
        expect(cancelTask(task.id)).toBe(true);
        expect(getTask(task.id)?.status).toBe("cancelled");
        expect(cancelTask(task.id)).toBe(false);
        expect(cancelTask("missing")).toBe(false);
    });

    it("marks tasks past their TTL as failed and purges old finished tasks", () => {
        const now = Date.now();
        const overdue = createTask({ ttl: 1000 });
        const fresh = createTask({ ttl: HOUR });
        const noTtl = createTask();
        const old = createTask();
        updateTask(old.id, { status: "completed" });
        getDatabase().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
            .run(new Date(now - TASK_CLEANUP_MAX_AGE_MS - HOUR).toISOString(), old.id);

        const result = runTaskMaintenance(now + 5000);
        expect(result).toEqual({ expired: 1, removed: 1 });
        expect(getTask(overdue.id)).toMatchObject({ status: "failed", error_message: "TTL expired" });
        expect(getTask(fresh.id)?.status).toBe("pending");
        expect(getTask(noTtl.id)?.status).toBe("pending");
        expect(getTask(old.id)).toBeNull();
    });
});
