# Security Policy

## Supported Versions

Security fixes target the latest published version of n2n-nexus.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Report security concerns through GitHub private vulnerability reporting for this repository, or contact Datafrog through the security channel listed on the organization profile.

When reporting, include:

- A description of the vulnerability.
- Steps to reproduce or a proof of concept.
- Affected versions or commit hashes.
- Any known impact or mitigation.

We aim to acknowledge reports within 5 business days.

## Security Model

n2n-nexus runs a local HTTP daemon that stores coordination data under `~/.n2n-nexus` by default. It does not send project data to remote services.

Key boundaries to be aware of:

- **Local trust model**: Every process running as the same operating-system user is trusted. The daemon has no authentication; such a process can call it directly or read and write `nexus.db` and the client transcripts under `~/.claude` and `~/.codex`. Conversation IDs and Claude tool-use bindings route direct messages between conversations; they are not credentials, so an AI session with shell access can act as another conversation of the same user. Checks inside the daemon cannot prevent that while the data stays readable to that user. The barrier that matters is the client's permission to run commands, which the user controls. To isolate agents from each other, run them as different operating-system users, each with its own daemon and storage root.

- **Daemon network exposure**: The daemon binds to `127.0.0.1` by default. Using `--host 0.0.0.0` exposes it to your local network. There is no authentication layer in the open-source baseline — only expose the daemon beyond localhost on networks you control.
- **Browser requests**: The daemon has no authentication, so it refuses requests that carry a browser `Origin` header or a cross-site `Sec-Fetch-Site` header (403), requires `Content-Type: application/json` on POST (415) and caps request bodies at 16 MB (413). It also rejects any `Host` header that is not an IP literal, `localhost`, `host.docker.internal` or a name listed in `NEXUS_ALLOWED_HOSTS` (comma-separated), which closes DNS-rebinding attacks where a page reaches the daemon as a same-origin request under the attacker's domain. MCP adapters and scripts are unaffected.
- **Rate limiting**: Tool calls are limited per instance ID (default 20/s, burst 60, set with `NEXUS_RATE_LIMIT` / `NEXUS_RATE_BURST`) and, because instance IDs are self-declared, per client address at five times that. Requests that name no instance ID (most REST reads) are limited only per address. Over the limit the daemon answers `429` with `Retry-After`; `/health` and `GET /api/tools` are exempt.
- **Malformed requests**: Invalid request URLs or Host headers return 400 without terminating the daemon. Validly formed requests still pass through the browser and Host checks above.
- **Sensitive content in coordination data**: Project manifests, internal docs, meeting messages, and global documents are stored in plaintext on the local filesystem. Do not store secrets, credentials, or customer data in these fields.
- **Project assets**: Binary assets uploaded via `upload_project_asset` are stored under the daemon root. Treat them as local files with the same access controls.
- **API key for MCP**: The MCP adapter connects to the daemon over plain HTTP. If you expose the daemon to a remote host, consider adding a reverse proxy with TLS in front of it.
