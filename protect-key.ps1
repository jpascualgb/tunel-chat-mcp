param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1024, 65535)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [string]$Nonce
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$client = $null
$reader = $null

function Read-BoundedLine {
    param([System.IO.StreamReader]$InputReader, [int]$MaximumLength)
    $builder = [Text.StringBuilder]::new()
    while ($builder.Length -le $MaximumLength) {
        $value = $InputReader.Read()
        if ($value -lt 0 -or $value -eq 10) { return $builder.ToString().TrimEnd("`r") }
        [void]$builder.Append([char]$value)
    }
    throw "La entrada supera el limite permitido."
}

try {
    $listener.Start()
    Write-Output "READY"

    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 15000
    $reader = [System.IO.StreamReader]::new(
        $client.GetStream(),
        [System.Text.UTF8Encoding]::new($false),
        $false,
        1024,
        $true
    )

    $receivedNonce = Read-BoundedLine $reader 256
    $plainKey = Read-BoundedLine $reader 512

    if ($receivedNonce -cne $Nonce) {
        throw "El codigo efimero no coincide."
    }
    if ($plainKey -notmatch '^sk-[A-Za-z0-9_-]{16,512}$') {
        throw "La clave recibida no tiene el formato esperado."
    }

    $credentialDirectory = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
    $credentialPath = Join-Path $credentialDirectory "control-plane-key.dpapi"
    New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainKey)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $temporaryPath = "$credentialPath.$PID.tmp"
    [IO.File]::WriteAllBytes($temporaryPath, $protectedBytes)
    Move-Item -LiteralPath $temporaryPath -Destination $credentialPath -Force
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)

    Write-Output "PROTECTED"
}
finally {
    if ($temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
    $plainKey = $null
    $plainBytes = $null
    $protectedBytes = $null
    $receivedNonce = $null
    if ($reader) { $reader.Dispose() }
    if ($client) { $client.Dispose() }
    $listener.Stop()
}
