# Roadmap

This roadmap records follow-up work identified during architecture and security
review. It is not a promise of release dates.

## Completed foundation

- [x] Restrict file access to explicitly authorized workspaces.
- [x] Add temporary permissions, local approvals, backups and a recoverable trash.
- [x] Keep the control panel and its API on loopback with an ephemeral control token.
- [x] Limit the control-plane credential to `tunnel-client` and remove it from MCP
      and auxiliary child processes.
- [x] Run tests and production dependency auditing on pushes, pull requests and a
      weekly schedule.

## Cross-platform launcher

The current release supports Windows. Cross-platform support should be delivered as
a portable CLI that detects the host platform while preserving equivalent security
controls:

- Windows: DPAPI and Task Scheduler.
- macOS: Keychain and `launchd`.
- Linux: Secret Service or a documented headless secret provider, plus `systemd`.
- Shared behavior: profile selection, health checks, permission expiry, log paths,
  start, stop, restart and uninstall.
- Required quality gate: automated tests on Windows, macOS and Linux before claiming
  support for any platform.

Credential storage must fail closed. The CLI must not silently fall back to a
plaintext file when the native secure store is unavailable.

## Local API and frontend separation

The panel already consumes a local HTTP API served by `control-panel.mjs`. For future
integrations, the next step is to make that boundary explicit rather than embedding
the panel in an iframe or exposing the controller publicly:

- Introduce a versioned `/api/v1` contract.
- Extract lifecycle, profile and approval services from the HTTP route layer.
- Document request and response schemas.
- Keep the default listener on `127.0.0.1` and retain token plus origin checks.
- Add a separate authentication and threat model before considering any remote
  access.

Publicly binding the existing control API is intentionally out of scope because it
would create a new privileged network surface on the user's computer.
