/**
 * Contract shared by the daemon, the MCP adapter and the `n2n-nexus hook` /
 * `install` commands. Types and constants only: the hook command imports this
 * on every client event, so it must not pull in zod, SQLite or the MCP SDK.
 * The values come from contract/hook.json, which the Go host embeds too.
 *
 * Identity: every Claude Code / Codex conversation is one agent session with
 * id `<client>:<client session id>`. Hooks create and update sessions; tool
 * calls name their session through a {@link Caller} built from the MCP
 * request's `_meta`, never from model-supplied arguments.
 */

import fs from "node:fs";

/** contract/hook.json, next to src/ and build/ in the package. */
const contract = JSON.parse(fs.readFileSync(new URL("../../contract/hook.json", import.meta.url), "utf8"));

export const CONTRACT_VERSION: number = contract.contractVersion;

export const HOOK_CLIENTS = contract.clients as readonly ["claude", "codex"];
export type HookClient = typeof HOOK_CLIENTS[number];

export function isHookClient(value: unknown): value is HookClient {
    return typeof value === "string" && (HOOK_CLIENTS as readonly string[]).includes(value);
}

/** Agent session id for a client conversation. */
export function agentSessionId(client: HookClient, clientSessionId: string): string {
    return `${client}:${clientSessionId}`;
}

/**
 * Who is calling a tool, as the adapter read it from the MCP request.
 * Claude Code: `_meta["claudecode/toolUseId"]`, bound to a session by the
 * PreToolUse hook that ran just before the call. Codex: `_meta.sessionId`
 * (a sub-agent carries its parent's session id).
 */
export type Caller =
    | { client: "claude"; toolUseId: string }
    | { client: "codex"; sessionId: string };

/** MCP clientInfo names the adapter maps to a hook client. */
export const CLIENT_INFO_NAMES: Record<HookClient, string> = contract.clientInfoNames;
export const CLAUDE_TOOL_USE_META_KEY: string = contract.meta.claudeToolUseKey;
export const CODEX_SESSION_META_KEY: string = contract.meta.codexSessionKey;

/**
 * Hook stdin fields the daemon uses. The hook command forwards only these:
 * PostToolUse stdin also carries the whole tool input and response, which can
 * be large and runs on every tool call.
 */
export const HOOK_INPUT_FIELDS: readonly string[] = contract.hookInputFields;

/** POST /api/hook request: the HOOK_INPUT_FIELDS present in the hook's stdin JSON. */
export type HookRequest = { client: HookClient; input: Record<string, unknown> };
/** POST /api/hook response: `output` is printed to stdout as JSON; null prints nothing. */
export type HookResponse = { output: Record<string, unknown> | null };

/**
 * Pseudo hook event of the background wait (`n2n-nexus hook <client> --wait`):
 * started when a turn ends, it waits up to LISTEN_WAIT_MS and returns
 * `{ wake: text }` when something new arrives for the session, `{ timeout: true }`
 * when the time runs out (the client asks again), or null when the session
 * became active again (the client stops). Claude delivers the text
 * through an asyncRewake hook, Codex through `codex queue`.
 */
export const BACKGROUND_WAIT_EVENT: string = contract.backgroundWaitEvent;

/** Longest a Stop hook waits for messages while listening. */
export const LISTEN_WAIT_MS: number = contract.timing.listenWaitMs;
/** HTTP timeout of the hook command: Stop may wait LISTEN_WAIT_MS, every other event is quick. */
export const HOOK_STOP_REQUEST_TIMEOUT_MS: number = contract.timing.hookStopRequestTimeoutMs;
export const HOOK_REQUEST_TIMEOUT_MS: number = contract.timing.hookRequestTimeoutMs;
/** `timeout` (seconds) written into the client hook configuration. */
export const HOOK_STOP_TIMEOUT_SEC: number = contract.timing.hookStopTimeoutSec;
/**
 * Default limit on automatic turns: wakes, listening Stop hooks and Stops held
 * open for messages since the user last prompted (NEXUS_MAX_AUTO_TURNS; 0 = no
 * limit). Past it, messages wait unannounced until the user prompts, so two
 * sessions cannot keep waking each other forever.
 */
export const DEFAULT_MAX_AUTO_TURNS: number = contract.limits.defaultMaxAutoTurns;
/** A prompt this soon after a wake is the woken turn starting, not the user, and keeps the count. */
export const WAKE_PROMPT_WINDOW_MS: number = contract.timing.wakePromptWindowMs;
/** `timeout` (seconds) of the background wait hook; a conversation idle for longer is not woken. */
export const WAIT_HOOK_TIMEOUT_SEC: number = contract.timing.waitHookTimeoutSec;
export const HOOK_TIMEOUT_SEC: number = contract.timing.hookTimeoutSec;

/** Name the MCP server is installed under; Claude's PreToolUse matcher depends on it. */
export const MCP_SERVER_NAME: string = contract.mcpServerName;
export const CLAUDE_PRE_TOOL_MATCHER = `mcp__${MCP_SERVER_NAME}__.*`;

/** How long a Claude toolUseId → session binding stays resolvable. */
export const TOOL_USE_BINDING_TTL_MS: number = contract.timing.toolUseBindingTtlMs;
/** Unread direct messages expire after this long. */
export const MESSAGE_TTL_MS: number = contract.timing.messageTtlMs;
/** notifyWhenIdle subscriptions lapse after this long. */
export const IDLE_SUBSCRIPTION_TTL_MS: number = contract.timing.idleSubscriptionTtlMs;
/** peers with includeOffline also lists offline sessions active within this window. */
export const PEER_WINDOW_MS: number = contract.timing.peerWindowMs;

export const AGENT_STATUSES = contract.agentStatuses as readonly ["working", "idle", "listening", "offline"];
export type AgentStatus = typeof AGENT_STATUSES[number];

export const MAX_MESSAGE_CHARS: number = contract.limits.maxMessageChars;
export const MAX_NOTE_CHARS: number = contract.limits.maxNoteChars;
export const SESSION_NAME_PATTERN = new RegExp(contract.limits.sessionNamePattern);
/** Notifications preview at most this many characters of a message's first line. */
export const PREVIEW_CHARS: number = contract.limits.previewChars;
/** A prompt notification lists at most this many messages individually. */
export const NOTIFY_LIST_LIMIT: number = contract.limits.notifyListLimit;

export const NOTICE_PREFIX: string = contract.texts.noticePrefix;
/** Closing line of a notification shown when the client sends a prompt or a tool returns. */
export const NOTIFY_CLOSING: string = contract.texts.notifyClosing;
/** Closing line when the notification continues a turn that was about to end (Stop). */
export const STOP_CLOSING: string = contract.texts.stopClosing;
/**
 * An idle or working session without activity for this long counts as offline:
 * clients do not always send SessionEnd (Codex threads that finish or close).
 * Any later event brings it back.
 */
export const STALE_SESSION_MS: number = contract.timing.staleSessionMs;
/** What the statuses mean for a message, in the SessionStart introduction. */
export const STATUS_NOTE: string = contract.texts.statusNote;
/** Closing line of the SessionStart introduction. */
export const SESSION_START_CLOSING: string = contract.texts.sessionStartClosing;
export const MESSAGE_TRUST_NOTE: string = contract.texts.messageTrustNote;

/** What to do when no daemon answers at a loopback endpoint: clients never start one themselves. */
export const NO_DAEMON_HINT = "Start it with \"n2n-nexus install host\" (a service that starts at boot) or \"n2n-nexus daemon\".";
/** The same for another machine's endpoint: a daemon started here would not be the one asked for. */
export const NO_REMOTE_DAEMON_HINT =
    "The daemon at that address is not reachable; it must be started on that machine (\"n2n-nexus install host --host <address>\" or \"n2n-nexus daemon --host <address>\" there).";

/** NO_DAEMON_HINT for a loopback endpoint (127.x, localhost, ::1), else NO_REMOTE_DAEMON_HINT. */
export function noDaemonHint(endpoint: string): string {
    let host: string;
    try {
        host = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`).hostname;
    } catch {
        return NO_DAEMON_HINT;              // a mistyped endpoint: the request itself reports it
    }
    const loopback = host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
    return loopback ? NO_DAEMON_HINT : NO_REMOTE_DAEMON_HINT;
}

/** Error text when a direct-messaging tool cannot resolve its caller. */
export const NO_AGENT_SESSION_ERROR: string = contract.texts.noAgentSessionError;
