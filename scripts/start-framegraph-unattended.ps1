param([switch]$GpuStateDiagnostic,[switch]$Plan,[switch]$Smoke,[switch]$PreflightOnly,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repository
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$git=Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
foreach($exe in @($node,$git)){if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){throw ('Executable missing: '+$exe)}}
$env:Path=((Split-Path -Parent $node),(Split-Path -Parent $git),$env:Path) -join ';'
$env:GIT_CONFIG_COUNT='1';$env:GIT_CONFIG_KEY_0='safe.directory';$env:GIT_CONFIG_VALUE_0=$repository
if($Plan){$planFlag=if($GpuStateDiagnostic){'--gpu-state-plan'}else{'--plan'};& $node 'scripts/verify-framegraph-sampling.mjs' $planFlag;exit $LASTEXITCODE}
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
if($PreflightOnly){
 $blocked=@(Get-G09GpuStartBlockers -AllowCodex)
 [ordered]@{ready=($blocked.Count -eq 0);blocked=$blocked;settingsChanged=$false}|ConvertTo-Json -Depth 4
 if($blocked.Count){exit 1};exit 0
}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run as administrator for temporary CPU/Chrome GPU settings; both are restored afterward.'}
if(-not $Smoke){
 Assert-G09GpuDiagnosticReady
}
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-build-preflight.ps1')
$buildCheck=Assert-G09DiagnosticBuild
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-desktop-preflight.ps1')
$desktopAuditStart=[DateTime]::UtcNow
if(-not $Smoke){Assert-G09DesktopReady|Out-Null}
$mode=if($GpuStateDiagnostic){if($Smoke){'GpuStateSmoke'}else{'GpuStateDiagnostic'}}elseif($Smoke){'FixtureSmoke'}else{'Full'}
$prefix=if($Smoke){'unattended-gpu-v5-smoke-'}else{'unattended-controlled-gpu-v5-'}
$out=Join-Path $repository ('artifacts/engine-0.2.1/g09/'+$prefix+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
if($OutputDirectory){$out=[IO.Path]::GetFullPath($OutputDirectory)}
$allowedRoot=[IO.Path]::GetFullPath((Join-Path $repository 'artifacts/engine-0.2.1/g09'))+'\'
if(-not $out.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'Use a fresh child of G09 artifacts'}
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$entryBytes=[IO.File]::ReadAllBytes($PSCommandPath)
$failure=$null;$exitCode=1
$completion=[ordered]@{startedAt=[DateTime]::UtcNow.ToString('o');status='running';mode=$mode;performanceQualified=$false;regressionBudget=.05;output=$out}
if($GpuStateDiagnostic){Write-Output ('Single-light GPU state diagnostic: '+$out);Write-Output 'Normally about 25-35 minutes. Keep idle until completion. Diagnostic only; no new baseline.'}else{Write-Output ('Independent calibration and fresh baseline: '+$out);if(-not $Smoke){Write-Output 'Normally about 80-100 minutes, including fixed cooldowns. Keep the computer idle until completion.'}}
try{
 & $ps -NoProfile -File (Join-Path $PSScriptRoot 'run-framegraph-unattended.ps1') -Mode $mode -OutputDirectory $out
 $exitCode=$LASTEXITCODE;$completion.workerExitCode=$exitCode
 $service=Get-Content -LiteralPath (Join-Path $out 'service-state.json') -Raw|ConvertFrom-Json
 $cpu=Get-Content -LiteralPath (Join-Path $out 'power-state.json') -Raw|ConvertFrom-Json
 $gpu=Get-Content -LiteralPath (Join-Path $out 'gpu-power-state.json') -Raw|ConvertFrom-Json
 $completion.serviceRestored=[bool]$service.restored
 $completion.cpuRestored=[bool]($cpu.restored -and $cpu.removed)
 $completion.gpuRestored=[bool]$gpu.restored
 if(-not($completion.serviceRestored -and $completion.cpuRestored -and $completion.gpuRestored)){throw 'Service/CPU/GPU restoration did not pass'}
 if(-not $Smoke){
  Assert-G09GpuDiagnosticReady
  Assert-G09DesktopReady -SinceUtc $desktopAuditStart -EvidencePath (Join-Path $out 'desktop-audit.json')|Out-Null
  $completion.desktopPassed=$true
 }
 $report=Get-Content -LiteralPath (Join-Path $out 'measurement/report.json') -Raw|ConvertFrom-Json
 if(-not $Smoke){
  $unexpected=@()
  Get-Content -LiteralPath (Join-Path $out 'processes.jsonl')|ForEach-Object {
   $row=$_|ConvertFrom-Json
   foreach($process in $row.Processes){if($process.Name -match '^(ChatGPT|Codex|Code|EpicGamesLauncher|EpicWebHelper|steam|steamwebhelper|Taskmgr|msedge)$'){$unexpected+=,[ordered]@{at=$row.At;pid=$process.Pid;name=$process.Name}}}
  }
  $completion.backgroundApplicationObservations=$unexpected.Count
  if($unexpected.Count){$unexpected|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $out 'background-failures.json') -Encoding utf8;throw 'Background application observations invalidate this independent run'}
  # A completed failed calibration/assessment also gets an independent recomputation.
  # Partial or contaminated captures remain failed evidence, without fabricated populations.
  if(-not $GpuStateDiagnostic -and $report.calibration -and ($report.calibration.status -eq 'failed' -or $report.assessment)){
   & $node 'scripts/validate-framegraph-sampling.mjs' (Join-Path $out 'measurement') *> (Join-Path $out 'revalidation.log')
   $completion.revalidationExitCode=$LASTEXITCODE
   $revalidationPath=Join-Path $out 'measurement/revalidation.json'
   if(-not(Test-Path -LiteralPath $revalidationPath)){throw 'Independent integrity validation failed; see revalidation.log'}
   $verification=Get-Content -LiteralPath $revalidationPath -Raw|ConvertFrom-Json
   $completion.revalidationStatus=$verification.status
  }
 }
 if($exitCode -ne 0 -or $report.status -ne 'passed'){throw ('Sampling did not pass: '+$report.error+'; evidence: '+$out)}
 if($GpuStateDiagnostic){
  & $node 'scripts/validate-framegraph-gpu-state.mjs' (Join-Path $out 'measurement') *> (Join-Path $out 'revalidation.log')
  $completion.revalidationExitCode=$LASTEXITCODE
  if($completion.revalidationExitCode -ne 0){throw 'GPU state independent validation failed; see revalidation.log'}
  $verification=Get-Content -LiteralPath (Join-Path $out 'measurement/gpu-state-revalidation.json') -Raw|ConvertFrom-Json
  $completion.revalidationStatus=$verification.status
  if($verification.status -ne 'diagnostic-complete'){throw 'Incomplete GPU state diagnostic validation'}
  $completion.status=if($Smoke){'gpu-state-engineering-smoke-passed'}else{'gpu-state-diagnostic-complete'}
  $completion.createsBaseline=$false
 }elseif(-not $Smoke){
  if($completion.revalidationExitCode -ne 0 -or $completion.revalidationStatus -ne 'passed'){throw 'Independent validation did not pass; see revalidation.log'}
  $completion.status='development-baseline-passed'
 }else{$completion.status='engineering-smoke-passed'}
}catch{$failure=$_.Exception.Message;$completion.status='failed';$completion.error=$failure}
finally{
 if(Test-Path -LiteralPath $out){
  $completion.finishedAt=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllBytes((Join-Path $out 'entry.ps1'),$entryBytes)
  $buildCheck|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $out 'build-preflight.json') -Encoding utf8
  $completion|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $out 'completion.json') -Encoding utf8
 }
}
Write-Output ('Sampling status: '+$completion.status+'; '+$out)
Write-Output ('CPU restored: '+$completion.cpuRestored+'; Chrome GPU restored: '+$completion.gpuRestored+'; Search restored: '+$completion.serviceRestored)
if($failure){Write-Output $failure}
Write-Output 'Original 5% regression budget unchanged. Development evidence is not full G09/G05 release qualification.'
if($completion.status -notin @('development-baseline-passed','engineering-smoke-passed','gpu-state-diagnostic-complete','gpu-state-engineering-smoke-passed')){exit 1}
