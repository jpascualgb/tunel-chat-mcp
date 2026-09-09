# ADR-002: Portable native runtime and versioned local API

## Status

Accepted

## Date

2026-09-06

## Context

The initial implementation used Windows-only PowerShell launchers, DPAPI and Task
Scheduler. The UI called an unversioned local route layer. Supporting macOS and
Linux must not introduce plaintext credential files or turn the local controller
into a remotely reachable administration service.

## Decision

- Provide one Node.js CLI for setup, launch, credential storage, platform
  inspection and autostart management.
- Use only the operating system's user credential store: DPAPI on Windows, Keychain
  on macOS and Secret Service on Linux. Absence of the native provider is an error;
  there is no plaintext fallback.
- Pass the credential to `tunnel-client` only through its child environment. It is
  never placed in service definitions or command-line arguments.
- Use Task Scheduler, a per-user LaunchAgent, or a `systemd --user` service for
  autostart. Service definitions invoke `cli.mjs run` and load the secret at run
  time from the native store.
- Keep the frontend as static files and expose backend operations under `/api/v1`,
  with a separate schema/error contract module.
- Reject non-loopback bind addresses even when supplied programmatically.
- Validate all three platforms in continuous integration.

## Consequences

- Linux desktop sessions need an available Secret Service implementation and
  unlocked collection. Headless installations must provide one; failure is
  explicit.
- The authorized `tunnel-client` executable remains separately distributed. On
  macOS and Linux it can be supplied with `--client` or `MCP_TUNNEL_CLIENT_PATH`.
- The Windows PowerShell entry points remain compatibility wrappers, while the CLI
  is the portable interface.
- A future remote administration feature would require a separate threat model,
  authentication design and API version.
