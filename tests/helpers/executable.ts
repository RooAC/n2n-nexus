import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let launcherDir: string | undefined;

export const executablePath = (file: string) => process.platform === "win32" ? `${file}.exe` : file;

/** Real child-process fixtures: Node scripts on POSIX, a small native launcher on Windows. */
export function writeExecutable(file: string, source: string): string {
    const executable = executablePath(file);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(`${executable}.cjs`, source);
    if (process.platform !== "win32") {
        const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
        fs.writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(`${executable}.cjs`)} "$@"\n`, { mode: 0o755 });
        return executable;
    }
    if (!launcherDir) {
        launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-launcher-"));
        const sourceFile = path.join(launcherDir, "Launcher.cs");
        fs.writeFileSync(sourceFile, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
class Launcher {
    static string Quote(string value) {
        var quoted = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            quoted.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            quoted.Append(ch);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
    static int Main(string[] args) {
        string script = Assembly.GetExecutingAssembly().Location + ".cjs";
        var start = new ProcessStartInfo(File.ReadAllText(script + ".node"));
        start.UseShellExecute = false;
        start.Arguments = Quote(script);
        foreach (string arg in args) start.Arguments += " " + Quote(arg);
        using (var child = Process.Start(start)) {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}`);
        const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
        execFileSync(compiler, ["/nologo", `/out:${path.join(launcherDir, "launcher.exe")}`, sourceFile], { stdio: "pipe" });
    }
    fs.copyFileSync(path.join(launcherDir, "launcher.exe"), executable);
    fs.writeFileSync(`${executable}.cjs.node`, process.execPath);
    return executable;
}

export function cleanupExecutables(): void {
    if (launcherDir) fs.rmSync(launcherDir, { recursive: true, force: true });
    launcherDir = undefined;
}
