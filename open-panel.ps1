$ErrorActionPreference = "Stop"

$dataRoot = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
$urlPath = Join-Path $dataRoot "panel-url.txt"
if (-not (Test-Path -LiteralPath $urlPath -PathType Leaf)) {
    throw "El panel no esta iniciado. Ejecuta start-tunnel.ps1 primero."
}

$secureUrl = (Get-Content -Raw -LiteralPath $urlPath).Trim()
if ($secureUrl -notmatch '^http://127\.0\.0\.1:\d+/ui#[a-f0-9]{48}$') {
    throw "El enlace local del panel no es valido."
}

Start-Process $secureUrl
