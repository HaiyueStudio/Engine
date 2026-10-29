param([switch]$Plan)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
if($Plan){& node.exe scripts/run-g13-windows-remaining.mjs --plan;exit $LASTEXITCODE}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run start-g13-windows-remaining.cmd as administrator. Validation did not start.'}
Write-Host 'Administrator confirmed. Close ChatGPT/Codex and background applications; leave this independent terminal open.'
Write-Host 'Reuse 384 hash-bound renderer captures and HYA evidence; collect 196 remaining captures, then complete global gate and no-publication rehearsal.'
Write-Host 'This can take several hours. No application will be terminated and no Windows or driver setting will be changed.'
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
try { Wait-G09GpuDiagnosticStart -TimeoutSeconds 300; & node.exe scripts/run-g13-windows-remaining.mjs --run; exit $LASTEXITCODE }
catch { Write-Host ('Validation stopped: '+$_.Exception.Message); Write-Host 'FINAL STATUS: failed-before-start'; exit 1 }
