param([switch]$Plan)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
if($Plan){& node.exe scripts/run-g13-windows-gates.mjs --plan;exit $LASTEXITCODE}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run start-g13-windows-gates.cmd as administrator. Validation did not start.'}
Write-Host 'Administrator confirmed. Keep this independent terminal open; close ChatGPT/Codex and background applications.'
Write-Host 'Reuse all 580 renderer captures and HYA/physical evidence by exact hashes. Do not repeat the 196 captures.'
Write-Host 'Run the COMPLETE global gate and no-publication rehearsal. Allow several hours. Nothing will be terminated; Windows settings stay unchanged.'
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
try{Wait-G09GpuDiagnosticStart -TimeoutSeconds 300; & node.exe scripts/run-g13-windows-gates.mjs --run;exit $LASTEXITCODE}
catch{Write-Host ('Validation stopped: '+$_.Exception.Message);Write-Host 'FINAL STATUS: failed-before-start';exit 1}
