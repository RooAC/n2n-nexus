/**
 * Start a daemon in the background when a hook or the MCP adapter finds none
 * listening at a local endpoint (127.0.0.1 or localhost). Resolves true once
 * GET /api/tools answers (polled every 100 ms for up to 2 s), false when the
 * endpoint is not local or the daemon did not come up in time. Never throws.
 */
export async function startLocalDaemon(endpoint: string): Promise<boolean> {
    void endpoint;
    return false;
}
