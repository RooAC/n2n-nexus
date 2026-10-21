import Database from "better-sqlite3";
import { NexusPaths } from "./paths.js";

let db: Database.Database | null = null;

/**
 * SQLite Database Schema for Nexus Meetings
 */
const SCHEMA = `
-- Meetings table
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT CHECK(status IN ('active', 'closed', 'archived')) DEFAULT 'active',
    initiator TEXT,
    participants TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    closed_at TEXT,
    summary TEXT
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK(category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- Decisions table (extracted from DECISION messages)
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- Meeting state (Key-Value store)
CREATE TABLE IF NOT EXISTS meeting_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_decisions_meeting ON decisions(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

-- Global (non-meeting) chat stream
CREATE TABLE IF NOT EXISTS global_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK(category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL
);

-- Audit trail of state changes made through the daemon
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_action ON events(action);

-- Tasks managed by assistants
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')) DEFAULT 'pending',
    progress REAL DEFAULT 0.0 CHECK(progress >= 0.0 AND progress <= 1.0),
    source_meeting_id TEXT,
    metadata TEXT,
    result_uri TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ttl INTEGER,
    FOREIGN KEY (source_meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(source_meeting_id);
-- updateTask sets updated_at itself in ISO 8601; the old trigger overwrote it
-- with datetime('now') in a different format, breaking timestamp comparisons.
DROP TRIGGER IF EXISTS tasks_updated_at;

-- Read cursors table (tracks each IDE's last read message per context)
CREATE TABLE IF NOT EXISTS read_cursors (
    instance_id TEXT NOT NULL,
    context_type TEXT NOT NULL CHECK(context_type IN ('meeting', 'global')),
    context_id TEXT,
    last_read_id INTEGER DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (instance_id, context_type, context_id)
);

-- Agent sessions: one per Claude Code / Codex conversation, created by hooks.
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK(client IN ('claude', 'codex')),
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('working', 'idle', 'listening', 'offline')),
    listening INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_name ON agent_sessions(name);

-- Direct messages between agent sessions.
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES agent_sessions(id),
    to_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    reply_to TEXT REFERENCES agent_messages(id),
    status TEXT NOT NULL CHECK(status IN ('unread', 'read', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    notified_at TEXT,
    read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox ON agent_messages(to_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_expiry ON agent_messages(status, expires_at);

-- Notices for a session (idle subscriptions, expired messages), delivered by hooks.
CREATE TABLE IF NOT EXISTS agent_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_notices_pending ON agent_notices(session_id, notified_at);

-- One-shot "tell me when the target finishes its turn" subscriptions.
CREATE TABLE IF NOT EXISTS agent_idle_subscriptions (
    subscriber_id TEXT NOT NULL REFERENCES agent_sessions(id),
    target_id TEXT NOT NULL REFERENCES agent_sessions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_idle_target ON agent_idle_subscriptions(target_id);

-- Claude toolUseId -> session, written by the PreToolUse hook.
CREATE TABLE IF NOT EXISTS tool_use_bindings (
    tool_use_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_use_bindings_created ON tool_use_bindings(created_at);
`;

/**
 * Get the database file path
 */
export function getDbPath(): string {
    return NexusPaths.dbFile;
}

/** Longest a first start waits for another process that is initialising the same database. */
const INIT_BUSY_WAIT_MS = 10_000;
const INIT_RETRY_DELAY_MS = 50;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isBusy = (error: unknown) => (error as { code?: string } | null)?.code === "SQLITE_BUSY";

/**
 * Open the database, switch it to WAL and create the schema. Throws SQLITE_BUSY
 * (from the pragma or the schema statements) while another process is writing.
 */
function openDatabase(dbPath: string): Database.Database {
    const candidate = new Database(dbPath);
    try {
        // WAL for better concurrent access. The pragma answers with the mode in effect;
        // anything but "wal" (an in-memory database, a VFS without shared memory) would
        // leave the daemon in rollback-journal mode, which the startup race cannot survive.
        const mode = candidate.pragma("journal_mode = WAL", { simple: true });
        if (mode !== "wal") throw new Error(`WAL mode is not available for ${dbPath}: journal_mode stayed "${mode}".`);
        candidate.pragma("foreign_keys = ON");
        candidate.exec(SCHEMA);
        return candidate;
    } catch (error) {
        candidate.close();
        throw error;
    }
}

/**
 * Initialize the SQLite database with WAL mode.
 *
 * Two daemons starting on a fresh root reach this together. SQLite answers the
 * second one with SQLITE_BUSY at once (not through the busy timeout) while the
 * first holds its write lock in rollback-journal mode, so the open is retried
 * until the other process has finished; no retry starts after `busyWaitMs`.
 */
export function initDatabase(options: { busyWaitMs?: number } = {}): Database.Database {
    if (db) return db;

    const dbPath = getDbPath();
    const started = Date.now();
    const deadline = started + (options.busyWaitMs ?? INIT_BUSY_WAIT_MS);
    let opened: Database.Database;
    for (;;) {
        try {
            opened = openDatabase(dbPath);
            break;
        } catch (error) {
            if (!isBusy(error)) throw error;
            if (Date.now() >= deadline) {
                (error as Error).message += ` (gave up after ${Date.now() - started} ms waiting for another process initialising ${dbPath})`;
                throw error;
            }
            sleepSync(INIT_RETRY_DELAY_MS);
        }
    }
    db = opened;

    // Migration: Add initiator column if it doesn't exist (Upgrade from v0.1.7)
    try {
        const columns = db.prepare("PRAGMA table_info(meetings)").all() as Record<string, unknown>[];
        const hasInitiator = columns.some(c => c.name === "initiator");
        if (!hasInitiator) {
            console.error("[Nexus] Migrating database: Adding 'initiator' column to 'meetings' table.");
            db.exec("ALTER TABLE meetings ADD COLUMN initiator TEXT");
        }
    } catch (e) {
        console.error("[Nexus] Migration check failed:", e);
    }

    // Migration: Convert task timestamps written by the pre-0.6.0 trigger and
    // column defaults (datetime('now'), 'YYYY-MM-DD HH:MM:SS') to ISO 8601, so
    // string comparisons against new Date().toISOString() order correctly.
    try {
        for (const column of ["created_at", "updated_at"]) {
            const { changes } = db.prepare(
                `UPDATE tasks SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) WHERE ${column} NOT LIKE '%T%'`
            ).run();
            if (changes > 0) {
                console.error(`[Nexus] Migrating database: Converted ${changes} 'tasks.${column}' value(s) to ISO 8601.`);
            }
        }
    } catch (e) {
        console.error("[Nexus] Migration check failed:", e);
    }

    // Initialize default state if not exists
    const stmt = db.prepare("INSERT OR IGNORE INTO meeting_state (key, value) VALUES (?, ?)");
    stmt.run("active_meetings", "[]");
    stmt.run("default_meeting", "");

    console.error("[Nexus] SQLite database initialized at:", dbPath);

    return db;
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
    if (!db) {
        return initDatabase();
    }
    return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.error("[Nexus] SQLite database closed");
    }
}
