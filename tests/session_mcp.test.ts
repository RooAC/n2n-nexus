import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { NexusServer } from "../src/server/nexus.js";
import type { DirectMessage } from "../src/storage/direct-messages.js";
import type { Session } from "../src/storage/sessions.js";
import { startTestDaemon, type DaemonHarness } from "./helpers/daemon.js";

for (const stateless of [false, true]) {
    describe(`Direct-message MCP flow, ${stateless ? "2026-07-28" : "2025-11-25"}`, () => {
        let daemon: DaemonHarness;
        const connections: { client: Client; proxy: NexusServer }[] = [];
        beforeEach(async () => {
            daemon = await startTestDaemon("session-mcp");
            process.env.NEXUS_ENDPOINT = `http://127.0.0.1:${daemon.port}`;
            process.env.NEXUS_INSTANCE_ID = "shared-project-ide";
        });
        afterEach(async () => {
            for (const { client, proxy } of connections.splice(0)) {
                await client.close();
                await proxy.shutdown();
            }
            await daemon.close();
        });

        async function connect() {
            const proxy = new NexusServer();
            const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
            await proxy.run({ transport: serverSide });
            const client = new Client({ name: "Shared IDE", version: "1" }, stateless ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
            connections.push({ client, proxy });
            await client.connect(clientSide);
            await client.listTools();
            return client;
        }

        async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            return result.structuredContent as T;
        }

        it("isolates inboxes and completes accepted, fetched, acknowledged and replied receipts", async () => {
            const a = await connect();
            const b = await connect();
            const directoryA = await call<{ self: Session; sessions: Session[] }>(a, "list_sessions");
            const directoryB = await call<{ self: Session }>(b, "list_sessions");
            const idA = directoryA.self.sessionId;
            const idB = directoryB.self.sessionId;
            expect(idA).not.toBe(idB);
            expect(directoryA.self.instanceId).toBe(directoryB.self.instanceId);
            expect(directoryA.sessions.map((s) => s.sessionId).sort()).toEqual([idA, idB].sort());

            await call(b, "update_session", { name: "Reviewer" });
            const sent = await call<{ messageId: string; status: string }>(a, "send_message", { to: idB, message: "Please review the change." });
            expect(sent.status).toBe("accepted");
            // A model-supplied identity cannot redirect read_inbox to the other connection.
            const ownInbox = await call<{ messages: DirectMessage[] }>(a, "read_inbox", { sessionId: idB, instanceId: "spoofed" });
            expect(ownInbox.messages).toEqual([]);
            const inbox = await call<{ messages: DirectMessage[] }>(b, "read_inbox");
            expect(inbox.messages).toHaveLength(1);
            expect(inbox.messages[0]).toMatchObject({ messageId: sent.messageId, from: idA, to: idB, status: "fetched" });
            expect((await call<{ message: DirectMessage }>(a, "get_message", { messageId: sent.messageId })).message.status).toBe("fetched");
            expect((await call<{ messages: DirectMessage[] }>(b, "read_inbox")).messages).toHaveLength(1);

            await call(b, "acknowledge_message", { messageId: sent.messageId });
            expect((await call<{ message: DirectMessage }>(a, "get_message", { messageId: sent.messageId })).message.status).toBe("acknowledged");
            expect((await call<{ messages: DirectMessage[] }>(b, "read_inbox")).messages).toEqual([]);
            const reply = await call<{ messageId: string }>(b, "send_message", { to: idA, replyTo: sent.messageId, message: "Review complete." });
            expect((await call<{ message: DirectMessage }>(a, "get_message", { messageId: sent.messageId })).message.status).toBe("replied");
            expect((await call<{ messages: DirectMessage[] }>(a, "read_inbox")).messages[0]).toMatchObject({ messageId: reply.messageId, from: idB, to: idA, replyTo: sent.messageId });
            expect((await call<{ self: Session }>(b, "list_sessions")).self.name).toBe("Reviewer");

            await b.close();
            await connections[1].proxy.shutdown();
            const offline = await call<{ sessions: Session[] }>(a, "list_sessions", { onlineOnly: false });
            expect(offline.sessions.find((s) => s.sessionId === idB)?.online).toBe(false);
        });
    });
}
