# ADR-001: Limit the control-plane key to the tunnel client

## Status

Accepted

## Date

2026-09-06

## Context

`tunnel-client` authenticates its outbound connection with a runtime API key. The
[official Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
uses `CONTROL_PLANE_API_KEY`, so the client process must receive a plaintext value
while it is running.

The Windows launcher previously placed the key in its own environment and the
control panel passed its complete environment to every child. The MCP launcher
removed OpenAI credentials before importing the file server, but auxiliary
PowerShell and browser-opening processes could still inherit a credential they did
not need.

Environment variables set with `$env:` are process-local on Windows; they are not
automatically saved as persistent user variables. Even so, least privilege requires
reducing the number and lifetime of processes that receive the key.

## Decision

- Keep the encrypted credential at rest in the Windows DPAPI-protected store.
- Use `ProcessStartInfo` to place the plaintext value directly in the control-panel
  child environment without adding it to the launcher environment.
- Capture and remove OpenAI credential variables as soon as the control-panel main
  process starts.
- Reintroduce only `CONTROL_PLANE_API_KEY` in the dedicated environment used to
  launch `tunnel-client`.
- Explicitly sanitize the environments of auxiliary PowerShell and browser-opening
  processes.
- Retain the MCP launcher's credential removal as defense in depth.

## Alternatives considered

### Pass the key on the command line

Rejected because command-line arguments are commonly exposed in process listings
and diagnostic tools.

### Store a plaintext key file

Rejected because it would weaken protection at rest and create a persistent secret
that could be copied accidentally.

### Eliminate the environment variable entirely

Not currently available through the supported `tunnel-client` authentication
interface. This decision should be revisited if the client adds a secure credential
provider or inherited-handle mechanism.

## Consequences

- The runtime key remains present in the `tunnel-client` process, where it is
  required for authentication.
- The key may briefly exist in process memory while DPAPI material is converted for
  child-process creation.
- A process already executing as the same Windows user remains inside the documented
  local trust boundary.
- Auxiliary processes do not receive the key. A stdio launcher created by
  `tunnel-client` can inherit its environment briefly, but `mcp-launcher.mjs`
  deletes the credential before the MCP application code is imported.
