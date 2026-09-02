param(
    [string]$DataRoot = $(if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" })
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
    throw "No existe la carpeta privada: $DataRoot"
}

$resolved = (Resolve-Path -LiteralPath $DataRoot).ProviderPath
$localAppData = (Resolve-Path -LiteralPath $env:LOCALAPPDATA).ProviderPath
$normalizedRoot = $localAppData.TrimEnd('\') + '\'
if (-not $resolved.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "La carpeta privada debe estar dentro de LOCALAPPDATA."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Ejecuta este script como administrador para poder corregir ACL heredados."
}

$userSid = (Get-LocalUser -Name $env:USERNAME -ErrorAction Stop).SID.Value
$defaultAnswer = if ((Get-UICulture).TwoLetterISOLanguageName -eq "es") { "S" } else { "Y" }
& takeown.exe /F $resolved /R /D $defaultAnswer | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudo recuperar la propiedad de los datos privados." }

& icacls.exe $resolved /reset /T | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudieron restablecer los ACL heredados." }

& icacls.exe $resolved /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudo desactivar la herencia en la raiz privada." }

& icacls.exe $resolved /grant:r `
    "*$userSid`:(OI)(CI)F" `
    "*S-1-5-18:(OI)(CI)F" `
    "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudieron aplicar los permisos privados." }

Write-Output "Permisos privados aplicados a $resolved"
