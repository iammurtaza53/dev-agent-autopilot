param(
  [switch]$InstallReviewer
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Installing Dev Agent Autopilot from $Root"
Set-Location $Root

node --version
npm --version
npm install
npm link

dev-autopilot --help

if ($InstallReviewer) {
  dev-autopilot install-reviewer
}

Write-Host ""
Write-Host "Installed. To onboard a project, run inside it:"
Write-Host '  dev-autopilot init'
