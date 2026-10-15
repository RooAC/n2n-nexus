import { getDatabase } from "./sqlite.js";
import { DiscussionMessage, MessageCategory } from "../types.js";

type Row = { id: number; sender: string; text: string; category: MessageCategory | null; timestamp: string };

function toMessage(row: Row): DiscussionMessage & { id: number } {
    return { id: row.id, from: row.sender, text: row.text, category: row.category ?? undefined, timestamp: row.timestamp };
}

/**
 * Global (non-meeting) chat stream, stored in SQLite so appends are cheap,
 * concurrent-safe and addressable by id for per-instance unread cursors.
 */
export class GlobalMessageStore {
    static addMessage(from: string, text: string, category?: MessageCategory): DiscussionMessage & { id: number } {
        const db = getDatabase();
        const timestamp = new Date().toISOString();
        const result = db.prepare(
            "INSERT INTO global_messages (sender, text, category, timestamp) VALUES (?, ?, ?, ?)"
        ).run(from, text, category ?? null, timestamp);
        return { id: Number(result.lastInsertRowid), from, text, category, timestamp };
    }

    /** Messages this instance has not read yet, oldest first; advances the cursor. */
    static readUnread(instanceId: string, count: number): (DiscussionMessage & { id: number })[] {
        const db = getDatabase();
        const cursor = db.prepare(
            "SELECT last_read_id FROM read_cursors WHERE instance_id = ? AND context_type = 'global' AND context_id = 'global'"
        ).get(instanceId) as { last_read_id: number } | undefined;
        const lastReadId = cursor?.last_read_id ?? 0;

        const rows = db.prepare(
            "SELECT id, sender, text, category, timestamp FROM global_messages WHERE id > ? ORDER BY id ASC LIMIT ?"
        ).all(lastReadId, count) as Row[];

        if (rows.length > 0) {
            db.prepare(
                "INSERT OR REPLACE INTO read_cursors (instance_id, context_type, context_id, last_read_id, updated_at) VALUES (?, 'global', 'global', ?, ?)"
            ).run(instanceId, rows[rows.length - 1].id, new Date().toISOString());
        }
        return rows.map(toMessage);
    }

    /** Most recent messages regardless of cursor, oldest first. */
    static recent(count: number): (DiscussionMessage & { id: number })[] {
        const rows = getDatabase().prepare(
            "SELECT id, sender, text, category, timestamp FROM global_messages ORDER BY id DESC LIMIT ?"
        ).all(count) as Row[];
        return rows.reverse().map(toMessage);
    }

    static count(): number {
        return (getDatabase().prepare("SELECT COUNT(*) AS n FROM global_messages").get() as { n: number }).n;
    }

    /** Delete the oldest `count` messages. */
    static pruneOldest(count: number): number {
        if (count <= 0) return 0;
        return getDatabase().prepare(
            "DELETE FROM global_messages WHERE id IN (SELECT id FROM global_messages ORDER BY id ASC LIMIT ?)"
        ).run(count).changes;
    }

    static clear(): number {
        return getDatabase().prepare("DELETE FROM global_messages").run().changes;
    }
}
