import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readMcpCommand } from "../src/cli/mcp-config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-mcp-config-"));
const file = path.join(dir, "config.toml");

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("readMcpCommand Codex TOML", () => {
    it("reads Windows literal strings without interpreting backslashes", () => {
        fs.writeFileSync(file, String.raw`[mcp_servers.n2n-nexus]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\James\n2n-nexus\build\index.js', 'mcp']
`);
        expect(readMcpCommand("codex", file)).toEqual({
            command: String.raw`C:\Program Files\nodejs\node.exe`,
            args: [String.raw`C:\Users\James\n2n-nexus\build\index.js`, "mcp"]
        });
    });

    it("reads multiline arguments, mixed quotes and comments inside the target table", () => {
        fs.writeFileSync(file, String.raw`[mcp_servers.'n2n-nexus'] # installed by Codex
command = 'C:\Program Files\nodejs\node.exe'
args = [
    'C:\Users\James\[nexus]#tools\index.js', # "ignore this"
    "mcp", # a closing ] in a comment
]
[mcp_servers.other]
command = "other"
args = ["other.js"]
`);
        expect(readMcpCommand("codex", file)).toEqual({
            command: String.raw`C:\Program Files\nodejs\node.exe`,
            args: [String.raw`C:\Users\James\[nexus]#tools\index.js`, "mcp"]
        });
    });

    it("continues to decode basic strings and stops at the next table", () => {
        fs.writeFileSync(file, String.raw`[mcp_servers."n2n-nexus"]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\nexus\\index.js", "mcp"]
[projects]
command = "other"
args = ["other.js"]
`);
        expect(readMcpCommand("codex", file)).toEqual({
            command: String.raw`C:\Program Files\nodejs\node.exe`,
            args: [String.raw`C:\nexus\index.js`, "mcp"]
        });
    });
});
