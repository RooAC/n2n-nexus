import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// Tests the built CLI: beforeAll runs `npm run build` so build/ matches the sources.
const REPO = path.resolve(__dirname, "..");
const ENTRY = path.join(REPO, "build", "index.js");
const TMP = path.join(REPO, "tests", "tmp", "hook-cli");

type RunResult = { code: number | null; stdout: string; stderr: string; ms: number };

function runHook(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}, cwd?: string): Promise<RunResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY, "hook", ...args], {
            cwd,
            env: { ...process.env, NEXUS_ENDPOINT: "", ...env },
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
        child.stdin.end(stdin);
    });
}

type FakeDaemon = {
    endpoint: string;
    requests: Array<{ url: string; body: unknown }>;
    respond: (body: Record<string, unknown>) => { delayMs?: number; raw: string };
    close: () => Promise<void>;
};

async function startFakeDaemon(): Promise<FakeDaemon> {
    const fake: Partial<FakeDaemon> = { requests: [], respond: () => ({ raw: JSON.stringify({ output: null }) }) };
    const sockets = new Set<net.Socket>();
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, unknown>;
            fake.requests!.push({ url: req.url ?? "", body });
            const reply = fake.respond!(body);
            setTimeout(() => {
                if (res.destroyed) return;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(reply.raw);
            }, reply.delayMs ?? 0);
        });
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fake.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fake.close = () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    });
    return fake as FakeDaemon;
}

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

async function toolsAnswer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/tools`, { timeout: 1000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => req.destroy());
    });
}

/** PID of the process listening on a port (the daemon this test started). */
function listenerPid(port: number): number | undefined {
    let pid: number | undefined;
    if (process.platform === "win32") {
        const out = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], { encoding: "utf8" });
        const line = out.split("\n").find((line) => {
            const fields = line.trim().split(/\s+/);
            return fields[1] === `127.0.0.1:${port}` && fields[3] === "LISTENING";
        });
        pid = line ? Number(line.trim().split(/\s+/)[4]) : undefined;
    } else {
        pid = posixListenerPid(port);
    }
    if (!pid) return undefined;
    try {
        if (process.platform === "win32") {
            return windowsDaemonPids(port, "ProcessId", pid).includes(pid) ? pid : undefined;
        }
        const command = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
        const entry = ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|\\s)"?${entry}"?\\s+daemon\\s+--port\\s+${port}(?:\\s|$)`).test(command) ? pid : undefined;
    } catch {
        return undefined;
    }
}

/** `ss` (Linux), else `lsof` (macOS has no ss). */
function posixListenerPid(port: number): number | undefined {
    try {
        const out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const match = /pid=(\d+)/.exec(out);
        return match ? Number(match[1]) : undefined;
    } catch {
        try {
            const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
            return Number(out.trim().split("\n")[0]) || undefined;
        } catch {
            return undefined;                          // lsof exits 1 when nothing listens
        }
    }
}

function windowsDaemonPids(port: number, selector: "ParentId" | "ProcessId", pid: number): number[] {
    const out = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", path.join(REPO, "tests", "helpers", "hook-processes.ps1"),
        `-${selector}`, String(pid), "-Entry", ENTRY, "-Port", String(port)
    ], { encoding: "utf8" });
    return out.trim() ? out.trim().split(/\s+/).map(Number) : [];
}

/** PIDs of this test process's own children running `daemon --port <port>`. */
function ownDaemonChildren(port: number): number[] {
    let out: string;
    try {
        if (process.platform === "win32") {
            return windowsDaemonPids(port, "ParentId", process.pid);
        }
        // -A and -o pid=,ppid=,args= mean the same to GNU and BSD (macOS) ps; --ppid is GNU only.
        out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
    } catch {
        return [];
    }
    return out.split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => Number(fields[1]) === process.pid && fields.slice(2).join(" ").includes(`daemon --port ${port}`))
        .map((fields) => Number(fields[0]));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

const started: number[] = [];
const startedPorts: number[] = [];
async function stopStarted(): Promise<void> {
    for (const port of startedPorts.splice(0)) {
        started.push(...ownDaemonChildren(port));
        const pid = listenerPid(port);
        if (pid) started.push(pid);
    }
    for (const pid of new Set(started.splice(0))) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        expect(await waitFor(() => !isAlive(pid), 5000)).toBe(true);
    }
}

beforeAll(() => {
    execSync("npm run build", { cwd: REPO, stdio: "ignore" });
}, 120_000);

afterAll(async () => {
    await stopStarted();
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("n2n-nexus hook, forwarding", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });

    it("forwards only the contract fields and prints the output as one JSON line", async () => {
        const output = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "[n2n-nexus] 1 unread" } };
        fake.respond = () => ({ raw: JSON.stringify({ output }) });
        const stdin = {
            hook_event_name: "PostToolUse", session_id: "s1", cwd: "/work", tool_use_id: "t1", tool_name: "Bash",
            transcript_path: "/tmp/t.jsonl", tool_input: { command: "ls" }, tool_response: { stdout: "x".repeat(10_000) }
        };
        const result = await runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify(stdin));

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(JSON.stringify(output) + "\n");
        expect(fake.requests).toEqual([{
            url: "/api/hook",
            body: { client: "claude", input: { hook_event_name: "PostToolUse", session_id: "s1", cwd: "/work", tool_use_id: "t1", tool_name: "Bash" } }
        }]);
    });

    it("forwards Stop and SessionEnd fields for codex", async () => {
        await runHook(["codex", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "c1", stop_hook_active: true, last_assistant_message: "hi" }));
        await runHook(["codex", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "SessionEnd", session_id: "c1", reason: "exit", source: "x" }));
        expect(fake.requests.map((r) => r.body)).toEqual([
            { client: "codex", input: { hook_event_name: "Stop", session_id: "c1", stop_hook_active: true } },
            { client: "codex", input: { hook_event_name: "SessionEnd", session_id: "c1", source: "x", reason: "exit" } }
        ]);
    });

    it("prints nothing when the output is null", async () => {
        const result = await runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(fake.requests).toHaveLength(1);
    });

    it("prefers --endpoint over NEXUS_ENDPOINT and falls back to NEXUS_ENDPOINT", async () => {
        const stdin = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s" });
        await runHook(["claude", "--endpoint", fake.endpoint], stdin, { NEXUS_ENDPOINT: "http://127.0.0.2:1" });
        expect(fake.requests).toHaveLength(1);
        await runHook(["claude"], stdin, { NEXUS_ENDPOINT: fake.endpoint });
        expect(fake.requests).toHaveLength(2);
    });

    it("waits past the short timeout for Stop but gives up on other events", async () => {
        const output = { decision: "block", reason: "[n2n-nexus] new message" };
        fake.respond = () => ({ delayMs: 6_000, raw: JSON.stringify({ output }) });
        const [stop, post] = await Promise.all([
            runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s" })),
            runHook(["claude", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s" }))
        ]);
        expect(stop).toMatchObject({ code: 0, stdout: JSON.stringify(output) + "\n" });
        expect(stop.ms).toBeGreaterThanOrEqual(6_000);
        expect(post).toMatchObject({ code: 0, stdout: "" });
        expect(post.ms).toBeLessThan(6_000);
    }, 20_000);

    it("stays silent on bad input, a bad client argument and a malformed response", async () => {
        const event = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s" });
        const cases: RunResult[] = [];
        cases.push(await runHook(["claude", "--endpoint", fake.endpoint], "not json"));
        cases.push(await runHook(["claude", "--endpoint", fake.endpoint], "[1,2]"));
        cases.push(await runHook(["cursor", "--endpoint", fake.endpoint], event));
        cases.push(await runHook(["--endpoint", fake.endpoint], event));
        expect(fake.requests).toHaveLength(0);

        for (const raw of ["not json", JSON.stringify({ output: "text" }), JSON.stringify({ nope: 1 }), JSON.stringify({ output: [1] })]) {
            fake.respond = () => ({ raw });
            cases.push(await runHook(["claude", "--endpoint", fake.endpoint], event));
        }
        for (const result of cases) {
            expect(result.code).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr.trim().split("\n")).toHaveLength(1);
        }
    }, 20_000);
});

describe("n2n-nexus hook --wait", () => {
    let fake: FakeDaemon;
    beforeEach(async () => { fake = await startFakeDaemon(); });
    afterEach(async () => { await fake.close(); });
    const waitRequest = (sessionId: string) => ({ url: "/api/hook", body: { client: expect.any(String), input: { hook_event_name: "BackgroundWait", session_id: sessionId } } });

    it("claude: asks again after a timeout, then exits 2 with the notification on stderr", async () => {
        let n = 0;
        fake.respond = () => ({ raw: JSON.stringify({ output: ++n === 1 ? { timeout: true } : { wake: "[n2n-nexus] 1 new direct message" } }) });
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }));
        expect(result).toMatchObject({ code: 2, stdout: "" });
        expect(result.stderr).toBe("[n2n-nexus] 1 new direct message\n");
        expect(fake.requests).toEqual([waitRequest("s1"), waitRequest("s1")]);
    });

    it("claude: exits 0 without output when the session became active", async () => {
        const result = await runHook(["claude", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }));
        expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(fake.requests).toHaveLength(1);
    });

    it("codex: returns at once and leaves a detached wait running for the session", async () => {
        fake.respond = () => ({ delayMs: 500, raw: JSON.stringify({ output: null }) });
        const result = await runHook(["codex", "--wait", "--endpoint", fake.endpoint], JSON.stringify({ hook_event_name: "Stop", session_id: "c1" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(await waitFor(() => fake.requests.length === 1, 5000)).toBe(true);
        expect(fake.requests[0]).toEqual(waitRequest("c1"));
        expect(result.ms).toBeLessThan(3000);
    });

    it("codex: hands the notification to codex queue for the session", async () => {
        const dir = path.join(TMP, "codex-queue");
        fs.mkdirSync(dir, { recursive: true });
        const record = path.join(dir, "queued.json");
        fs.rmSync(record, { force: true });
        // NEXUS_CODEX_COMMAND=node runs ./queue (the first argument) from the working directory, which records its arguments
        // (an ES module: the repository's package.json sets "type": "module").
        fs.writeFileSync(path.join(dir, "queue"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
        fake.respond = () => ({ raw: JSON.stringify({ output: { wake: "hello from nexus" } }) });
        const result = await runHook(
            ["codex", "--wait", "--session", "c1", "--endpoint", fake.endpoint], "",
            { NEXUS_CODEX_COMMAND: process.execPath }, dir
        );
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["--thread", "c1", "--message", "hello from nexus"]);
    });
});

describe("n2n-nexus hook, no daemon", () => {
    afterEach(stopStarted);

    it("exits 0 without output when a non-local daemon is unreachable", async () => {
        const result = await runHook(["claude", "--endpoint", "http://127.0.0.2:1"], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.ms).toBeLessThan(1_500);
    });

    it("never starts a local daemon: it says on stderr how to start one", async () => {
        const port = await freePort();
        const result = await runHook(["claude", "--endpoint", `http://127.0.0.1:${port}`], JSON.stringify({ hook_event_name: "SessionStart", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.stderr).toContain(`No daemon at http://127.0.0.1:${port}`);
        expect(result.stderr).toContain("n2n-nexus install host");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(await toolsAnswer(port)).toBe(false);
    }, 15_000);

    // A LAN address of this machine refuses like a remote host would; the hint must not say to start a daemon here.
    const lanAddress = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    it.runIf(lanAddress)("says to start the daemon on that machine when a non-loopback endpoint refuses", async () => {
        const port = await freePort();
        const endpoint = `http://${lanAddress}:${port}`;
        const result = await runHook(["claude", "--endpoint", endpoint], JSON.stringify({ hook_event_name: "SessionStart", session_id: "x" }));
        expect(result).toMatchObject({ code: 0, stdout: "" });
        expect(result.stderr).toContain(`No daemon at ${endpoint}`);
        expect(result.stderr).toContain("on that machine");
        expect(result.stderr).not.toContain("(a service that starts at boot)");
    }, 15_000);
});

describe("daemons started at the same time", () => {
    afterEach(stopStarted);

    /** Start daemons on `ports` from this process (so they are our children) with an isolated home and storage root; resolves once one answers on each port. */
    async function startConcurrently(home: string, ports: number[]): Promise<void> {
        const logDir = path.join(home, ".n2n-nexus");
        fs.mkdirSync(logDir, { recursive: true });
        startedPorts.push(...ports);
        for (const port of ports) {
            const log = fs.openSync(path.join(logDir, "daemon.log"), "a");
            spawn(process.execPath, [ENTRY, "daemon", "--port", String(port)], {
                env: { ...process.env, HOME: home, USERPROFILE: home, NEXUS_ROOT: path.join(home, "root"), NEXUS_HOST: "" },
                stdio: ["ignore", log, log]
            });
            fs.closeSync(log);
        }
        for (const port of new Set(ports)) {
            const deadline = Date.now() + 5000;
            while (!await toolsAnswer(port) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    const readLog = (home: string) => {
        const file = path.join(home, ".n2n-nexus", "daemon.log");
        return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    };

    it("leaves one serving daemon when two start on the same port", async () => {
        const home = path.join(TMP, "race-home");
        fs.rmSync(home, { recursive: true, force: true });

        // Initialise the storage root first, so both racers reach listen().
        const setupPort = await freePort();
        await startConcurrently(home, [setupPort]);
        await stopStarted();
        fs.rmSync(path.join(home, ".n2n-nexus"), { recursive: true, force: true });

        const port = await freePort();
        await startConcurrently(home, [port, port]);
        // The loser exits on EADDRINUSE, the winner keeps serving.
        expect(await waitFor(() => readLog(home).includes("EADDRINUSE"), 5000)).toBe(true);
        expect(readLog(home).match(/listening on/g)).toHaveLength(1);
        expect(await waitFor(() => ownDaemonChildren(port).length === 1, 5000)).toBe(true);
        expect(ownDaemonChildren(port)).toEqual([listenerPid(port)]);
        expect(await toolsAnswer(port)).toBe(true);
    }, 20_000);

    it("leaves one serving daemon when two race on a fresh storage root", async () => {
        const home = path.join(TMP, "race-fresh-home");
        fs.rmSync(home, { recursive: true, force: true });
        const port = await freePort();
        await startConcurrently(home, [port, port]);

        expect(await waitFor(() => (readLog(home).match(/Fatal error/g) ?? []).length === 1, 5000)).toBe(true);
        // The loser gets as far as listen(): storage initialisation tolerates a concurrent first start.
        expect(readLog(home)).toContain("EADDRINUSE");
        expect(readLog(home)).not.toContain("SqliteError");
        expect(readLog(home).match(/listening on/g)).toHaveLength(1);
        expect(await waitFor(() => ownDaemonChildren(port).length === 1, 5000)).toBe(true);
        expect(ownDaemonChildren(port)).toEqual([listenerPid(port)]);
        expect(await toolsAnswer(port)).toBe(true);
    }, 15_000);
});
