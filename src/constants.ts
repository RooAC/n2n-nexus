/**
 * Nexus constants
 */

// Service identification
export const SERVICE_NAME = "n2n-nexus";

// Host address for binding and connecting.
// Default to localhost because the daemon exposes unauthenticated local admin APIs.
// Use "0.0.0.0" only when you intentionally expose it to another trusted environment.
export const NEXUS_HOST = "127.0.0.1";

// Default daemon port
export const NEXUS_PORT = 5688;

// HTTP request body limit for the daemon (base64 asset uploads are the largest payload)
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

// Task cleanup
export const TASK_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// File I/O
export const FILE_ENCODING = "utf-8" as const;
