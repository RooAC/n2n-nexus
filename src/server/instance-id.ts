import { createHash } from "node:crypto";
import os from "node:os";

/**
 * Identity of this MCP adapter as seen by the daemon. Read cursors, session
 * context and meeting initiator permissions are keyed on it, so it has to
 * survive an IDE restart: derive it from the machine, the workspace the IDE
 * launched the adapter in and the IDE itself (two IDEs open on the same
 * workspace must not share cursors), unless the user pins one explicitly.
 */
export function resolveInstanceId(
    env: NodeJS.ProcessEnv = process.env,
    argv: string[] = process.argv,
    cwd: string = process.cwd(),
    clientName?: string
): string {
    if (env.NEXUS_INSTANCE_ID) return env.NEXUS_INSTANCE_ID;
    const idx = argv.indexOf("--id");
    if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
    const digest = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
    const client = clientName ? `-${clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)}` : "";
    return `mcp-${os.hostname()}-${digest}${client}`;
}
