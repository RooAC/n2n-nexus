import { randomUUID } from "node:crypto";
import { MessageCategory } from "../types.js";
import { SessionStore } from "./sessions.js";
import { getDatabase } from "./sqlite.js";

export const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DirectMessage {
    messageId: string;
    from: string;
    to: string;
    text: string;
    category?: MessageCategory;
    replyTo: string | null;
    status: "accepted" | "fetched" | "acknowledged" | "replied" | "refused" | "expired";
    createdAt: string;
    expiresAt: string;
    fetchedAt: string | null;
    acknowledgedAt: string | null;
    repliedAt: string | null;
    reason: string | null;
}

type Row = {
    message_id: string; from_session_id: string; to_session_id: string; text: string; category: MessageCategory | null;
    reply_to: string | null; status: DirectMessage["status"]; created_at: string; expires_at: string;
    fetched_at: string | null; acknowledged_at: string | null; replied_at: string | null; reason: string | null;
};

function toMessage(row: Row): DirectMessage {
    return {
        messageId: row.message_id, from: row.from_session_id, to: row.to_session_id,
        text: row.text, category: row.category ?? undefined, replyTo: row.reply_to, status: row.status,
        createdAt: row.created_at, expiresAt: row.expires_at, fetchedAt: row.fetched_at,
        acknowledgedAt: row.acknowledged_at, repliedAt: row.replied_at, reason: row.reason
    };
}

function expire(now: number): void {
    getDatabase().prepare("UPDATE direct_messages SET status = 'expired', reason = 'Message TTL elapsed' WHERE status IN ('accepted', 'fetched') AND expires_at <= ?")
        .run(new Date(now).toISOString());
}

export class DirectMessageStore {
    static send(fromSessionId: string, input: { to: string; message: string; category?: MessageCategory; replyTo?: string; ttlMs?: number }, now = Date.now()): DirectMessage {
        SessionStore.require(fromSessionId);
        const ttlMs = input.ttlMs ?? DEFAULT_MESSAGE_TTL_MS;
        if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive integer");
        const db = getDatabase();
        expire(now);
        return db.transaction(() => {
            const recipient = SessionStore.require(input.to);
            if (input.replyTo) {
                const original = this.get(input.replyTo, fromSessionId, now);
                if (original.to !== fromSessionId || original.from !== input.to) throw new Error("Reply must target the original sender");
                if (!["fetched", "acknowledged", "replied"].includes(original.status)) throw new Error(`Cannot reply to a message with status ${original.status}`);
            }
            const messageId = randomUUID();
            const timestamp = new Date(now).toISOString();
            const status = recipient.inbound === "refuse" ? "refused" : "accepted";
            db.prepare("INSERT INTO direct_messages (message_id, from_session_id, to_session_id, text, category, reply_to, status, created_at, expires_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .run(messageId, fromSessionId, input.to, input.message, input.category ?? null, input.replyTo ?? null, status, timestamp, new Date(now + ttlMs).toISOString(), status === "refused" ? "Recipient refuses incoming messages" : null);
            if (input.replyTo && status === "accepted") {
                db.prepare("UPDATE direct_messages SET status = 'replied', replied_at = COALESCE(replied_at, ?) WHERE message_id = ?")
                    .run(timestamp, input.replyTo);
            }
            return this.get(messageId, fromSessionId, now);
        })();
    }

    static readInbox(sessionId: string, count: number, now = Date.now()): DirectMessage[] {
        SessionStore.require(sessionId);
        const db = getDatabase();
        return db.transaction(() => {
            expire(now);
            const rows = db.prepare("SELECT * FROM direct_messages WHERE to_session_id = ? AND status IN ('accepted', 'fetched') ORDER BY created_at ASC, rowid ASC LIMIT ?")
                .all(sessionId, count) as Row[];
            const timestamp = new Date(now).toISOString();
            const update = db.prepare("UPDATE direct_messages SET status = 'fetched', fetched_at = ? WHERE message_id = ? AND status = 'accepted'");
            return rows.map(row => {
                if (row.status === "accepted") {
                    update.run(timestamp, row.message_id);
                    row.status = "fetched";
                    row.fetched_at = timestamp;
                }
                return toMessage(row);
            });
        })();
    }

    static get(messageId: string, actorSessionId: string, now = Date.now()): DirectMessage {
        expire(now);
        const row = getDatabase().prepare("SELECT * FROM direct_messages WHERE message_id = ? AND (from_session_id = ? OR to_session_id = ?)")
            .get(messageId, actorSessionId, actorSessionId) as Row | undefined;
        if (!row) throw new Error("Message not found for this session");
        return toMessage(row);
    }

    static acknowledge(messageId: string, recipientSessionId: string, outcome: "acknowledged" | "refused", now = Date.now()): DirectMessage {
        const db = getDatabase();
        expire(now);
        return db.transaction(() => {
            const message = this.get(messageId, recipientSessionId, now);
            if (message.to !== recipientSessionId) throw new Error("Only the recipient can acknowledge a message");
            if (message.status === outcome) return message;
            if (message.status !== "fetched") throw new Error(`Cannot ${outcome === "acknowledged" ? "acknowledge" : "refuse"} a message with status ${message.status}`);
            db.prepare("UPDATE direct_messages SET status = ?, acknowledged_at = ?, reason = ? WHERE message_id = ?")
                .run(outcome, outcome === "acknowledged" ? new Date(now).toISOString() : null, outcome === "refused" ? "Recipient refused message" : null, messageId);
            return this.get(messageId, recipientSessionId, now);
        })();
    }
}
