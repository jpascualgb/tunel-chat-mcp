# Security policy

## Supported version

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Do not publish credentials, tunnel identifiers, private file paths, proof-of-concept
payloads containing personal data, or screenshots of private profiles in a public
issue. Use GitHub's
[private vulnerability reporting form](https://github.com/jpascualgb/tunel-chat-mcp/security/advisories/new)
and include:

- the affected version;
- the security boundary that was crossed;
- minimal reproduction steps using temporary files;
- the expected and observed result.

Rotate the OpenAI runtime credential immediately if it may have been disclosed.

The maintainer aims to acknowledge a complete report within 72 hours, assess its
severity and coordinate a safe disclosure. Do not disclose the issue publicly until
a correction or mitigation is available. This project does not currently operate a
paid bug-bounty program.

## Security boundaries

- The MCP process never exposes a command or shell execution tool.
- Only one explicitly selected workspace profile is active at a time.
- Permissions, approvals and backups are isolated per profile and workspace.
- The project directory, tunnel state, secrets, symlinks, junctions and sensitive
  credential paths are protected.
- Local approvals are single-use and consumed atomically.
- Backups are bound to one profile, verified by SHA-256 and validated before use.
- The control panel listens only on loopback and uses a per-process anti-CSRF token.
- Control-plane credentials are removed from the MCP server environment before it
  loads.

The local operating-system account remains the trust boundary. Malware or another process
running as that same user can potentially control local files and processes.
