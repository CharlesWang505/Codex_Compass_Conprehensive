param(
    [string]$VpsHost,
    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,
    [string]$SshUser = "root",
    [string]$IdentityFile,
    [string]$Domain,
    [string]$Email,
    [switch]$SkipDnsCheck,
    [switch]$NonInteractive,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Read-RequiredValue {
    param([string]$CurrentValue, [string]$Prompt)
    if (-not [string]::IsNullOrWhiteSpace($CurrentValue)) {
        return $CurrentValue.Trim()
    }
    $value = Read-Host $Prompt
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Prompt is required."
    }
    return $value.Trim()
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. Install the Windows OpenSSH Client optional feature."
    }
}

$VpsHost = Read-RequiredValue $VpsHost "VPS IP address or hostname"
$Domain = (Read-RequiredValue $Domain "Relay domain without https://").ToLowerInvariant()
$Email = Read-RequiredValue $Email "Let's Encrypt email"
if (-not $NonInteractive -and -not $PSBoundParameters.ContainsKey("SshUser")) {
    $enteredUser = Read-Host "SSH user [root]"
    if (-not [string]::IsNullOrWhiteSpace($enteredUser)) {
        $SshUser = $enteredUser.Trim()
    }
}
if (-not $NonInteractive -and -not $PSBoundParameters.ContainsKey("SshPort")) {
    $enteredPort = Read-Host "SSH port [22]"
    if (-not [string]::IsNullOrWhiteSpace($enteredPort)) {
        if ($enteredPort -notmatch '^[0-9]+$') {
            throw "The SSH port must be a number."
        }
        $SshPort = [int]$enteredPort
    }
}
if (-not $NonInteractive -and -not $PSBoundParameters.ContainsKey("IdentityFile")) {
    $enteredIdentity = Read-Host "SSH private key path [use password or default key]"
    if (-not [string]::IsNullOrWhiteSpace($enteredIdentity)) {
        $IdentityFile = $enteredIdentity.Trim().Trim('"')
    }
}
$SshUser = Read-RequiredValue $SshUser "SSH user"

if ($VpsHost -notmatch '^[a-zA-Z0-9.-]+$') {
    throw "The VPS address is invalid. This wizard supports IPv4 addresses and regular hostnames."
}
if ($Domain -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') {
    throw "The Relay domain is invalid. Do not include a scheme, port, or path."
}
if ($Email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
    throw "The email address is invalid."
}
if ($SshUser -notmatch '^[a-zA-Z_][a-zA-Z0-9_-]*$') {
    throw "The SSH username is invalid."
}
if ($SshPort -lt 1 -or $SshPort -gt 65535) {
    throw "The SSH port must be between 1 and 65535."
}
if ($IdentityFile) {
    $IdentityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
}

Require-Command "ssh"
Require-Command "scp"
Require-Command "tar"

$bundleRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path -LiteralPath (Join-Path $bundleRoot "server\package-lock.json"))) {
    throw "Relay files are missing. Run this wizard from a complete Codex Compass Relay bundle."
}

Write-Host ""
Write-Host "Self-hosted Relay deployment" -ForegroundColor Cyan
Write-Host "  VPS: $SshUser@$VpsHost`:$SshPort"
Write-Host "  Website: https://$Domain"
Write-Host "  WebSocket: wss://$Domain/ws"
Write-Host "  Codex credentials are never uploaded to the VPS."
Write-Host ""

if ($DryRun) {
    Write-Host "Dry-run passed. No VPS connection was made." -ForegroundColor Green
    return
}

try {
    $resolved = Resolve-DnsName -Name $Domain -Type A -ErrorAction Stop |
        Where-Object { $_.IPAddress } |
        Select-Object -ExpandProperty IPAddress
    Write-Host "DNS currently resolves to: $($resolved -join ', ')"
} catch {
    if (-not $SkipDnsCheck) {
        throw "The domain does not resolve. Point its A record to the VPS or use -SkipDnsCheck."
    }
    Write-Warning "Local DNS validation was skipped. The VPS installer still validates DNS before requesting TLS."
}

$deploymentId = [guid]::NewGuid().ToString("N")
$archive = Join-Path $env:TEMP "codex-compass-relay-$deploymentId.tar.gz"
$remoteArchive = "/tmp/codex-compass-relay-$deploymentId.tar.gz"
$remoteDirectory = "/tmp/codex-compass-relay-$deploymentId"
$sshTarget = "$SshUser@$VpsHost"
$identityArgs = @()
if ($IdentityFile) {
    $identityArgs = @("-i", $IdentityFile)
}

try {
    & tar "-czf" $archive "-C" $bundleRoot `
        "--exclude=server/node_modules" `
        "--exclude=*.log" `
        "--exclude=.env" `
        "server" "deploy"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the Relay upload archive."
    }

    $scpArgs = @("-P", "$SshPort") + $identityArgs + @(
        $archive,
        "${sshTarget}:$remoteArchive"
    )
    Write-Host "Uploading Relay..." -ForegroundColor Cyan
    & scp @scpArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Relay upload failed."
    }

    $sudo = if ($SshUser -eq "root") { "" } else { "sudo " }
    $dnsOption = if ($SkipDnsCheck) { " --skip-dns-check" } else { "" }
    $remoteCommand = @(
        "set -e",
        "mkdir -p '$remoteDirectory'",
        "tar -xzf '$remoteArchive' -C '$remoteDirectory'",
        "${sudo}bash '$remoteDirectory/deploy/scripts/install-relay.sh' --domain '$Domain' --email '$Email' --non-interactive$dnsOption",
        "rm -f '$remoteArchive'",
        "rm -rf '$remoteDirectory'"
    ) -join "; "

    $sshArgs = @("-t", "-p", "$SshPort") + $identityArgs + @($sshTarget, $remoteCommand)
    Write-Host "Installing Node.js, Relay, Nginx, and HTTPS..." -ForegroundColor Cyan
    & ssh @sshArgs
    if ($LASTEXITCODE -ne 0) {
        throw "VPS installation failed. Remote temporary files were retained for diagnostics."
    }

    $health = Invoke-RestMethod -Uri "https://$Domain/healthz" -TimeoutSec 20
    if (-not $health.ok) {
        throw "The public health check returned an unexpected response."
    }

    Write-Host ""
    Write-Host "Deployment completed." -ForegroundColor Green
    Write-Host "Enter these values in Codex Compass > Mobile Remote Control:"
    Write-Host "  Relay WebSocket: wss://$Domain/ws"
    Write-Host "  Mobile website: https://$Domain"
} finally {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
}
