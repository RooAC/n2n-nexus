import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readMcpCommand } from "../src/cli/mcp-config.js";

// Runs the built CLI: beforeAll runs `npm run build` so build/ matches the sources.
const REPO = path.resolve(__dirname, "..");
const ENTRY = path.join(REPO, "build", "index.js");
const TMP = path.join(REPO, "tests", "tmp", "doctor");
const NODE = process.execPath;

let dir: string;
let claudeDir: string;
let codexHome: string;

function run(args: string[]) {
    const result = spawnSync(NODE, [ENTRY, "doctor", ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome }
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const hookCommand = (client: string, node = NODE, entry = ENTRY) => `"${node}" "${entry}" hook ${client}`;

function writeClaude(command: string, mcp?: { command: string; args: string[] }): void {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
        hooks: {
            Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }, { hooks: [{ type: "command", command, timeout: 600 }] }],
            SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }]
        }
    }));
    if (mcp) {
        fs.writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, "n2n-nexus": { type: "stdio", ...mcp } } }));
    }
}

function writeCodex(command: string, mcp?: { command: string; args: string[] }): void {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 600 }] }] } }));
    if (mcp) {
        fs.writeFileSync(path.join(codexHome, "config.toml"), [
            'model = "gpt-5"',
            "",
            "[mcp_servers.other]",
            'command = "x"',
            "",
            '[mcp_servers."n2n-nexus"]',
            `command = ${JSON.stringify(mcp.command)}`,
            `args = [${mcp.args.map((a) => JSON.stringify(a)).join(", ")}]`,
            "",
            "[projects]",
            'command = "not-ours"',
            ""
        ].join("\n"));
    }
}

beforeAll(() => {
    execSync("npm run build", { cwd: REPO, stdio: "ignore" });
}, 120_000);

beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    dir = TMP;
    claudeDir = path.join(dir, "claude");
    codexHome = path.join(dir, "codex");
    fs.mkdirSync(dir, { recursive: true });
});

afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe("doctor", () => {
    it("passes when the hook and MCP commands use a Node that exists and runs", () => {
        writeClaude(hookCommand("claude"), { command: NODE, args: [ENTRY, "mcp"] });
        writeCodex(hookCommand("codex"), { command: NODE, args: [ENTRY, "mcp"] });
        const result = run([]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`ok   hook Node ${NODE}: v${process.versions.node}`);
        expect(result.stdout).toContain(`ok   MCP Node ${NODE}: v${process.versions.node}`);
        expect(result.stdout).toContain(`ok   hook entry ${ENTRY}: ok`);
        expect(result.stdout).toContain(`ok   MCP entry ${ENTRY}: ok`);
        expect(result.stdout).not.toContain("FAIL");
        expect(result.stdout).not.toContain("fix:");
        expect(result.stdout.match(/hook Node/g)).toHaveLength(2);
    });

    it("reports a missing Node in the hooks and the MCP command and says how to fix it", () => {
        const gone = path.join(dir, "node-v22.0.0", "bin", "node");
        writeClaude(hookCommand("claude", gone), { command: gone, args: [ENTRY, "mcp"] });
        const result = run(["claude"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook Node ${gone}: missing`);
        expect(result.stdout).toContain(`FAIL MCP Node ${gone}: missing`);
        expect(result.stdout).toContain('fix: run "n2n-nexus install claude" again (add --node <path>');
    });

    it("reports a Node that does not run, an old Node, a missing entry script and warns about version directories", () => {
        const bin = path.join(dir, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, "broken"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
        fs.writeFileSync(path.join(bin, "old"), "#!/bin/sh\necho v20.1.0\n", { mode: 0o755 });
        fs.writeFileSync(path.join(bin, "noexec"), "", { mode: 0o644 });
        const versioned = path.join(dir, ".nvm", "versions", "node", "v99.0.0", "bin", "node");
        fs.mkdirSync(path.dirname(versioned), { recursive: true });
        fs.symlinkSync(NODE, versioned);

        writeCodex(hookCommand("codex", path.join(bin, "broken"), "/nowhere/build/index.js"), { command: path.join(bin, "old"), args: ["/nowhere/build/index.js", "mcp"] });
        let result = run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook Node ${path.join(bin, "broken")}: does not run`);
        expect(result.stdout).toContain("FAIL hook entry /nowhere/build/index.js: missing");
        expect(result.stdout).toContain(`FAIL MCP Node ${path.join(bin, "old")}: v20.1.0 does not satisfy ^22.14.0 || >=23.6.0`);
        expect(result.stdout).toContain('fix: run "n2n-nexus install codex" again');

        writeCodex(hookCommand("codex", path.join(bin, "noexec")), { command: versioned, args: [ENTRY, "mcp"] });
        result = run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hook Node ${path.join(bin, "noexec")}: not executable`);
        expect(result.stdout).toContain(`ok   MCP Node ${versioned}: v${process.versions.node}, in a version directory that an upgrade may remove`);
        expect(result.stdout).not.toContain("note:");

        writeCodex(hookCommand("codex", versioned), { command: versioned, args: [ENTRY, "mcp"] });
        result = run(["codex"]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('note: after upgrading Node, run "n2n-nexus install codex" again, or install with --node <path>');
    });

    it("ignores hook groups whose hooks field is not an array", () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: "oops" }, { hooks: [{ type: "command", command: hookCommand("claude") }] }] } }));
        fs.writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ mcpServers: { "n2n-nexus": { command: NODE, args: [ENTRY, "mcp"] } } }));
        expect(run(["claude"]).code).toBe(0);
    });

    it("reports what is not installed: only for a named client, and the missing half of a partial install", () => {
        expect(run([])).toEqual({ code: 0, stdout: "claude\n  not installed\ncodex\n  not installed\n", stderr: "" });
        const named = run(["codex"]);
        expect(named.code).toBe(1);
        expect(named.stdout).toContain('FAIL nothing installed: run "n2n-nexus install codex".');

        writeClaude(hookCommand("claude"));
        let result = run([]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL MCP server n2n-nexus in ${path.join(claudeDir, ".claude.json")}: not registered`);
        expect(result.stdout).toContain("codex\n  not installed");

        fs.rmSync(claudeDir, { recursive: true });
        writeCodex('"/x/node" "/x/index.js" hook claude', { command: NODE, args: [ENTRY, "mcp"] });
        result = run(["codex"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAIL hooks in ${path.join(codexHome, "hooks.json")}: not installed`);
        expect(result.stdout).toContain(`ok   MCP Node ${NODE}`);
    });

    it("rejects an unknown client and a broken settings file", () => {
        const usage = run(["cursor"]);
        expect(usage.code).toBe(1);
        expect(usage.stderr).toContain("Usage: n2n-nexus doctor [claude|codex]");

        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, "settings.json"), "{ broken");
        const result = run(["claude"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("doctor failed");
        expect(result.stderr).toContain("not valid JSON");
    });

    it("readMcpCommand parses the Claude JSON and the Codex TOML forms", () => {
        const toml = path.join(dir, "config.toml");
        fs.writeFileSync(toml, '[mcp_servers.n2n-nexus]\ncommand = "/a b/node"\nargs = ["/a b/index.js", "mcp"]\nenv = { NEXUS_ENDPOINT = "http://127.0.0.1:5799" }\n');
        expect(readMcpCommand("codex", toml)).toEqual({ command: "/a b/node", args: ["/a b/index.js", "mcp"] });
        fs.writeFileSync(toml, '[mcp_servers.other]\ncommand = "/x"\n');
        expect(readMcpCommand("codex", toml)).toBeUndefined();
        expect(readMcpCommand("codex", path.join(dir, "none.toml"))).toBeUndefined();

        const json = path.join(dir, ".claude.json");
        fs.writeFileSync(json, JSON.stringify({ mcpServers: { "n2n-nexus": { command: "/n", args: ["/e", "mcp"] } } }));
        expect(readMcpCommand("claude", json)).toEqual({ command: "/n", args: ["/e", "mcp"] });
        fs.writeFileSync(json, JSON.stringify({ mcpServers: {} }));
        expect(readMcpCommand("claude", json)).toBeUndefined();
        fs.writeFileSync(json, "nope");
        expect(() => readMcpCommand("claude", json)).toThrow("not valid JSON");
    });
});
