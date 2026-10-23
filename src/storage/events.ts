import { getDatabase } from "./sqlite.js";
import { NexusEvent } from "../types.js";

type Row = { id: number; timestamp: string; actor: string; action: string; target: string | null; detail: string | null };

function toEvent(row: Row): NexusEvent {
    return {
        id: row.id,
        timestamp: row.timestamp,
        actor: row.actor,
        action: row.action,
        target: row.target ?? undefined,
        detail: row.detail ? JSON.parse(row.detail) : undefined
    };
}

/**
 * Structured audit trail of state changes made through the daemon
 * (project synced, meeting ended, ...). Kept separate from the chat
 * streams so assistants can read conversation and activity independently.
 */
export class EventStore {
    static record(actor: string, action: string, target?: string, detail?: Record<string, unknown>): NexusEvent {
        const timestamp = new Date().toISOString();
        const result = getDatabase().prepare(
            "INSERT INTO events (timestamp, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)"
        ).run(timestamp, actor, action, target ?? null, detail ? JSON.stringify(detail) : null);
        return { id: Number(result.lastInsertRowid), timestamp, actor, action, target, detail };
    }

    /** Newest events first. `action` filters by exact action name or a `prefix.` */
    static list(limit: number, action?: string): NexusEvent[] {
        const db = getDatabase();
        const rows = (action
            // Exact comparison: LIKE folds ASCII case and treats `_` and `%` as wildcards.
            ? db.prepare("SELECT * FROM events WHERE action = ? OR substr(action, 1, length(?) + 1) = ? || '.' ORDER BY id DESC LIMIT ?")
                .all(action, action, action, limit)
            : db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)) as Row[];
        return rows.map(toEvent);
    }
}
