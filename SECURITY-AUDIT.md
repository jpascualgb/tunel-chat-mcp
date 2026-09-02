# Security audit — 2026-09-01

## Result

No open critical or high-severity finding was identified after remediation.
The tunnel was running and ready at the end of the review with read-only access,
per-operation approval, sensitive-path protection and backups enabled.

## Remediations verified

| Control | Result |
|---|---|
| Permissions, approvals and backups isolated per profile | Pass |
| Approval key bound to profile, workspace, operation, path and content | Pass |
| Approval consumption protected by an atomic file lock | Pass |
| Project and private state cannot be selected as a workspace | Pass |
| Path traversal, absolute paths, symlinks, junctions, ADS and Windows reserved names blocked | Pass |
| Backup metadata bound to profile/workspace and contained in its store | Pass |
| Backup SHA-256 verified before restoration | Pass |
| Control-plane credentials removed before loading the MCP server | Pass |
| Private data moved outside the source tree and protected by Windows ACLs | Pass |
| Tunnel profile ACL restricted to the user, SYSTEM and administrators | Pass |
| Control token absent from public HTML | Pass |
| Ephemeral panel link stored only in the private data directory | Pass |
| Audit events chained by SHA-256 and automatically rotated | Pass |
| Audit-chain verification | Pass |
| Desktop and mobile panel rendering; ES/EN interaction; no console warnings/errors | Pass |
| Automated MCP and control-panel tests | Pass |
| Current source-tree scan for key, tunnel ID and personal-path patterns | Pass |
| Package dry run excludes credentials, local state, vendor binaries and logs | Pass |

## Residual findings

### Medium — dependency advisory status could not be retrieved

`npm audit` was attempted both normally and outside the workspace sandbox. The npm
registry request failed because the local TLS chain could not be verified. This is
not evidence of a vulnerable dependency, but it leaves the current advisory status
unconfirmed. Do not bypass TLS verification. Repair the trusted certificate chain
or run the audit in GitHub Actions before a public release.

### Low — no Git history exists yet

The current source tree is clean for the scanned secret and personal-path patterns,
and the local state directory has been removed from it. Because this directory is
not yet a Git repository, there is no commit history to inspect. After initializing
Git, run a history-aware secret scanner before the first push.

### Low — local account remains the trust boundary

An attacker already executing code as the same Windows user can potentially inspect
process memory, manipulate the authorized files or stop the tunnel. The project does
not claim to defend against a fully compromised local account.

## Public-release decisions still required

- Apache License 2.0 selected for the project source.
- Confirm the redistribution terms for `tunnel-client.exe`. The binary is excluded
  from Git and package output.
- Add CI for `npm test`, dependency review and secret scanning.
- Enable GitHub Dependabot and secret scanning after repository creation.

The OpenAI Secure MCP Tunnel is intended for private MCP connections and does not
turn this server into a public plugin endpoint. Publishing the source on GitHub is a
separate distribution choice; each user should configure their own private tunnel
and credential.
