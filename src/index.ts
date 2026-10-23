#!/usr/bin/env node
import { pkg } from "./config/index.js";

const command = process.argv[2] || "mcp";

if (command === "--version" || command === "-v") {
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
}

if (command === "--help" || command === "-h") {
    process.stdout.write(`
n2n-nexus v${pkg.version} — Multi-AI assistant coordination hub

USAGE:
  n2n-nexus mcp      Start the MCP proxy (launched by IDE automatically)
  n2n-nexus install <claude|codex> [--endpoint <url>] [--node <path>]
                     Register the hooks and the MCP server with Claude Code or Codex
  n2n-nexus uninstall <claude|codex>
                     Remove the hooks and the MCP server installed by install
  n2n-nexus doctor [claude|codex]
                     Check that the Node path and entry script in the installed hooks and
                     the Node path and npx in the MCP command exist and run, and that the
                     host answers with the same contract version; exit 1 and say how to
                     fix them when not
  n2n-nexus hook <claude|codex> [--endpoint <url>] [--wait]
                     Forward a client hook event to the host (run by the hooks)

The host is a separate program, n2n-nexus-host:
  https://github.com/n2ns/n2n-nexus/releases

OPTIONS:
  --id <id>          Instance ID for MCP proxy (default: mcp-<hostname>-<cwd hash>-<IDE name>)
  --endpoint <url>   Host URL for hook (default: NEXUS_ENDPOINT, then http://127.0.0.1:5688),
                     or "discover" to find a host on the LAN;
                     install writes it into the hook and MCP commands
  --node <path>      Node executable written into the hook and MCP commands by install
                     (default: the node on PATH when it is the running one, else its real path)
  --version, -v      Show version
  --help, -h         Show this help

ENVIRONMENT:
  NEXUS_ENDPOINT     Host URL for MCP proxy, hook and doctor (default: http://127.0.0.1:5688), or "discover"
  NEXUS_DISCOVERY_PORT  UDP port of LAN discovery (default: 5688)
  NEXUS_INSTANCE_ID  Override --id for MCP proxy
`);
    process.exit(0);
}

async function main() {
    if (command === "hook") {
        const { runHook } = await import("./cli/hook.js");
        process.exit(await runHook(process.argv.slice(3)));
    }

    if (command === "install" || command === "uninstall") {
        const { runInstallCommand } = await import("./cli/install.js");
        process.exit(runInstallCommand(command, process.argv.slice(3)));
    }

    if (command === "doctor") {
        const { runDoctor } = await import("./cli/doctor.js");
        process.exit(await runDoctor(process.argv.slice(3)));
    }

    // Default: mcp
    const { NexusServer } = await import("./server/nexus.js");
    const server = new NexusServer();
    await server.run();
}

main().catch(err => {
    console.error("[n2n-nexus] Fatal error:", err);
    process.exit(1);
});
