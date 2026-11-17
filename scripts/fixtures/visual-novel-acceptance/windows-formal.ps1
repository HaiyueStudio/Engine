[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Run,
    [Parameter(Mandatory = $true)][string] $Device,
    [switch] $Elevated
)

$ErrorActionPreference = 'Stop'
$candidate = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$runFile = (Resolve-Path -LiteralPath $Run).Path
$deviceKit = (Resolve-Path -LiteralPath $Device).Path
$admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($Elevated) { throw 'Administrator authorization did not succeed.' }
    $parts = @('-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
        '-Run', ('"' + $runFile + '"'), '-Device', ('"' + $deviceKit + '"'), '-Elevated')
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList $parts -WindowStyle Normal
    exit 0
}

Set-Location -LiteralPath $candidate
$helper = Join-Path $candidate 'scripts/windows-unattended-chatgpt.ps1'
$code = 1
try {
    & $helper -Action Close -RequireAdministrator
    & node scripts/verify-visual-novel-acceptance.mjs performance --artifact $deviceKit
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        & node scripts/fixtures/visual-novel-acceptance/legacy-render-evidence.mjs --run
        $code = $LASTEXITCODE
    }
    if ($code -eq 0) {
        & node scripts/release-workflow.mjs run --run $runFile --no-publish
        $code = $LASTEXITCODE
    }
} finally {
    try { & $helper -Action Open } catch { Write-Host $_ }
    Write-Host ('Performance evidence: ' + $deviceKit)
    Write-Host ('Release workflow: ' + $runFile)
}
exit $code
