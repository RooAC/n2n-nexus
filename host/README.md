# n2n-nexus-host

The host of n2n-nexus: one Go executable that owns all coordination data and serves the HTTP protocol in [`contract/`](../contract/README.md) to the `n2n-nexus` npm client (MCP adapter and hooks). See the [README](../README.md) for using it and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the design.

## Install

| Platform | Install |
| --- | --- |
| Windows (Scoop) | `scoop bucket add n2ns https://github.com/n2ns/scoop-bucket`, then `scoop install n2ns/n2n-nexus-host` |
| Windows (winget) | coming soon |
| macOS (Homebrew) | `brew install n2ns/tap/n2n-nexus-host` (built from source) |
| Linux, or any platform by hand | `n2n-nexus-host_<version>_<os>_<arch>.tar.gz` / `.zip` from [Releases](https://github.com/n2ns/n2n-nexus/releases) (tags `host-v<version>`) |

Verify a downloaded archive:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify n2n-nexus-host_<version>_<os>_<arch>.tar.gz --repo n2ns/n2n-nexus
```

Then run `n2n-nexus-host` (tray) or `n2n-nexus-host service install` (boot service, elevated / sudo). `n2n-nexus-host help` lists the commands.

The binaries are not code-signed yet: on Windows the first start may show a SmartScreen warning (**More info → Run anyway**); Homebrew builds from source, so macOS shows no Gatekeeper prompt. Signing is planned in [TODO.md](../TODO.md).

## Layout

The Go module is `github.com/n2ns/n2n-nexus` at the repository root (`go.mod` there), so the host can embed `contract/` (`contract/contract.go`).

```
host/
├── cmd/n2n-nexus-host/   command line: tray (default), serve, service, autostart, version
├── internal/             config, protocol, store (+ migrations/), core, agents, api,
│                         discovery, host, tray, service, clock, testhooks
└── release/render.mjs    renders the Homebrew formula, Scoop manifest and winget manifests of a release
```

## Build and run

Requires the Go version in `go.mod`.

```bash
go build -o host/bin/ ./host/cmd/n2n-nexus-host     # host/bin/ is git-ignored

# Foreground, no tray; a scratch data directory and port
go run ./host/cmd/n2n-nexus-host serve --port 5799 --root /tmp/x
```

`serve` logs to standard error; the first line `<version> listening on http://<addr>` tells the address (`--port 0` picks a free port). Point a client at it with `NEXUS_ENDPOINT=http://127.0.0.1:5799`.

The macOS tray needs cgo (Cocoa): a macOS build with `CGO_ENABLED=0` has `serve`, `service` and `autostart` but no tray. Windows and Linux build with `CGO_ENABLED=0`. Release builds of Windows add `-ldflags -H=windowsgui` so the tray opens no console window; commands still print to the terminal they were started from.

## Test

```bash
go vet ./...
go test ./host/...

# Conformance: the black-box HTTP tests in tests/conformance/ against the test build
npm run host:build-test       # go build -tags testclock -o host/bin/test/ ./host/cmd/n2n-nexus-host
npm run test:conformance      # runs NEXUS_HOST_BIN, default host/bin/test/n2n-nexus-host[.exe]
```

The `testclock` build tag adds `POST /test/clock {"now": <ms> | null}` (pin or release the host's clock) and `serve --test-listen-wait-ms <ms>` (shorter listening wait); release builds have neither. The harness (`tests/conformance/harness.ts`) starts one host per test file with a fresh `--root`, `--port 0` and the file's `settings.json`. `npm test` (client tests) also builds the test host first.

The lefthook pre-push hook and CI (`.github/workflows/host.yml`, on ubuntu, windows and macos) run all of the above.

## Release

1. Tag the commit `host-vX.Y.Z` and push the tag. `.github/workflows/host-release.yml` then:
   - builds `n2n-nexus-host_<version>_<os>_<arch>` for linux, windows (`.zip`) and darwin (`.tar.gz`, built on macOS with cgo), each amd64 and arm64, with `-X main.version=<version>`;
   - writes `SHA256SUMS` and attests build provenance for every archive;
   - renders the package manifests with `host/release/render.mjs` (the Homebrew formula builds the tagged source tarball);
   - creates the GitHub release `host-vX.Y.Z` with the archives, `SHA256SUMS` and `winget-manifests.zip` (a tag with `-`, such as `host-v1.0.0-rc.1`, becomes a prerelease);
   - for tags without `-`, pushes the formula to `n2ns/homebrew-tap` (`Formula/n2n-nexus-host.rb`) and the manifest to `n2ns/scoop-bucket` (`bucket/n2n-nexus-host.json`).
2. Repository secrets: `HOMEBREW_TAP_DEPLOY_KEY` and `SCOOP_BUCKET_DEPLOY_KEY`, SSH deploy keys with write access to those two repositories.
3. winget: unpack `winget-manifests.zip` from the release and submit its `winget/` manifests (`N2NS.n2n-nexus-host`) to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) by hand.

The npm client is released separately with `v*` tags (`.github/workflows/publish.yml`). When a change breaks an older client or host, bump `contractVersion` in the three `contract/` files.
