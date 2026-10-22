/**
 * Where Claude Code and Codex keep their MCP server registrations, and how to
 * read the n2n-nexus entry: `~/.claude.json` (user scope) and
 * `$CODEX_HOME/config.toml`. `claude mcp get` is not used for this because it
 * looks in every scope, not only the user scope that install writes to, and
 * it starts the server for a health check.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MCP_SERVER_NAME, type HookClient } from "../daemon/hook-contract.js";

/** Where the client keeps the MCP server command. */
export function mcpConfigFile(client: HookClient): string {
    if (client === "claude") {
        return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
    }
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

export type McpCommand = { command: string; args: string[] };

/** The MCP server command the client has for n2n-nexus, or undefined when not registered. */
export function readMcpCommand(client: HookClient, file: string): McpCommand | undefined {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    if (client === "claude") {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new Error(`${file} is not valid JSON (${(error as Error).message}).`, { cause: error });
        }
        const servers = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
        const server = servers?.[MCP_SERVER_NAME] as { command?: unknown; args?: unknown } | undefined;
        if (!server || typeof server.command !== "string") return undefined;
        return { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [] };
    }
    // Codex: a TOML table [mcp_servers.n2n-nexus] (the key may be quoted) with command and args.
    const lines = text.split("\n");
    const start = lines.findIndex((line) => new RegExp(`^\\s*\\[mcp_servers\\.(["']?)${MCP_SERVER_NAME}\\1\\]\\s*(?:#.*)?$`).test(line));
    if (start === -1) return undefined;
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/.test(line)) break;
        body.push(line);
    }
    const table = body.join("\n");
    const value = String.raw`"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'`;
    const decode = (s: string): string => s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s) as string;
    const command = new RegExp(`^\\s*command\\s*=\\s*(${value})`, "m").exec(table);
    if (!command) return undefined;
    // Treat strings and comments as whole tokens so brackets and quotes inside them are not syntax.
    const array = new RegExp(`^\\s*args\\s*=\\s*\\[((?:${value}|#[^\\n]*|[^\\]"'#])*)\\]`, "m").exec(table);
    const args = array ? [...array[1].matchAll(new RegExp(`(${value})|#[^\\n]*`, "g"))]
        .filter((m) => m[1] !== undefined).map((m) => decode(m[1])) : [];
    return { command: decode(command[1]), args };
}
