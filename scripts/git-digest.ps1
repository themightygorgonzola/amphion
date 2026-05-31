#Requires -Version 5.1
<#
.SYNOPSIS
  Collect the last N hours of git activity across all MSF repos and ingest
  the summary into Amphion's daily-log corpus.

.DESCRIPTION
  Walks every git repo under MSFRoot, runs `git log` since HoursBack hours ago,
  bundles the output as a markdown file, and POSTs it to the Amphion broker
  /ingest endpoint. Run manually or wire into a scheduled task.

.PARAMETER MSFRoot
  Root directory containing repos. Default: C:\MySoftwareFolder

.PARAMETER HoursBack
  How many hours of history to capture. Default: 24

.PARAMETER BrokerURL
  Amphion broker base URL. Falls back to AMPHION_BROKER_URL env var, then localhost:3001.

.PARAMETER BrokerKey
  Amphion broker API key. Falls back to AMPHION_BROKER_KEY env var.

.EXAMPLE
  .\git-digest.ps1
  .\git-digest.ps1 -HoursBack 48
#>
param(
  [string]$MSFRoot   = "C:\MySoftwareFolder",
  [int]$HoursBack    = 24,
  [string]$BrokerURL = ($env:AMPHION_BROKER_URL ?? "http://localhost:3001"),
  [string]$BrokerKey = ($env:AMPHION_BROKER_KEY ?? "")
)

$ErrorActionPreference = "Stop"
$BrokerURL = $BrokerURL.TrimEnd("/")

$since     = (Get-Date).AddHours(-$HoursBack).ToString("yyyy-MM-ddTHH:mm:ss")
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$lines     = [System.Collections.Generic.List[string]]::new()

$lines.Add("# Git digest — $timestamp — last ${HoursBack}h")
$lines.Add("")
$lines.Add("Machine: $($env:MACHINE_NAME ?? $env:COMPUTERNAME)")
$lines.Add("")

$repos = Get-ChildItem -Path $MSFRoot -Directory `
  | Where-Object { Test-Path (Join-Path $_.FullName ".git") }

$commitCount = 0
foreach ($repo in $repos) {
  $log = git -C $repo.FullName log `
    --since=$since `
    --format="%h %as %an: %s" `
    --no-merges 2>$null

  if ($log) {
    $lines.Add("## $($repo.Name)")
    $log | ForEach-Object {
      $lines.Add("- $_")
      $commitCount++
    }
    $lines.Add("")
  }
}

if ($commitCount -eq 0) {
  Write-Host "No commits in the last ${HoursBack}h across $($repos.Count) repos — nothing to ingest."
  exit 0
}

# Write digest to a temp file and POST it to Amphion /ingest
$tempFile = Join-Path $env:TEMP "amphion-git-digest-$(Get-Date -Format 'yyyyMMdd-HHmmss').md"
$lines | Set-Content $tempFile -Encoding UTF8

Write-Host "Digest: $commitCount commits across $($repos.Count) repos"
Write-Host "Ingesting to Amphion ($BrokerURL)..."

$headers = @{ "Content-Type" = "application/json" }
if ($BrokerKey) { $headers["Authorization"] = "Bearer $BrokerKey" }

$body = @{
  filePath  = $tempFile
  corpus    = "daily-log"
  force     = $false
  noSummary = $true
} | ConvertTo-Json

try {
  $response = Invoke-RestMethod `
    -Uri "${BrokerURL}/ingest" `
    -Method POST `
    -Headers $headers `
    -Body $body `
    -TimeoutSec 30
  Write-Host "Ingested: $($response.id ?? 'ok') — corpus=daily-log"
} catch {
  Write-Warning "Ingest failed: $_"
  Write-Host "Digest file kept at: $tempFile"
  exit 1
}

Remove-Item $tempFile -ErrorAction SilentlyContinue
Write-Host "Done."
