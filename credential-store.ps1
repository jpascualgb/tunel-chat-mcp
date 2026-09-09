param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("store", "load")]
  [string]$Action,

  [Parameter(Mandatory = $true, Position = 1)]
  [string]$DataRoot
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$credentialPath = Join-Path $DataRoot "control-plane-key.dpapi"
$legacyCredentialPath = Join-Path $DataRoot "control-plane-key.xml"

if ($Action -eq "store") {
  $plainText = [Console]::In.ReadToEnd().Trim()
  if ($plainText -notmatch '^sk-[A-Za-z0-9_-]{16,512}$') {
    throw "La clave tiene un formato no valido."
  }
  New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $temporaryPath = "$credentialPath.$PID.tmp"
  [IO.File]::WriteAllBytes($temporaryPath, $protectedBytes)
  Move-Item -LiteralPath $temporaryPath -Destination $credentialPath -Force
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  exit 0
}

if (Test-Path -LiteralPath $credentialPath -PathType Leaf) {
  $protectedBytes = [IO.File]::ReadAllBytes($credentialPath)
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $legacyCredentialPath -PathType Leaf)) {
  throw "No hay una credencial guardada para este usuario."
}
$secure = Import-Clixml -LiteralPath $legacyCredentialPath
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
