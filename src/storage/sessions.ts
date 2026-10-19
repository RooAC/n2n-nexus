import { getDatabase } from "./sqlite.js";

export const SESSION_LEASE_MS = 60_000;

export interface Session {
    sessionId: string;
    instanceId: string;
    name: string;
    clientName: string;
    workspace: string;
    projectId: string | null;
    inbound: "accept" | "refuse";
    reception: "pull";
    online: boolean;
    createdAt: string;
    lastSeenAt: string;
}

type Row = {
    session_id: string; instance_id: string; name: string; client_name: string; workspace: string;
    project_id: string | null; inbound: Session["inbound"]; connected: number; created_at: string; last_seen_at: string;
};

function toSession(row: Row, now: number): Session {
    return {
        sessionId: row.session_id, instanceId: row.instance_id, name: row.name,
        clientName: row.client_name, workspace: row.workspace, projectId: row.project_id,
        inbound: row.inbound, reception: "pull",
        online: row.connected === 1 && now - Date.parse(row.last_seen_at) < SESSION_LEASE_MS,
        createdAt: row.created_at, lastSeenAt: row.last_seen_at
    };
}

export class SessionStore {
    static register(input: { sessionId: string; instanceId: string; clientName?: string; workspace?: string }, now = Date.now()): Session {
        const db = getDatabase();
        return db.transaction(() => {
            const existing = this.get(input.sessionId, now);
            if (existing && existing.instanceId !== input.instanceId) throw new Error("Session belongs to another instance");
            const timestamp = new Date(now).toISOString();
            if (existing) {
                db.prepare("UPDATE sessions SET client_name = ?, workspace = ?, connected = 1, last_seen_at = ? WHERE session_id = ?")
                    .run(input.clientName ?? existing.clientName, input.workspace ?? existing.workspace, timestamp, input.sessionId);
            } else {
                db.prepare("INSERT INTO sessions (session_id, instance_id, name, client_name, workspace, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                    .run(input.sessionId, input.instanceId, `session-${input.sessionId.slice(0, 8)}`, input.clientName ?? "", input.workspace ?? "", timestamp, timestamp);
            }
            return this.get(input.sessionId, now)!;
        })();
    }

    static get(sessionId: string, now = Date.now()): Session | null {
        const row = getDatabase().prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Row | undefined;
        return row ? toSession(row, now) : null;
    }

    static require(sessionId: string, instanceId?: string): Session {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Unknown session: ${sessionId}`);
        if (instanceId !== undefined && session.instanceId !== instanceId) throw new Error("Session belongs to another instance");
        return session;
    }

    static list(options: { onlineOnly?: boolean; projectId?: string; limit?: number } = {}, now = Date.now()): Session[] {
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        if (options.projectId !== undefined) {
            clauses.push("project_id = ?");
            params.push(options.projectId);
        }
        if (options.onlineOnly) {
            clauses.push("connected = 1 AND last_seen_at > ?");
            params.push(new Date(now - SESSION_LEASE_MS).toISOString());
        }
        const rows = getDatabase().prepare(`SELECT * FROM sessions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY last_seen_at DESC, rowid DESC LIMIT ?`)
            .all(...params, options.limit ?? 100) as Row[];
        return rows.map(row => toSession(row, now));
    }

    static update(sessionId: string, changes: { name?: string; projectId?: string | null; inbound?: Session["inbound"] }, now = Date.now()): Session {
        const db = getDatabase();
        return db.transaction(() => {
            const existing = this.require(sessionId);
            db.prepare("UPDATE sessions SET name = ?, project_id = ?, inbound = ? WHERE session_id = ?")
                .run(changes.name ?? existing.name, changes.projectId === undefined ? existing.projectId : changes.projectId, changes.inbound ?? existing.inbound, sessionId);
            if (changes.inbound === "refuse") {
                db.prepare("UPDATE direct_messages SET status = 'expired', reason = 'Message TTL elapsed' WHERE to_session_id = ? AND status IN ('accepted', 'fetched') AND expires_at <= ?")
                    .run(sessionId, new Date(now).toISOString());
                db.prepare("UPDATE direct_messages SET status = 'refused', reason = 'recipient_refused' WHERE to_session_id = ? AND status IN ('accepted', 'fetched')")
                    .run(sessionId);
            }
            return this.get(sessionId, now)!;
        })();
    }

    static disconnect(sessionId: string, instanceId: string): void {
        this.require(sessionId, instanceId);
        getDatabase().prepare("UPDATE sessions SET connected = 0 WHERE session_id = ?").run(sessionId);
    }
}
