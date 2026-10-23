import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// npm installs claude and codex on Windows as .cmd shims, which Node cannot start without a shell.
// The platform is set before the modules under test (and cross-spawn) load, then the real
// child_process.spawnSync records the launches instead of running them.
const savedPlatform = vi.hoisted(() => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    return saved;
});

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
const realSpawnSync = childProcess.spawnSync;
let launches: Array<{ command: string; args: string[] }> = [];
let dir: string;

beforeEach(() => {
    launches = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-win-spawn-"));
    vi.stubEnv("CODEX_HOME", dir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    vi.stubEnv("NEXUS_CODEX_COMMAND", "");
    vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[], options: object) => {
        if (command !== (process.env.comspec || "cmd.exe") && command !== "codex" && command !== "claude") return realSpawnSync(command, args, options);
        launches.push({ command, args });
        return { pid: 1, status: 0, signal: null, output: [], stdout: "", stderr: "" };
    }) as typeof childProcess.spawnSync);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
    Object.defineProperty(process, "platform", savedPlatform);
});

/** The command line cmd.exe runs for a launch (`/d /s /c "<line>"`), or undefined when it was not run through cmd. */
const cmdLine = (launch: { command: string; args: string[] }) =>
    launch.command === (process.env.comspec || "cmd.exe") && launch.args.slice(0, 3).join(" ") === "/d /s /c" ? launch.args[3] : undefined;

describe("Windows .cmd shims", () => {
    it("install runs claude --version and claude mcp through cmd.exe", async () => {
        const { runInstall } = await import("../src/cli/install.js");
        const entry = path.join(dir, "index.js");
        expect(runInstall({ action: "install", client: "claude", node: process.execPath, entry })).toBe(0);
        const lines = launches.map(cmdLine);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/^"claude \^"--version\^""$/);
        expect(lines[1]).toContain(`claude ^"mcp^" ^"remove^"`);
        expect(lines[2]).toContain(`claude ^"mcp^" ^"add^"`);
    });

    it("the background wait hands the notification to codex queue through cmd.exe, with the text escaped", async () => {
        const { runHook } = await import("../src/cli/hook.js");
        const server = http.createServer((req, res) => {
            req.resume();
            req.on("end", () => res.end(JSON.stringify({ output: { wake: `hi "you" & del %TEMP%` } })));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            expect(await runHook(["codex", "--wait", "--session", "c1", "--endpoint", endpoint])).toBe(0);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        expect(launches).toHaveLength(1);
        const line = cmdLine(launches[0]);
        expect(line).toContain(`codex ^"queue^" ^"--thread^" ^"c1^" ^"--message^"`);
        // cmd metacharacters in the message are escaped, so they reach codex as text.
        expect(line).toContain(String.raw`^"hi^ \^"you\^"^ ^&^ del^ ^%TEMP^%^"`);
    });
});
