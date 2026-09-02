param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1024, 65535)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [string]$Nonce
)

$ErrorActionPreference = "Stop"
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$client = $null
$reader = $null

try {
    $listener.Start()
    Write-Output "READY"

    $client = $listener.AcceptTcpClient()
    $reader = [System.IO.StreamReader]::new(
        $client.GetStream(),
        [System.Text.UTF8Encoding]::new($false),
        $false,
        1024,
        $true
    )

    $receivedNonce = $reader.ReadLine()
    $plainKey = $reader.ReadLine()

    if ($receivedNonce -cne $Nonce) {
        throw "El codigo efimero no coincide."
    }
    if ([string]::IsNullOrWhiteSpace($plainKey) -or -not $plainKey.StartsWith("sk-")) {
        throw "La clave recibida no tiene el formato esperado."
    }

    $credentialDirectory = if ($env:MCP_TUNNEL_DATA_ROOT) { $env:MCP_TUNNEL_DATA_ROOT } else { Join-Path $env:LOCALAPPDATA "OpenAI-Secure-MCP-Tunnel" }
    $credentialPath = Join-Path $credentialDirectory "control-plane-key.xml"
    New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null

    ConvertTo-SecureString -String $plainKey -AsPlainText -Force |
        Export-Clixml -LiteralPath $credentialPath

    Write-Output "PROTECTED"
}
finally {
    $plainKey = $null
    $receivedNonce = $null
    if ($reader) { $reader.Dispose() }
    if ($client) { $client.Dispose() }
    $listener.Stop()
}
