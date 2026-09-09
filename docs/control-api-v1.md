# Local control API v1

The control UI and backend communicate through an explicit, versioned HTTP
boundary. The API is private to the local application; it is not a remote
administration interface.

## Security boundary

- The server accepts only `127.0.0.1` or `::1` as its listening address.
- Every `/api/v1` request requires the ephemeral `X-Control-Token` value created
  for that controller process.
- Browser requests must have an accepted local origin. Non-browser local clients
  may omit `Origin`, but still require the ephemeral token.
- JSON request bodies are limited to 128 KiB and validated with strict Zod schemas.
- Responses use `Cache-Control: no-store`; errors never expose stack traces.

Successful responses retain the resource shapes used by the local UI. Errors have
one stable envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "La solicitud no es valida.",
    "details": {
      "formErrors": [],
      "fieldErrors": {}
    }
  }
}
```

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/state` | Current tunnel, profile, permissions and audit state |
| `PATCH` | `/api/v1/permissions` | Change one permission, optionally for a limited duration |
| `PATCH` | `/api/v1/settings` | Change approval, sensitive-file and backup policy |
| `POST` | `/api/v1/profiles` | Add an authorized workspace profile |
| `DELETE` | `/api/v1/profiles/:id` | Remove a non-active profile |
| `PATCH` | `/api/v1/profiles/active` | Select the active profile |
| `POST` | `/api/v1/approvals/:id` | Approve or reject one pending operation |
| `GET` | `/api/v1/backups/latest/restore-precondition` | Obtain the current destination hash |
| `POST` | `/api/v1/backups/latest/restore` | Restore only if that hash still matches |
| `POST` | `/api/v1/trash/latest/restore` | Restore the latest recoverable deletion |
| `PATCH` | `/api/v1/autostart` | Enable or disable the native user service |
| `POST` | `/api/v1/tunnel/start` | Start the tunnel client |
| `POST` | `/api/v1/tunnel/stop` | Stop the tunnel client |
| `POST` | `/api/v1/tunnel/restart` | Restart the tunnel client |

The executable contract is defined in `control-api-contract.mjs`. A breaking
request or error-envelope change requires a new API version and an ADR.
