param(
    [string]$OutputDirectory = "release"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$packageJson = Get-Content -Raw (Join-Path $root "package.json") | ConvertFrom-Json
$version = $packageJson.version
$staging = Join-Path $root "release\relay-$version"
$archive = Join-Path $root "$OutputDirectory\Codex_Compass_Relay_$version.zip"

if (Test-Path $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Path $staging | Out-Null
Copy-Item -Path (Join-Path $root "server") -Destination $staging -Recurse
Copy-Item -Path (Join-Path $root "deploy") -Destination $staging -Recurse
Copy-Item -Path (Join-Path $root "docs\REMOTE_CONTROL_DEPLOYMENT.md") -Destination $staging

Get-ChildItem -Path $staging -Recurse -Directory -Filter node_modules |
    Remove-Item -Recurse -Force
Get-ChildItem -Path $staging -Recurse -File -Include "*.log",".env" |
    Remove-Item -Force

$archiveDirectory = Split-Path -Parent $archive
New-Item -ItemType Directory -Path $archiveDirectory -Force | Out-Null
if (Test-Path $archive) {
    Remove-Item -LiteralPath $archive -Force
}
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $archive -CompressionLevel Optimal
Write-Output $archive
