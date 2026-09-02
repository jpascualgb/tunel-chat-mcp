param(
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

$baseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientPath = Join-Path $baseDirectory "vendor\tunnel-client\tunnel-client.exe"
$controllerPath = Join-Path $baseDirectory "control-panel.mjs"
$dataRoot = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
$credentialPath = Join-Path $dataRoot "control-plane-key.xml"
$workspaceConfigPath = Join-Path $dataRoot "workspace.json"
$nodePath = (Get-Command node -ErrorAction Stop).Source

foreach ($requiredPath in @($clientPath, $controllerPath, $credentialPath, $nodePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Falta un archivo necesario: $requiredPath"
    }
}

$secureKey = Import-Clixml -LiteralPath $credentialPath
$credential = [System.Net.NetworkCredential]::new("", $secureKey)
$workspaceRoot = $null

if (Test-Path -LiteralPath $workspaceConfigPath -PathType Leaf) {
    try {
        $savedWorkspace = Get-Content -Raw -LiteralPath $workspaceConfigPath |
            ConvertFrom-Json
        if ($savedWorkspace.workspaceRoot) {
            $workspaceRoot = [string]$savedWorkspace.workspaceRoot
        }
    }
    catch {
        throw "No se pudo leer la carpeta de trabajo guardada: $workspaceConfigPath"
    }
}

if (-not $NonInteractive) {
    if ($workspaceRoot) {
        Write-Output "Carpeta de trabajo actual: $workspaceRoot"
        $enteredPath = Read-Host "Ruta de la carpeta de trabajo (Enter para conservarla)"
    }
    else {
        $enteredPath = Read-Host "Ruta de la carpeta de trabajo autorizada"
    }

    if (-not [string]::IsNullOrWhiteSpace($enteredPath)) {
        $workspaceRoot = $enteredPath.Trim().Trim('"')
    }
}

if ([string]::IsNullOrWhiteSpace($workspaceRoot)) {
    if ($NonInteractive) {
        throw "No hay carpeta de trabajo guardada. Inicia start-tunnel.ps1 manualmente una vez para seleccionarla."
    }
    throw "Debes indicar una carpeta de trabajo."
}

if (-not (Test-Path -LiteralPath $workspaceRoot -PathType Container)) {
    throw "La carpeta de trabajo no existe o no es accesible: $workspaceRoot"
}

$workspaceRoot = (Resolve-Path -LiteralPath $workspaceRoot).ProviderPath
$driveRoot = [System.IO.Path]::GetPathRoot($workspaceRoot)
if ($workspaceRoot.TrimEnd('\') -eq $driveRoot.TrimEnd('\')) {
    throw "Por seguridad no se permite autorizar la raiz completa de una unidad: $workspaceRoot"
}

if (-not $NonInteractive) {
    [ordered]@{
        workspaceRoot = $workspaceRoot
        updatedAtUtc = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $workspaceConfigPath -Encoding UTF8
    Write-Output "Carpeta autorizada para esta sesion: $workspaceRoot"
}

try {
    $env:CONTROL_PLANE_API_KEY = $credential.Password
    $env:MCP_WORKSPACE_ROOT = $workspaceRoot
    $env:MCP_TUNNEL_DATA_ROOT = $dataRoot
    $env:CONTROL_PANEL_OPEN_BROWSER = if ($NonInteractive) { "0" } else { "1" }
    & $nodePath $controllerPath
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_WORKSPACE_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_TUNNEL_DATA_ROOT -ErrorAction SilentlyContinue
    Remove-Item Env:CONTROL_PANEL_OPEN_BROWSER -ErrorAction SilentlyContinue
    $credential = $null
    $secureKey = $null
    $workspaceRoot = $null
}
