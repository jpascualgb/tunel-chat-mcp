param(
    [string]$TunnelId,
    [string]$Workspace,
    [string]$ClientPath
)

$ErrorActionPreference = "Stop"

$baseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliPath = Join-Path $baseDirectory "cli.mjs"
$dataRoot = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
$connectionPath = Join-Path $dataRoot "tunnel.json"
$workspaceConfigPath = Join-Path $dataRoot "workspace.json"
$nodePath = (Get-Command node -ErrorAction Stop).Source

if ([string]::IsNullOrWhiteSpace($ClientPath)) {
    $ClientPath = Join-Path $baseDirectory "vendor\tunnel-client\tunnel-client.exe"
}
foreach ($requiredPath in @($ClientPath, $cliPath, $nodePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Falta un archivo necesario: $requiredPath"
    }
}

if ([string]::IsNullOrWhiteSpace($TunnelId) -and (Test-Path -LiteralPath $connectionPath -PathType Leaf)) {
    $TunnelId = [string](Get-Content -Raw -LiteralPath $connectionPath | ConvertFrom-Json).tunnelId
}
if ([string]::IsNullOrWhiteSpace($TunnelId)) {
    $TunnelId = Read-Host "Identificador del tunel de OpenAI (tunnel_...)"
}
if ($TunnelId -notmatch '^tunnel_[a-z0-9]{32}$') {
    throw "El identificador del tunel debe usar tunnel_ seguido de 32 caracteres minusculos o digitos."
}

if ([string]::IsNullOrWhiteSpace($Workspace) -and (Test-Path -LiteralPath $workspaceConfigPath -PathType Leaf)) {
    $Workspace = [string](Get-Content -Raw -LiteralPath $workspaceConfigPath | ConvertFrom-Json).workspaceRoot
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = Read-Host "Ruta de la carpeta de trabajo autorizada"
}

& $nodePath $cliPath setup `
    --workspace $Workspace `
    --tunnel-id $TunnelId `
    --client $ClientPath `
    --data-root $dataRoot

if ($LASTEXITCODE -ne 0) {
    throw "La configuracion del tunel termino con codigo $LASTEXITCODE."
}
