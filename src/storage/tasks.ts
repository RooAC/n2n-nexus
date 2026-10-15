/**
 * TaskService - Phase 2: Async Task Management
 * 
 * Manages long-running operations with progress tracking, 
 * meeting traceability, and MCP-compatible status reporting.
 */
import { getDatabase } from "./sqlite.js";
import { TASK_CLEANUP_MAX_AGE_MS } from "../constants.js";

export const TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export interface Task {
    id: string;
    status: TaskStatus;
    progress: number;  // 0.0 - 1.0
    source_meeting_id: string | null;
    metadata: Record<string, unknown>;
    result_uri: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    ttl: number | null;  // milliseconds
}

export interface CreateTaskInput {
    id?: string;
    source_meeting_id?: string;
    metadata?: Record<string, unknown>;
    ttl?: number;
}

export interface TaskUpdate {
    status?: TaskStatus;
    progress?: number;
    result_uri?: string;
    error_message?: string;
    metadata?: Record<string, unknown>;
}

// Generate unique task ID
function generateTaskId(): string {
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const random = Math.random().toString(36).substring(2, 6);
    return `task_${timestamp}_${random}`;
}


/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput = {}): Task {
    const db = getDatabase();
    const id = input.id || generateTaskId();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
        INSERT INTO tasks (id, status, progress, source_meeting_id, metadata, created_at, updated_at, ttl)
        VALUES (?, 'pending', 0.0, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        input.source_meeting_id || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
        input.ttl || null
    );

    return getTask(id)!;
}

function rowToTask(row: Record<string, unknown>): Task {
    return {
        id: row.id as string,
        status: row.status as TaskStatus,
        progress: row.progress as number,
        source_meeting_id: (row.source_meeting_id as string) || null,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
        result_uri: (row.result_uri as string) || null,
        error_message: (row.error_message as string) || null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        ttl: (row.ttl as number) || null
    };
}

/**
 * Get a task by ID
 */
export function getTask(id: string): Task | null {
    const row = getDatabase().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
}

/**
 * Update task status and progress
 */
export function updateTask(id: string, update: TaskUpdate): Task | null {
    const db = getDatabase();
    const now = new Date().toISOString();

    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (update.status !== undefined) {
        sets.push("status = ?");
        values.push(update.status);
    }
    if (update.progress !== undefined) {
        sets.push("progress = ?");
        values.push(Math.max(0, Math.min(1, update.progress)));
    }
    if (update.result_uri !== undefined) {
        sets.push("result_uri = ?");
        values.push(update.result_uri);
    }
    if (update.error_message !== undefined) {
        sets.push("error_message = ?");
        values.push(update.error_message);
    }
    if (update.metadata !== undefined) {
        sets.push("metadata = ?");
        values.push(JSON.stringify(update.metadata));
    }

    values.push(id);

    const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...values);

    return getTask(id);
}

/**
 * List tasks with optional status filter
 */
export function listTasks(status?: TaskStatus, limit: number = 50): Task[] {
    const db = getDatabase();

    let sql = "SELECT * FROM tasks";
    const params: unknown[] = [];

    if (status) {
        sql += " WHERE status = ?";
        params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToTask);
}

/**
 * Cancel a pending or running task
 */
export function cancelTask(id: string): boolean {
    const task = getTask(id);
    if (!task) return false;
    if (task.status !== "pending" && task.status !== "running") return false;

    updateTask(id, { status: "cancelled" });
    return true;
}

/**
 * Mark pending/running tasks whose TTL has elapsed as failed.
 */
export function expireTasks(now: number = Date.now()): number {
    return getDatabase().prepare(`
        UPDATE tasks
        SET status = 'failed', error_message = 'TTL expired', updated_at = ?
        WHERE status IN ('pending', 'running')
          AND ttl IS NOT NULL
          AND strftime('%s', created_at) * 1000 + ttl < ?
    `).run(new Date(now).toISOString(), now).changes;
}

/**
 * Delete completed/failed/cancelled tasks older than specified age
 */
export function cleanupTasks(maxAgeMs: number = TASK_CLEANUP_MAX_AGE_MS, now: number = Date.now()): number {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    return getDatabase().prepare(`
        DELETE FROM tasks 
        WHERE status IN ('completed', 'failed', 'cancelled') 
        AND updated_at < ?
    `).run(cutoff).changes;
}

/** Expire overdue tasks, then purge finished ones past the retention window. */
export function runTaskMaintenance(now: number = Date.now()): { expired: number; removed: number } {
    return { expired: expireTasks(now), removed: cleanupTasks(TASK_CLEANUP_MAX_AGE_MS, now) };
}
