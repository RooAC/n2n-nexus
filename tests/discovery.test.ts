import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
    DISCOVER_ENDPOINT, LOCAL_ENDPOINT, discoverEndpoint, resolveEndpoint, startDiscoveryResponder
} from "../src/client/discovery.js";
import { NexusServer } from "../src/server/nexus.js";
import { startTestDaemon } from "./helpers/daemon.js";

// The daemon and hook cases run the built CLI: beforeAll runs `npm run build` so build/ matches the sources.
const REPO = path.resolve(__dirname, "..");
const ENTRY = path.join(REPO, "build", "index.js");
const TMP = path.join(REPO, "tests", "tmp", "discovery");
const HOME = path.join(TMP, "home");
const CACHE = path.join(HOME, ".n2n-nexus", "discovered-endpoint");
const ENDPOINT = /^http:\/\/\d+\.\d+\.\d+\.\d+:(\d+)$/;

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NEXUS_DISCOVERY_PORT: process.env.NEXUS_DISCOVERY_PORT, NEXUS_ENDPOINT: process.env.NEXUS_ENDPOINT };
let udpPort = 0;
const sockets: dgram.Socket[] = [];
const children: ChildProcess[] = [];

/** A UDP port that was free a moment ago. */
async function freeUdpPort(): Promise<number> {
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, () => resolve()));
    const { port } = socket.address();
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    return port;
}

async function responder(httpPort: number, host = "0.0.0.0"): Promise<dgram.Socket> {
    const socket = await startDiscoveryResponder(httpPort, "test", host, udpPort);
    sockets.push(socket);
    return socket;
}

const portOf = (endpoint: string | null) => Number(ENDPOINT.exec(endpoint ?? "")?.[1]);

beforeAll(() => {
    execSync("npm run build", { cwd: REPO, stdio: "ignore" });
}, 120_000);

beforeEach(async () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(HOME, { recursive: true });
    udpPort = await freeUdpPort();
    process.env.HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.NEXUS_DISCOVERY_PORT = String(udpPort);
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.close();
    for (const child of children.splice(0)) {
        if (child.exitCode === null) {
            child.kill();
            await new Promise((resolve) => child.once("exit", resolve));
        }
    }
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("discoverEndpoint", () => {
    it("finds a responder and builds the endpoint from its address and HTTP port", async () => {
        await responder(4321);
        expect(portOf(await discoverEndpoint(udpPort))).toBe(4321);
    });

    it("uses the bound address of a daemon on this machine that listens on one interface only", async () => {
        await responder(4321, "192.0.2.10");
        expect(await discoverEndpoint(udpPort)).toBe("http://192.0.2.10:4321");
    });

    it("uses loopback for a daemon on this machine that listens on all interfaces", async () => {
        await responder(4321);
        expect(await discoverEndpoint(udpPort)).toBe("http://127.0.0.1:4321");
    });

    it("gives up with null when nothing answers", async () => {
        const before = Date.now();
        expect(await discoverEndpoint(udpPort, 300)).toBeNull();
        expect(Date.now() - before).toBeLessThan(1_000);
    });
});

describe("resolveEndpoint", () => {
    it("passes any other endpoint through without a lookup", async () => {
        expect(await resolveEndpoint("http://10.0.0.5:5688")).toBe("http://10.0.0.5:5688");
        expect(fs.existsSync(CACHE)).toBe(false);
    });

    it("caches a found daemon and keeps using it until a fresh lookup", async () => {
        const socket = await responder(4321);
        const found = await resolveEndpoint(DISCOVER_ENDPOINT);
        expect(portOf(found)).toBe(4321);
        expect(fs.readFileSync(CACHE, "utf8").trim()).toBe(found);

        socket.close();
        sockets.splice(sockets.indexOf(socket), 1);
        expect(await resolveEndpoint(DISCOVER_ENDPOINT)).toBe(found);             // cached, no lookup
        expect(await resolveEndpoint(DISCOVER_ENDPOINT, { fresh: true })).toBe(LOCAL_ENDPOINT);
    });

    it("caches 'none answered' only for a minute", async () => {
        expect(await resolveEndpoint(DISCOVER_ENDPOINT)).toBe(LOCAL_ENDPOINT);
        await responder(4321);
        expect(await resolveEndpoint(DISCOVER_ENDPOINT)).toBe(LOCAL_ENDPOINT);    // still within the minute
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
        expect(portOf(await resolveEndpoint(DISCOVER_ENDPOINT))).toBe(4321);
    });
});

describe("daemon", () => {
    async function startDaemon(host: string): Promise<number> {
        const server = http.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        const port = (server.address() as AddressInfo).port;
        await new Promise<void>((resolve) => server.close(() => resolve()));

        const child = spawn(process.execPath, [ENTRY, "daemon", "--host", host, "--port", String(port)], {
            env: { ...process.env, NEXUS_HOST: "", NEXUS_ROOT: path.join(TMP, `root-${port}`) },
            stdio: ["ignore", "ignore", "pipe"]
        });
        children.push(child);
        let log = "";
        await new Promise<void>((resolve, reject) => {
            child.stderr!.on("data", (chunk) => {
                log += chunk;
                if (log.includes("listening on")) setTimeout(resolve, 200);     // the responder binds right after
            });
            child.once("exit", () => reject(new Error(`daemon exited: ${log}`)));
        });
        return port;
    }

    it("answers discovery when bound to all interfaces", async () => {
        const port = await startDaemon("0.0.0.0");
        expect(portOf(await discoverEndpoint(udpPort))).toBe(port);
    }, 15_000);

    it("stays silent when bound to loopback", async () => {
        await startDaemon("127.0.0.1");
        expect(await discoverEndpoint(udpPort, 500)).toBeNull();
    }, 15_000);
});

describe("hook with --endpoint discover", () => {
    type Fake = { port: number; hits: number; close: () => Promise<void> };
    async function fakeDaemon(): Promise<Fake> {
        const fake = { hits: 0 } as Fake;
        const server = http.createServer((req, res) => {
            req.resume();
            req.on("end", () => {
                fake.hits++;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hi" } } }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        fake.port = (server.address() as AddressInfo).port;
        fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
        return fake;
    }

    function runHook(): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [ENTRY, "hook", "claude", "--endpoint", DISCOVER_ENDPOINT], {
                env: { ...process.env, NEXUS_ENDPOINT: "" },
                stdio: ["pipe", "pipe", "ignore"]
            });
            let stdout = "";
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.on("error", reject);
            child.on("close", () => resolve(stdout));
            child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s" }));
        });
    }

    it("sends to the discovered daemon, and looks again when the cached one is gone", async () => {
        const fake = await fakeDaemon();
        try {
            await responder(fake.port);
            expect(await runHook()).toContain("hi");
            expect(fake.hits).toBe(1);
            expect(portOf(fs.readFileSync(CACHE, "utf8").trim())).toBe(fake.port);

            fs.writeFileSync(CACHE, "http://127.0.0.2:1\n");                       // a daemon that is gone
            expect(await runHook()).toContain("hi");
            expect(fake.hits).toBe(2);
            expect(portOf(fs.readFileSync(CACHE, "utf8").trim())).toBe(fake.port);
        } finally {
            await fake.close();
        }
    }, 20_000);
});

describe("MCP adapter with NEXUS_ENDPOINT=discover", () => {
    it("connects to the daemon a lookup finds", async () => {
        const daemon = await startTestDaemon("discovery-adapter");
        try {
            await responder(daemon.port);
            process.env.NEXUS_ENDPOINT = DISCOVER_ENDPOINT;
            const adapter = new NexusServer();
            const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
            await adapter.run({ transport: serverSide });
            const client = new Client({ name: "test-ide", version: "1.0" });
            await client.connect(clientSide);
            expect((await client.listTools()).tools.some((t) => t.name === "peers")).toBe(true);

            // A hook found another daemon (the cache changed): the next tool call follows it,
            // so the conversation's hooks and tool calls reach the same daemon.
            let calls = 0;
            const other = http.createServer((req, res) => {
                req.resume();
                req.on("end", () => {
                    if (req.url === "/api/tools/call") calls++;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(req.url === "/api/tools" ? { tools: [] } : { ok: true, result: { ok: true } }));
                });
            });
            await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
            try {
                fs.writeFileSync(CACHE, `http://127.0.0.1:${(other.address() as AddressInfo).port}
`);
                await client.callTool({ name: "send_message", arguments: { message: "hi" } });
                expect(calls).toBe(1);
            } finally {
                await new Promise<void>((resolve) => other.close(() => resolve()));
            }
            await client.close();
            await adapter.shutdown();
        } finally {
            await daemon.close();
        }
    }, 15_000);
});
