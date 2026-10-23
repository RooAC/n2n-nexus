import { randomUUID } from "node:crypto";
import path from "node:path";

import { getDatabase } from "./sqlite.js";
import {
    IDLE_SUBSCRIPTION_TTL_MS, MESSAGE_TTL_MS, PEER_WINDOW_MS, PREVIEW_CHARS, TOOL_USE_BINDING_TTL_MS,
    type AgentStatus, type HookClient
} from "../daemon/hook-contract.js";

/**
 * Agent sessions (one per Claude Code / Codex conversation), the direct
 * messages between them, notices for them, notifyWhenIdle subscriptions and
 * Claude's toolUseId bindings. Functions that return session ids return the
 * sessions that got a new message or notice, so the daemon can wake a Stop
 * hook that is waiting for them.
 */

export interface AgentSession {
    id: string;
    client: HookClient;
    name: string;
    note: string;
    cwd: string;
    status: AgentStatus;
    listening: boolean;
    createdAt: string;
    lastActiveAt: string;
}

export interface AgentMessage {
    id: string;
    fromId: string;
    fromName: string;
    toId: string;
    text: string;
    replyTo: string | null;
    status: "unread" | "read" | "expired";
    createdAt: string;
    expiresAt: string;
    notifiedAt: string | null;
    readAt: string | null;
}

export interface AgentNotice {
    id: number;
    sessionId: string;
    text: string;
    createdAt: string;
    notifiedAt: string | null;
}

type SessionRow = {
    id: string; client: HookClient; name: string; note: string; cwd: string; status: AgentStatus;
    listening: number; created_at: string; last_active_at: string;
};
type MessageRow = {
    id: string; from_id: string; from_name: string; to_id: string; text: string; reply_to: string | null;
    status: AgentMessage["status"]; created_at: string; expires_at: string; notified_at: string | null; read_at: string | null;
};
type NoticeRow = { id: number; session_id: string; text: string; created_at: string; notified_at: string | null };

const iso = (ms: number) => new Date(ms).toISOString();

function toSession(r: SessionRow): AgentSession {
    return {
        id: r.id, client: r.client, name: r.name, note: r.note, cwd: r.cwd, status: r.status,
        listening: r.listening === 1, createdAt: r.created_at, lastActiveAt: r.last_active_at
    };
}

function toMessage(r: MessageRow): AgentMessage {
    return {
        id: r.id, fromId: r.from_id, fromName: r.from_name, toId: r.to_id, text: r.text, replyTo: r.reply_to,
        status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, notifiedAt: r.notified_at, readAt: r.read_at
    };
}

function toNotice(r: NoticeRow): AgentNotice {
    return { id: r.id, sessionId: r.session_id, text: r.text, createdAt: r.created_at, notifiedAt: r.notified_at };
}

/** First line of a message, cut to PREVIEW_CHARS. */
export function messagePreview(text: string): string {
    return text.split(/\r?\n/, 1)[0].slice(0, PREVIEW_CHARS);
}

const MESSAGE_SELECT = `
    SELECT m.id, m.from_id, s.name AS from_name, m.to_id, m.text, m.reply_to, m.status,
           m.created_at, m.expires_at, m.notified_at, m.read_at
    FROM agent_messages m JOIN agent_sessions s ON s.id = m.from_id`;

export class AgentStore {
    static get(id: string): AgentSession | null {
        const row = getDatabase().prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as SessionRow | undefined;
        return row ? toSession(row) : null;
    }

    /** Whether a session other than `exceptId` that is not offline uses `name`. */
    static nameTaken(name: string, exceptId: string): boolean {
        return getDatabase().prepare(
            "SELECT 1 FROM agent_sessions WHERE name = ? AND id != ? AND status != 'offline' LIMIT 1"
        ).get(name, exceptId) !== undefined;
    }

    /** `base`, or `base#N` with the smallest N >= 2 that no other non-offline session uses. */
    private static freeName(base: string, exceptId: string): string {
        const rows = getDatabase().prepare(
            "SELECT name FROM agent_sessions WHERE id != ? AND status != 'offline'"
        ).all(exceptId) as { name: string }[];
        const taken = new Set(rows.map(r => r.name));
        if (!taken.has(base)) return base;
        for (let n = 2; ; n++) {
            const candidate = `${base}#${n}`;
            if (!taken.has(candidate)) return candidate;
        }
    }

    /**
     * Create the session if it does not exist (named `<client>@<cwd basename>`)
     * and refresh its last activity time.
     */
    static touch(id: string, client: HookClient, cwd: string, now = Date.now()): AgentSession {
        const db = getDatabase();
        return db.transaction(() => {
            const at = iso(now);
            if (this.get(id)) {
                db.prepare("UPDATE agent_sessions SET last_active_at = ? WHERE id = ?").run(at, id);
            } else {
                const name = this.freeName(`${client}@${path.basename(cwd) || "session"}`, id);
                db.prepare(
                    "INSERT INTO agent_sessions (id, client, name, note, cwd, status, listening, created_at, last_active_at) VALUES (?, ?, ?, '', ?, 'idle', 0, ?, ?)"
                ).run(id, client, name, cwd, at, at);
            }
            return this.get(id)!;
        })();
    }

    /** Refresh the last activity time of an existing session. */
    static refresh(id: string, now = Date.now()): void {
        getDatabase().prepare("UPDATE agent_sessions SET last_active_at = ? WHERE id = ?").run(iso(now), id);
    }

    /**
     * Set the status. A session coming back from offline whose name another
     * non-offline session now uses gets a numbered name.
     */
    static setStatus(id: string, status: AgentStatus): void {
        const db = getDatabase();
        db.transaction(() => {
            const current = this.get(id);
            if (!current) return;
            if (current.status === "offline" && status !== "offline" && this.nameTaken(current.name, id)) {
                const name = this.freeName(current.name.replace(/#\d+$/, ""), id);
                db.prepare("UPDATE agent_sessions SET name = ? WHERE id = ?").run(name, id);
            }
            db.prepare("UPDATE agent_sessions SET status = ? WHERE id = ?").run(status, id);
        })();
    }

    /** Set the status only when it is still `expected`; returns whether it changed. */
    static setStatusIf(id: string, expected: AgentStatus, status: AgentStatus): boolean {
        return getDatabase().prepare("UPDATE agent_sessions SET status = ? WHERE id = ? AND status = ?")
            .run(status, id, expected).changes > 0;
    }

    static setListening(id: string, on: boolean): void {
        getDatabase().prepare("UPDATE agent_sessions SET listening = ? WHERE id = ?").run(on ? 1 : 0, id);
    }

    /** Update name and/or note. Throws when the name is used by another non-offline session. */
    static updateProfile(id: string, profile: { name?: string; note?: string }): AgentSession {
        const db = getDatabase();
        return db.transaction(() => {
            if (profile.name !== undefined) {
                if (this.nameTaken(profile.name, id)) throw new Error(`Name '${profile.name}' is already used by another session.`);
                db.prepare("UPDATE agent_sessions SET name = ? WHERE id = ?").run(profile.name, id);
            }
            if (profile.note !== undefined) db.prepare("UPDATE agent_sessions SET note = ? WHERE id = ?").run(profile.note, id);
            return this.get(id)!;
        })();
    }

    /** A session by exact id (any status), else a non-offline session by name. */
    static findRecipient(to: string): AgentSession | null {
        const byId = this.get(to);
        if (byId) return byId;
        const row = getDatabase().prepare(
            "SELECT * FROM agent_sessions WHERE name = ? AND status != 'offline' ORDER BY last_active_at DESC LIMIT 1"
        ).get(to) as SessionRow | undefined;
        return row ? toSession(row) : null;
    }

    /** At daemon start no wait is held for any session: listening ones become idle, so they can go stale. */
    static resetListening(): void {
        getDatabase().prepare("UPDATE agent_sessions SET status = 'idle' WHERE status = 'listening'").run();
    }

    /** Set idle and working sessions without activity since `before` offline; returns how many changed. */
    static expireStale(before: number): number {
        return getDatabase().prepare(
            "UPDATE agent_sessions SET status = 'offline' WHERE status IN ('idle', 'working') AND last_active_at < ?"
        ).run(iso(before)).changes;
    }

    /** Other sessions that are not offline or were active within PEER_WINDOW_MS, most recent first. */
    static listPeers(selfId: string, now = Date.now()): AgentSession[] {
        const rows = getDatabase().prepare(
            "SELECT * FROM agent_sessions WHERE id != ? AND (status != 'offline' OR last_active_at > ?) ORDER BY last_active_at DESC"
        ).all(selfId, iso(now - PEER_WINDOW_MS)) as SessionRow[];
        return rows.map(toSession);
    }

    static addMessage(fromId: string, toId: string, text: string, replyTo: string | null, now = Date.now()): string {
        const id = randomUUID();
        getDatabase().prepare(
            "INSERT INTO agent_messages (id, from_id, to_id, text, reply_to, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'unread', ?, ?)"
        ).run(id, fromId, toId, text, replyTo, iso(now), iso(now + MESSAGE_TTL_MS));
        return id;
    }

    static getMessage(id: string): AgentMessage | null {
        const row = getDatabase().prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
        return row ? toMessage(row) : null;
    }

    /** Unread messages for a session, oldest first; `freshOnly` keeps those not notified yet. */
    static unread(toId: string, freshOnly = false): AgentMessage[] {
        const rows = getDatabase().prepare(
            `${MESSAGE_SELECT} WHERE m.to_id = ? AND m.status = 'unread'${freshOnly ? " AND m.notified_at IS NULL" : ""} ORDER BY m.created_at, m.rowid`
        ).all(toId) as MessageRow[];
        return rows.map(toMessage);
    }

    /** Notices not delivered by a hook yet, oldest first. */
    static pendingNotices(sessionId: string): AgentNotice[] {
        const rows = getDatabase().prepare(
            "SELECT * FROM agent_notices WHERE session_id = ? AND notified_at IS NULL ORDER BY id"
        ).all(sessionId) as NoticeRow[];
        return rows.map(toNotice);
    }

    static addNotice(sessionId: string, text: string, now = Date.now()): void {
        getDatabase().prepare("INSERT INTO agent_notices (session_id, text, created_at) VALUES (?, ?, ?)")
            .run(sessionId, text, iso(now));
    }

    /** Mark messages (those not notified yet) and notices as notified. */
    static markNotified(messageIds: string[], noticeIds: number[], now = Date.now()): void {
        const db = getDatabase();
        const at = iso(now);
        const msg = db.prepare("UPDATE agent_messages SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
        const notice = db.prepare("UPDATE agent_notices SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
        db.transaction(() => {
            for (const id of messageIds) msg.run(at, id);
            for (const id of noticeIds) notice.run(at, id);
        })();
    }

    /** Oldest `count` unread messages, marked read; `remaining` is the unread count left. */
    static readUnread(toId: string, count: number, now = Date.now()): { messages: AgentMessage[]; remaining: number } {
        const db = getDatabase();
        return db.transaction(() => {
            const messages = this.unread(toId).slice(0, count);
            const at = iso(now);
            const mark = db.prepare(
                "UPDATE agent_messages SET status = 'read', read_at = ?, notified_at = COALESCE(notified_at, ?) WHERE id = ?"
            );
            for (const m of messages) mark.run(at, at, m.id);
            const { n } = db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_id = ? AND status = 'unread'")
                .get(toId) as { n: number };
            return { messages, remaining: n };
        })();
    }

    /** One-shot notifyWhenIdle subscription; repeating it restarts its lifetime. */
    static subscribeIdle(subscriberId: string, targetId: string, now = Date.now()): void {
        getDatabase().prepare(
            "INSERT OR REPLACE INTO agent_idle_subscriptions (subscriber_id, target_id, created_at) VALUES (?, ?, ?)"
        ).run(subscriberId, targetId, iso(now));
    }

    /**
     * The target finished its turn or went offline: give every live subscriber
     * a notice and drop all subscriptions on the target. Returns the notified subscribers.
     */
    static fireIdle(targetId: string, event: "idle" | "offline", now = Date.now()): string[] {
        const db = getDatabase();
        return db.transaction(() => {
            const target = this.get(targetId);
            if (!target) return [];
            const subscribers = (db.prepare(
                "SELECT subscriber_id FROM agent_idle_subscriptions WHERE target_id = ? AND created_at > ?"
            ).all(targetId, iso(now - IDLE_SUBSCRIPTION_TTL_MS)) as { subscriber_id: string }[]).map(r => r.subscriber_id);
            const text = event === "idle"
                ? `${target.name} (${target.id}) finished its turn.`
                : `${target.name} (${target.id}) went offline.`;
            for (const subscriber of subscribers) this.addNotice(subscriber, text, now);
            db.prepare("DELETE FROM agent_idle_subscriptions WHERE target_id = ?").run(targetId);
            return subscribers;
        })();
    }

    /** Expire unread messages past expires_at and tell their senders. Returns the notified senders. */
    static expireMessages(now = Date.now()): string[] {
        const db = getDatabase();
        return db.transaction(() => {
            const at = iso(now);
            const rows = db.prepare(`
                SELECT m.id, m.from_id, m.to_id, m.text, s.name AS to_name
                FROM agent_messages m JOIN agent_sessions s ON s.id = m.to_id
                WHERE m.status = 'unread' AND m.expires_at <= ?`
            ).all(at) as { id: string; from_id: string; to_id: string; text: string; to_name: string }[];
            const expire = db.prepare("UPDATE agent_messages SET status = 'expired' WHERE id = ?");
            for (const r of rows) {
                expire.run(r.id);
                this.addNotice(r.from_id, `Your message to ${r.to_name} (${r.to_id}) expired unread: "${messagePreview(r.text)}"`, now);
            }
            return [...new Set(rows.map(r => r.from_id))];
        })();
    }

    static bindToolUse(toolUseId: string, sessionId: string, now = Date.now()): void {
        getDatabase().prepare(
            "INSERT OR REPLACE INTO tool_use_bindings (tool_use_id, session_id, created_at) VALUES (?, ?, ?)"
        ).run(toolUseId, sessionId, iso(now));
    }

    /** Session bound to a toolUseId within TOOL_USE_BINDING_TTL_MS; expired bindings are removed. */
    static resolveToolUse(toolUseId: string, now = Date.now()): string | null {
        const db = getDatabase();
        const cutoff = iso(now - TOOL_USE_BINDING_TTL_MS);
        db.prepare("DELETE FROM tool_use_bindings WHERE created_at <= ?").run(cutoff);
        const row = db.prepare("SELECT session_id FROM tool_use_bindings WHERE tool_use_id = ? AND created_at > ?")
            .get(toolUseId, cutoff) as { session_id: string } | undefined;
        return row?.session_id ?? null;
    }
}
