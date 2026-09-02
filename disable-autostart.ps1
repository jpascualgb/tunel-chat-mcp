$ErrorActionPreference = "Stop"

$taskName = "OpenAI Secure MCP Tunnel - PC personal"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if (-not $task) {
    Write-Output "El inicio automatico ya estaba desactivado."
    exit 0
}

if ($task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Inicio automatico desactivado."
Write-Output "Las instancias iniciadas manualmente deben detenerse con Ctrl+C."
