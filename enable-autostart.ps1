$ErrorActionPreference = "Stop"

$taskName = "OpenAI Secure MCP Tunnel - PC personal"
$startScript = Join-Path $PSScriptRoot "start-tunnel.ps1"
$dataRoot = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
$workspaceConfig = Join-Path $dataRoot "workspace.json"

if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "No se encuentra el iniciador del tunel: $startScript"
}

if (-not (Test-Path -LiteralPath $workspaceConfig -PathType Leaf)) {
    throw "No hay carpeta de trabajo guardada. Ejecuta start-tunnel.ps1 manualmente una vez antes de activar el inicio automatico."
}

$windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -NonInteractive"

$action = New-ScheduledTaskAction `
    -Execute $windowsPowerShell `
    -Argument $arguments `
    -WorkingDirectory $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Inicia el Secure MCP Tunnel PC personal al entrar en Windows." `
    -Force | Out-Null

Write-Output "Inicio automatico activado para el usuario $userId."
Write-Output "Se aplicara en el proximo inicio de sesion de Windows."
