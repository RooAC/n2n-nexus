import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getDatabase } from "../src/storage/sqlite.js";
import { SessionStore, SESSION_LEASE_MS } from "../src/storage/sessions.js";
import { DirectMessageStore, DEFAULT_MESSAGE_TTL_MS } from "../src/storage/direct-messages.js";

const now = Date.parse("2026-10-20T00:00:00Z");

describe("Session directory and direct message storage", () => {
    let root: string;
    let originalRoot: string | undefined;

    beforeEach(async () => {
        closeDatabase();
        root = await mkdtemp(path.join(os.tmpdir(), "nexus-direct-storage-"));
        originalRoot = process.env.NEXUS_ROOT;
        process.env.NEXUS_ROOT = root;
    });

    afterEach(async () => {
        closeDatabase();
        if (originalRoot === undefined) delete process.env.NEXUS_ROOT;
        else process.env.NEXUS_ROOT = originalRoot;
        await rm(root, { recursive: true, force: true });
    });

    function register() {
        for (const sessionId of ["a", "b", "c"]) {
            SessionStore.register({ sessionId, instanceId: "shared-ide", workspace: "/same/project" }, now);
        }
    }

    it("upgrades an existing database without replacing old messages or cursors", () => {
        const old = new Database(path.join(root, "nexus.db"));
        old.exec(`
            CREATE TABLE global_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, text TEXT NOT NULL, category TEXT, timestamp TEXT NOT NULL);
            INSERT INTO global_messages (sender, text, timestamp) VALUES ('old-ide', 'preserved', '2026-01-01');
            CREATE TABLE read_cursors (instance_id TEXT NOT NULL, context_type TEXT NOT NULL, context_id TEXT, last_read_id INTEGER DEFAULT 0, updated_at TEXT, PRIMARY KEY (instance_id, context_type, context_id));
            INSERT INTO read_cursors VALUES ('old-ide', 'global', 'global', 1, '2026-01-01');
        `);
        old.close();
        register();
        const message = DirectMessageStore.send("a", { to: "b", message: "new" }, now);
        expect(message.status).toBe("accepted");
        expect(getDatabase().prepare("SELECT text FROM global_messages").get()).toEqual({ text: "preserved" });
        expect(getDatabase().prepare("SELECT last_read_id FROM read_cursors").get()).toEqual({ last_read_id: 1 });
    });

    it("separates same-instance connections and preserves configured metadata across heartbeats", () => {
        register();
        SessionStore.update("a", { name: "reviewer", projectId: "project", inbound: "refuse" }, now);
        SessionStore.register({ sessionId: "a", instanceId: "shared-ide", clientName: "client" }, now + 100);
        expect(SessionStore.get("a", now + 101)).toMatchObject({ name: "reviewer", projectId: "project", inbound: "refuse", clientName: "client", workspace: "/same/project", online: true, reception: "pull" });
        expect(SessionStore.list({ projectId: "project" }, now)).toHaveLength(1);
        expect(SessionStore.get("b", now + SESSION_LEASE_MS)?.online).toBe(false);
        expect(SessionStore.list({ onlineOnly: true }, now + SESSION_LEASE_MS).map(s => s.sessionId)).toEqual(["a"]);
        expect(() => SessionStore.register({ sessionId: "a", instanceId: "another" }, now)).toThrow("another instance");
        SessionStore.disconnect("a", "shared-ide");
        expect(SessionStore.get("a", now + 101)?.online).toBe(false);
        SessionStore.register({ sessionId: "a", instanceId: "shared-ide" }, now + 102);
        expect(SessionStore.get("a", now + 102)?.online).toBe(true);
    });

    it("queues offline messages only for the recipient and retries fetch until explicit acknowledgement", () => {
        register();
        SessionStore.disconnect("b", "shared-ide");
        const sent = DirectMessageStore.send("a", { to: "b", message: "please review", category: "UPDATE" }, now);
        expect(sent).toMatchObject({ status: "accepted", fetchedAt: null, acknowledgedAt: null, replyTo: null });
        expect(Date.parse(sent.expiresAt) - now).toBe(DEFAULT_MESSAGE_TTL_MS);
        expect(DirectMessageStore.readInbox("a", 10, now)).toEqual([]);
        expect(DirectMessageStore.readInbox("c", 10, now)).toEqual([]);
        expect(() => DirectMessageStore.get(sent.messageId, "c", now)).toThrow("not found");
        const first = DirectMessageStore.readInbox("b", 10, now + 1);
        expect(first[0]).toMatchObject({ messageId: sent.messageId, status: "fetched", fetchedAt: new Date(now + 1).toISOString() });
        expect(DirectMessageStore.readInbox("b", 10, now + 2)).toEqual(first);
        expect(() => DirectMessageStore.acknowledge(sent.messageId, "a", "acknowledged", now + 3)).toThrow("Only the recipient");
        const ack = DirectMessageStore.acknowledge(sent.messageId, "b", "acknowledged", now + 3);
        expect(ack.status).toBe("acknowledged");
        expect(DirectMessageStore.acknowledge(sent.messageId, "b", "acknowledged", now + 4)).toEqual(ack);
        expect(DirectMessageStore.readInbox("b", 10, now + 4)).toEqual([]);
        expect(DirectMessageStore.get(sent.messageId, "a", now + DEFAULT_MESSAGE_TTL_MS + 1).status).toBe("acknowledged");
        expect(() => DirectMessageStore.acknowledge(sent.messageId, "b", "refused", now + 4)).toThrow("status acknowledged");
    });

    it("expires unconfirmed messages and prevents revival", () => {
        register();
        const first = DirectMessageStore.send("a", { to: "b", message: "fetched", ttlMs: 10 }, now);
        DirectMessageStore.readInbox("b", 1, now + 1);
        const second = DirectMessageStore.send("a", { to: "b", message: "unfetched", ttlMs: 10 }, now);
        expect(DirectMessageStore.readInbox("b", 10, now + 10)).toEqual([]);
        for (const message of [first, second]) {
            expect(DirectMessageStore.get(message.messageId, "a", now + 10).status).toBe("expired");
            expect(() => DirectMessageStore.acknowledge(message.messageId, "b", "acknowledged", now + 10)).toThrow("expired");
            expect(() => DirectMessageStore.send("b", { to: "a", message: "late", replyTo: message.messageId }, now + 10)).toThrow("expired");
        }
    });

    it("applies refusal to pending messages and retains refusal as a terminal state", () => {
        register();
        const pending = DirectMessageStore.send("a", { to: "b", message: "pending" }, now);
        DirectMessageStore.readInbox("b", 1, now + 1);
        SessionStore.update("b", { inbound: "refuse" }, now + 2);
        expect(DirectMessageStore.get(pending.messageId, "a", now + 2)).toMatchObject({ status: "refused", reason: "recipient_refused" });
        const refused = DirectMessageStore.send("a", { to: "b", message: "blocked" }, now + 2);
        expect(refused.status).toBe("refused");
        expect(DirectMessageStore.readInbox("b", 10, now + 3)).toEqual([]);
        SessionStore.update("b", { inbound: "accept" }, now + 4);
        expect(DirectMessageStore.readInbox("b", 10, now + 5)).toEqual([]);
        expect(DirectMessageStore.get(refused.messageId, "a", now + DEFAULT_MESSAGE_TTL_MS + 100).status).toBe("refused");
    });

    it("records valid replies atomically and does not report refused replies as delivered", () => {
        register();
        const original = DirectMessageStore.send("a", { to: "b", message: "question" }, now);
        expect(() => DirectMessageStore.send("b", { to: "a", message: "not fetched", replyTo: original.messageId }, now + 1)).toThrow("accepted");
        DirectMessageStore.readInbox("b", 1, now + 1);
        expect(() => DirectMessageStore.send("b", { to: "c", message: "wrong recipient", replyTo: original.messageId }, now + 2)).toThrow("original sender");
        expect(() => DirectMessageStore.send("a", { to: "b", message: "wrong direction", replyTo: original.messageId }, now + 2)).toThrow("original sender");
        SessionStore.update("a", { inbound: "refuse" }, now + 2);
        const rejectedReply = DirectMessageStore.send("b", { to: "a", message: "blocked reply", replyTo: original.messageId }, now + 3);
        expect(rejectedReply.status).toBe("refused");
        expect(DirectMessageStore.get(original.messageId, "a", now + 3).status).toBe("fetched");
        SessionStore.update("a", { inbound: "accept" }, now + 4);
        const reply = DirectMessageStore.send("b", { to: "a", message: "answer", replyTo: original.messageId }, now + 5);
        expect(reply).toMatchObject({ status: "accepted", replyTo: original.messageId });
        expect(DirectMessageStore.get(original.messageId, "a", now + 5)).toMatchObject({ status: "replied", repliedAt: new Date(now + 5).toISOString() });
        expect(DirectMessageStore.readInbox("b", 10, now + 6)).toEqual([]);
        expect(DirectMessageStore.readInbox("a", 10, now + 6).map(m => m.messageId)).toEqual([reply.messageId]);
        expect(() => DirectMessageStore.acknowledge(original.messageId, "b", "refused", now + 6)).toThrow("replied");
    });
});
