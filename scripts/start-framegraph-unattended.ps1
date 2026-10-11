param([switch]$Plan,[switch]$Smoke,[switch]$PreflightOnly)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repository
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$git=Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
foreach($exe in @($node,$git)){if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){throw ('Executable missing: '+$exe)}}
$env:Path=((Split-Path -Parent $node),(Split-Path -Parent $git),$env:Path) -join ';'
$env:GIT_CONFIG_COUNT='1';$env:GIT_CONFIG_KEY_0='safe.directory';$env:GIT_CONFIG_VALUE_0=$repository
if($Plan){& $node 'scripts/verify-framegraph-sampling.mjs' --plan;exit $LASTEXITCODE}
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
if($PreflightOnly){
 $blocked=@(Get-G09GpuStartBlockers -AllowCodex)
 [ordered]@{ready=($blocked.Count -eq 0);blocked=$blocked;settingsChanged=$false}|ConvertTo-Json -Depth 4
 if($blocked.Count){exit 1};exit 0
}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run as administrator for temporary CPU/Chrome GPU settings; both are restored afterward.'}
if(-not $Smoke){
 Write-Output 'Waiting up to five minutes for Codex, browsers, Task Manager, VS Code, Epic and Steam to exit. No application will be terminated.'
 try{Wait-G09GpuDiagnosticStart -TimeoutSeconds 300}catch{Write-Output $_.Exception.Message;exit 1}
}
$mode=if($Smoke){'Smoke'}else{'Full'}
$prefix=if($Smoke){'unattended-gpu-v4-smoke-'}else{'unattended-controlled-gpu-v4-'}
$out=Join-Path $repository ('artifacts/engine-0.2.1/g09/'+$prefix+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$entryBytes=[IO.File]::ReadAllBytes($PSCommandPath)
$failure=$null;$exitCode=1
$completion=[ordered]@{startedAt=[DateTime]::UtcNow.ToString('o');status='running';mode=$mode;performanceQualified=$false;regressionBudget=.05;output=$out}
Write-Output ('Independent calibration and fresh baseline: '+$out)
if(-not $Smoke){Write-Output 'Normally about 80-100 minutes, including fixed cooldowns. Keep the computer idle until completion.'}
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
 $report=Get-Content -LiteralPath (Join-Path $out 'measurement/report.json') -Raw|ConvertFrom-Json
 if($exitCode -ne 0 -or $report.status -ne 'passed'){throw ('Sampling did not pass: '+$report.error+'; evidence: '+$out)}
 if(-not $Smoke){
  $unexpected=@()
  Get-Content -LiteralPath (Join-Path $out 'processes.jsonl')|ForEach-Object {
   $row=$_|ConvertFrom-Json
   foreach($process in $row.Processes){if($process.Name -match '^(ChatGPT|Codex|Code|EpicGamesLauncher|EpicWebHelper|steam|steamwebhelper|Taskmgr)$'){$unexpected+=,[ordered]@{at=$row.At;pid=$process.Pid;name=$process.Name}}}
  }
  $completion.backgroundApplicationObservations=$unexpected.Count
  if($unexpected.Count){$unexpected|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $out 'background-failures.json') -Encoding utf8;throw 'Background application observations invalidate this independent run'}
  & $node 'scripts/validate-framegraph-sampling.mjs' (Join-Path $out 'measurement') *> (Join-Path $out 'revalidation.log')
  if($LASTEXITCODE -ne 0){throw 'Independent validation failed; see revalidation.log'}
  $completion.status='development-baseline-passed'
 }else{$completion.status='engineering-smoke-passed'}
}catch{$failure=$_.Exception.Message;$completion.status='failed';$completion.error=$failure}
finally{
 if(Test-Path -LiteralPath $out){
  $completion.finishedAt=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllBytes((Join-Path $out 'entry.ps1'),$entryBytes)
  $completion|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $out 'completion.json') -Encoding utf8
 }
}
Write-Output ('Sampling status: '+$completion.status+'; '+$out)
Write-Output ('CPU restored: '+$completion.cpuRestored+'; Chrome GPU restored: '+$completion.gpuRestored+'; Search restored: '+$completion.serviceRestored)
if($failure){Write-Output $failure}
Write-Output 'Original 5% regression budget unchanged. Development evidence is not full G09/G05 release qualification.'
if($completion.status -notin @('development-baseline-passed','engineering-smoke-passed')){exit 1}