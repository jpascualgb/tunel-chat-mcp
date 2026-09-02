param(
    [string]$TunnelId
)

$ErrorActionPreference = "Stop"

$baseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientPath = Join-Path $baseDirectory "vendor\tunnel-client\tunnel-client.exe"
$serverPath = Join-Path $baseDirectory "mcp-launcher.mjs"
$dataRoot = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
$credentialPath = Join-Path $dataRoot "control-plane-key.xml"
$connectionPath = Join-Path $dataRoot "tunnel.json"
$nodePath = (Get-Command node -ErrorAction Stop).Source

foreach ($requiredPath in @($clientPath, $serverPath, $credentialPath, $nodePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Falta un archivo necesario: $requiredPath"
    }
}

$secureKey = Import-Clixml -LiteralPath $credentialPath
$credential = [System.Net.NetworkCredential]::new("", $secureKey)
$serverCommandPath = $serverPath.Replace("\", "/")
$mcpCommand = "node $serverCommandPath"
$tunnelId = $TunnelId

if (Test-Path -LiteralPath $connectionPath -PathType Leaf) {
    $tunnelId = [string](Get-Content -Raw -LiteralPath $connectionPath | ConvertFrom-Json).tunnelId
}
if ([string]::IsNullOrWhiteSpace($tunnelId)) {
    $tunnelId = Read-Host "Identificador del tunel de OpenAI (tunnel_...)"
}
if ($tunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') {
    throw "El identificador del tunel no tiene un formato valido."
}
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
[ordered]@{ tunnelId = $tunnelId; updatedAtUtc = [DateTime]::UtcNow.ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $connectionPath -Encoding UTF8

try {
    $env:CONTROL_PLANE_API_KEY = $credential.Password

    & $clientPath init `
        --force `
        --sample sample_mcp_stdio_local `
        --profile pc-personal `
        --tunnel-id $tunnelId `
        --mcp-command $mcpCommand

    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client init termino con codigo $LASTEXITCODE."
    }

    & $clientPath doctor --profile pc-personal --explain
    if ($LASTEXITCODE -ne 0) {
        throw "tunnel-client doctor termino con codigo $LASTEXITCODE."
    }
}
finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    $credential = $null
    $secureKey = $null
}
