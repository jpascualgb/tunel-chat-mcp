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

## Cross-platform launcher (implementation complete; field validation pending)

The portable CLI detects the host platform while preserving equivalent security
controls:

- Windows: DPAPI and Task Scheduler.
- macOS: Keychain and `launchd`.
- Linux: Secret Service plus `systemd --user`.
- Shared behavior: setup, credential storage, profile selection, health checks,
  permission expiry, log paths, tunnel lifecycle, native autostart and safe
  deactivation/removal of the stored credential.
- Automated tests run on Windows, macOS and Linux. Manual end-to-end validation of
  Keychain/launchd and Secret Service/systemd remains required before a production
  support claim.

Credential storage must fail closed. The CLI must not silently fall back to a
plaintext file when the native secure store is unavailable.

## Local API and frontend separation (completed)

The static frontend consumes an explicit local HTTP API served by the controller:

- [x] Introduce a versioned `/api/v1` contract and a separate schema module.
- [x] Keep the static frontend separate from controller and persistence modules.
- [x] Document request and error response schemas.
- [x] Enforce a loopback-only listener and retain token plus origin checks.
- Add a separate authentication and threat model before considering any remote
  access.

Publicly binding the existing control API is intentionally out of scope because it
would create a new privileged network surface on the user's computer.
