#!/usr/bin/env node
// Runs the TypeScript daemon (build/index.js) under the conformance harness's command line:
//   ts-host.mjs serve --host H --port P --root R [--test-listen-wait-ms N]
// The daemon runs in this process, so the PID the harness kills and signals is the daemon's own.
// Temporary: removed together with the TypeScript daemon.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 2) flags[rest[i]] = rest[i + 1];
const known = ["--host", "--port", "--root", "--test-listen-wait-ms"];
if (command !== "serve" || Object.keys(flags).some((k) => !known.includes(k)) || Object.values(flags).some((v) => v === undefined)) {
    console.error("usage: ts-host.mjs serve [--host <addr>] [--port <port>] [--root <dir>] [--test-listen-wait-ms <ms>]");
    process.exit(2);
}

if (flags["--root"]) process.env.NEXUS_ROOT = flags["--root"];
if (flags["--test-listen-wait-ms"]) process.env.NEXUS_TEST_LISTEN_WAIT_MS = flags["--test-listen-wait-ms"];

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "build", "index.js");
const daemonArgs = ["daemon"];
if (flags["--host"]) daemonArgs.push("--host", flags["--host"]);
if (flags["--port"]) daemonArgs.push("--port", flags["--port"]);
// build/index.js reads its command and options from process.argv when it loads.
process.argv = [process.argv[0], entry, ...daemonArgs];
await import(pathToFileURL(entry).href);
