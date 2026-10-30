param([switch]$Plan)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
if($Plan){& node.exe scripts/run-g13-windows-final.mjs --plan;exit $LASTEXITCODE}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run start-g13-windows-final.cmd as administrator. Validation did not start.'}
Write-Host 'Administrator confirmed. Close ChatGPT/Codex completely; leave this independent terminal open.'
Write-Host 'Windows validation includes 580 renderer and 30 HYA production captures, the global gate and a no-publication rehearsal. It can take several hours.'
Write-Host 'No application will be terminated and no Windows or driver setting will be changed.'
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
Wait-G09GpuDiagnosticStart -TimeoutSeconds 300
& node.exe scripts/run-g13-windows-final.mjs --run
exit $LASTEXITCODE
