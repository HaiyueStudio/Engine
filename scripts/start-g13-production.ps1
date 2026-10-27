param([switch]$Plan)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repository
if($Plan){& node.exe scripts/run-g13-production-candidate.mjs --plan;exit $LASTEXITCODE}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator check failed. Right-click start-g13-production-70187df.cmd and choose Run as administrator. Sampling did not start.'}
Write-Host 'Administrator confirmed. Waiting up to five minutes for background applications to close.'
Write-Host 'Close ChatGPT/Codex, VS Code, browsers and game launchers completely; leave this independent terminal open.'
Write-Host 'No application will be terminated and no Windows/driver setting will be changed.'
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
Wait-G09GpuDiagnosticStart -TimeoutSeconds 300
& node.exe scripts/run-g13-production-candidate.mjs --run
exit $LASTEXITCODE
