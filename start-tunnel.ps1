param(
    [switch]$NonInteractive,
    [string]$ClientPath,
    [string]$DataRoot
)

$ErrorActionPreference = "Stop"

$baseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliPath = Join-Path $baseDirectory "cli.mjs"
$dataRoot = if ($DataRoot) { $DataRoot } elseif ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
$nodePath = (Get-Command node -ErrorAction Stop).Source
if ([string]::IsNullOrWhiteSpace($ClientPath)) {
    $ClientPath = Join-Path $baseDirectory "vendor\tunnel-client\tunnel-client.exe"
}
foreach ($value in @($dataRoot, $ClientPath)) {
    if ($value -and $value -match '[\r\n"]') { throw "Las rutas no pueden contener caracteres de control ni comillas." }
}

foreach ($requiredPath in @($ClientPath, $cliPath, $nodePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Falta un archivo necesario: $requiredPath"
    }
}

$arguments = @($cliPath, "run", "--data-root", $dataRoot, "--client", $ClientPath)
if ($NonInteractive) { $arguments += "--non-interactive" }
& $nodePath @arguments
exit $LASTEXITCODE
