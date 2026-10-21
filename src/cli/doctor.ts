/**
 * `n2n-nexus doctor [claude|codex]`: check that the Node path and the entry
 * script in the hook commands and in the MCP server command that `install`
 * wrote still exist and run, and say how to fix what does not. Without a
 * client both are checked; a client with nothing installed is only reported
 * when it was named. Exit code 1 when a check failed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { HOOK_CLIENTS, MCP_SERVER_NAME, isHookClient, type HookClient } from "../daemon/hook-contract.js";
import { pkg } from "../config/index.js";
import { VERSIONED_NODE_DIR, configFile, isOurs, parseVersion, readConfig, satisfiesEngines, type HookGroup } from "./install.js";
import { mcpConfigFile, readMcpCommand } from "./mcp-config.js";

type Check = { ok: boolean; text: string };

const ok = (text: string): Check => ({ ok: true, text });
const bad = (text: string): Check => ({ ok: false, text });
const VERSIONED_NOTE = "in a version directory that an upgrade may remove";

/** The Node path and the entry script of one of our hook commands, `"<node>" "<entry>" hook <client> ...`. */
export function parseHookCommand(command: string): { node: string; entry: string } | undefined {
    const m = /^"([^"]+)" "([^"]+)" hook /.exec(command);
    return m ? { node: m[1], entry: m[2] } : undefined;
}

export function checkNode(node: string): Check {
    if (!fs.existsSync(node)) return bad("missing");
    try {
        fs.accessSync(node, fs.constants.X_OK);
    } catch {
        return bad("not executable");
    }
    const probe = spawnSync(node, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const version = probe.status === 0 ? parseVersion(probe.stdout) : undefined;
    if (!version) return bad("does not run");
    const text = probe.stdout.trim();
    if (!satisfiesEngines(text)) return bad(`${text} does not satisfy ${pkg.engines.node}`);
    return ok(`${text}${VERSIONED_NODE_DIR.test(node) ? `, ${VERSIONED_NOTE}` : ""}`);
}

const checkEntry = (entry: string): Check => fs.existsSync(entry) ? ok("ok") : bad("missing");


/** Check one client; prints the report and returns whether everything passed, or undefined when nothing is installed. */
function doctorClient(client: HookClient): boolean | undefined {
    const hooksFile = configFile(client);
    const mcpFile = mcpConfigFile(client);
    const lines: string[] = [];
    let failed = false;
    let versioned = false;
    const report = (label: string, check: Check) => {
        lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${label}: ${check.text}`);
        if (!check.ok) failed = true;
        if (check.text.includes(VERSIONED_NOTE)) versioned = true;
    };

    const hooks = readConfig(hooksFile).hooks ?? {};
    const commands = new Set<string>();
    for (const groups of Object.values(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups as Array<HookGroup | null>) {
            const entries = group?.hooks;
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
                if (isOurs(entry, client)) commands.add((entry as { command: string }).command);
            }
        }
    }
    const mcp = readMcpCommand(client, mcpFile);
    if (commands.size === 0 && !mcp) return undefined;

    lines.push(`${client}`);
    if (commands.size === 0) report(`hooks in ${hooksFile}`, bad("not installed"));
    for (const command of commands) {
        const parsed = parseHookCommand(command);
        if (!parsed) {
            report(`hook command ${command}`, bad("not in the form \"<node>\" \"<entry>\" hook ..."));
            continue;
        }
        report(`hook Node ${parsed.node}`, checkNode(parsed.node));
        report(`hook entry ${parsed.entry}`, checkEntry(parsed.entry));
    }
    if (!mcp) {
        report(`MCP server ${MCP_SERVER_NAME} in ${mcpFile}`, bad("not registered"));
    } else {
        report(`MCP Node ${mcp.command}`, checkNode(mcp.command));
        const entry = mcp.args[0];
        if (entry) report(`MCP entry ${entry}`, checkEntry(entry));
        else report(`MCP command in ${mcpFile}`, bad("has no entry script argument"));
    }
    if (failed) {
        lines.push(`  fix: run "n2n-nexus install ${client}" again (add --node <path> to use a stable Node path such as /usr/local/bin/node).`);
    } else if (versioned) {
        lines.push(`  note: after upgrading Node, run "n2n-nexus install ${client}" again, or install with --node <path> pointing at a stable entry such as /usr/local/bin/node.`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return !failed;
}

/** Parse `[claude|codex]`, run the checks and return the exit code. */
export function runDoctor(argv: string[]): number {
    const client = argv[0];
    if (client !== undefined && !isHookClient(client)) {
        process.stderr.write("Usage: n2n-nexus doctor [claude|codex]\n");
        return 1;
    }
    try {
        let failed = false;
        for (const c of client ? [client] : HOOK_CLIENTS) {
            const result = doctorClient(c);
            if (result === undefined) {
                if (client) {
                    process.stdout.write(`${c}\n  FAIL nothing installed: run "n2n-nexus install ${c}".\n`);
                    failed = true;
                } else {
                    process.stdout.write(`${c}\n  not installed\n`);
                }
            } else if (!result) {
                failed = true;
            }
        }
        return failed ? 1 : 0;
    } catch (error) {
        process.stderr.write(`[n2n-nexus] doctor failed: ${(error as Error).message}\n`);
        return 1;
    }
}
