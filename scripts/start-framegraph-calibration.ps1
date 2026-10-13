param([switch]$GpuStateDiagnostic,[switch]$Plan,[switch]$CheckPermissions,[switch]$CheckBuild,[switch]$PreflightOnly,[switch]$Smoke,[switch]$NoNotify,[switch]$Worker,[switch]$GuardOnly,[string]$DispatchDirectory)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$base=Join-Path $repository 'artifacts/engine-0.2.1/g09'
$shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-launch-permissions.ps1')
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-build-preflight.ps1')
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-background-policy.ps1')
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-desktop-preflight.ps1')
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-sampling-lease.ps1')
$permissions=Get-G09LaunchPermissionState
if($GpuStateDiagnostic -and ($CheckPermissions -or $CheckBuild -or $PreflightOnly -or $GuardOnly)){throw 'GPU diagnostic only combines with Plan or sampling modes'}
if(@(@($Plan,$CheckPermissions,$CheckBuild,$PreflightOnly)|Where-Object {$_}).Count -gt 1 -or (($Plan -or $CheckPermissions -or $CheckBuild -or $PreflightOnly) -and ($Smoke -or $NoNotify -or $Worker -or $GuardOnly))){throw 'Read-only modes cannot combine with sampling or each other'}
if($GuardOnly -and (-not $Smoke -or -not $NoNotify)){throw 'GuardOnly requires Smoke and NoNotify'}
if($CheckPermissions){$permissions|ConvertTo-Json;exit 0}
if($CheckBuild){Assert-G09DiagnosticBuild|ConvertTo-Json -Depth 6;exit 0}
if($Plan){$planArgs=@('-NoProfile','-File',(Join-Path $PSScriptRoot 'start-framegraph-unattended.ps1'),'-Plan');if($GpuStateDiagnostic){$planArgs+='-GpuStateDiagnostic'};& $shell @planArgs;exit $LASTEXITCODE}
if($NoNotify -and -not $Smoke){throw 'NoNotify is engineering Smoke only'}
if($PreflightOnly){
 $blocked=@(Get-G09GpuStartBlockers)
 [ordered]@{permissions=$permissions;blocked=$blocked;build=(Assert-G09DiagnosticBuild);settingsChanged=$false;samplingStarted=$false}|ConvertTo-Json -Depth 6
 exit 0
}
if(-not $permissions.administrator){throw '[G09_ADMIN_REQUIRED] 此启动进程未取得管理员权限。请从文件资源管理器右键 CMD，以管理员身份运行；尚未开始采样或修改设置。'}
if(-not $Worker){
 Write-Output ('[G09_ADMIN_OK] 管理员权限已确认，PID '+$PID)
 if(-not $Smoke){
  $blocked=@(Get-G09GpuStartBlockers)
  if($blocked.Count){Write-Output ('[G09_BACKGROUND_APPS] 管理员检查已通过。请完全退出以下应用，再从资源管理器启动；尚未更改设置：'+(Format-G09GpuStartBlockers $blocked));exit 3}
  Assert-G09DesktopReady|Out-Null
 }
 Assert-G09DiagnosticBuild|Out-Null
 $dispatchPrefix=if($GpuStateDiagnostic){'gpu-state-v5-dispatch-'}else{'sampling-v5-dispatch-'}
 $dispatch=Join-Path $base ($dispatchPrefix+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
 New-Item -ItemType Directory -Path $dispatch -ErrorAction Stop|Out-Null
 $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Worker -DispatchDirectory "'+$dispatch+'"'
 if($GpuStateDiagnostic){$arguments+=' -GpuStateDiagnostic'}
 if($Smoke){$arguments+=' -Smoke'};if($NoNotify){$arguments+=' -NoNotify'};if($GuardOnly){$arguments+=' -GuardOnly'}
 $workerProcess=Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dispatch 'worker.log') -RedirectStandardError (Join-Path $dispatch 'worker.stderr.log')
 try{
  $deadline=[DateTime]::UtcNow.AddSeconds(20);$startup=$null
  while([DateTime]::UtcNow -lt $deadline){
   if(Test-Path -LiteralPath (Join-Path $dispatch 'startup.json')){try{$startup=Get-Content -LiteralPath (Join-Path $dispatch 'startup.json') -Raw|ConvertFrom-Json}catch{}}
   if($startup -or $workerProcess.HasExited){break};Start-Sleep -Milliseconds 200
  }
  if(-not $startup -or $startup.status -ne 'ready'){throw ('后台启动未就绪；请检查记录，不要重复启动：'+$dispatch+'；'+$startup.error)}
  if(-not $NoNotify -and $GpuStateDiagnostic){Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show("单灯 A0/B4 连续 GPU 状态诊断已准备。`r`n点击确定后开始，预计 25–35 分钟。保持空闲，不要打开聊天应用、浏览器或任务管理器，也不要锁屏。`r`n`r`n双方相同负载、相同观察器，共三轮；诊断不直接生成基线。设置恢复后会弹窗。`r`n原 5% 预算不变。`r`n`r`n记录："+$dispatch,'G09 单灯 GPU 状态诊断')|Out-Null}
  if(-not $NoNotify -and -not $GpuStateDiagnostic){Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show("共同 CPU/GPU 预热校准及三轮全新基线已准备。`r`n点击确定后开始，预计 80–100 分钟，空闲等待可能延长。请勿重新打开聊天应用、浏览器或任务管理器，不要锁屏。`r`n`r`n任一校准不稳定将停止，不会继续重建基线。所有数据保留，5% 预算不变。`r`n完成并恢复设置后会弹窗。`r`n`r`n记录："+$dispatch,'G09 v5 校准及基线')|Out-Null}
  if($workerProcess.HasExited -or (Test-Path -LiteralPath (Join-Path $dispatch 'dispatch-completion.json'))){throw '启动确认已过期；未启动采样，请检查记录。'}
  [IO.File]::WriteAllText((Join-Path $dispatch 'acknowledged'),[DateTime]::UtcNow.ToString('o'))
  Write-Output ('Independent G09 worker started: '+$dispatch)
 }finally{$workerProcess.Dispose()}
 exit 0
}
$dispatch=[IO.Path]::GetFullPath($DispatchDirectory)
if(-not $dispatch.StartsWith([IO.Path]::GetFullPath($base)+'\',[StringComparison]::OrdinalIgnoreCase) -or -not(Test-Path -LiteralPath $dispatch -PathType Container)){throw 'Invalid dispatch path'}
$lease=$null;$child=$null;$result=$null;$code=1;$errorText=$null;$childStarted=$false
$out=Join-Path $dispatch 'run'
try{
 $lease=Enter-G09MainPassLease $base $dispatch
 if(@(Get-G09LegacyMainPassWorkers).Count){throw 'G09_LEGACY_RUNNING'}
 [ordered]@{status='ready';permissions=$permissions;settingsChanged=$false;guardHeld=$true;awaitingAcknowledgement=$true;run=$out}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $dispatch 'startup.json') -Encoding utf8
 $deadline=[DateTime]::UtcNow.AddMinutes(3)
 while(-not(Test-Path -LiteralPath (Join-Path $dispatch 'acknowledged'))){if([DateTime]::UtcNow -gt $deadline){throw 'Startup acknowledgement expired; sampling and settings changes did not start'};Start-Sleep -Milliseconds 200}
 if($GuardOnly){
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  while(-not(Test-Path -LiteralPath (Join-Path $dispatch 'release.guard'))){if([DateTime]::UtcNow -gt $deadline){throw 'Guard probe expired'};Start-Sleep -Milliseconds 200}
  $code=0
 }else{
 $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'start-framegraph-unattended.ps1')+'" -OutputDirectory "'+$out+'"'
 if($Smoke){$arguments+=' -Smoke'}
 if($GpuStateDiagnostic){$arguments+=' -GpuStateDiagnostic'}
 $child=Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dispatch 'sampling.log') -RedirectStandardError (Join-Path $dispatch 'sampling.stderr.log')
 $childStarted=$true
 $childHandle=$child.Handle
 $child.WaitForExit();$code=$child.ExitCode;$child.Dispose();$child=$null
 $result=Get-Content -LiteralPath (Join-Path $out 'completion.json') -Raw|ConvertFrom-Json
 if(-not $result.finishedAt -or -not($result.cpuRestored -and $result.gpuRestored -and $result.serviceRestored)){throw '采样未报告完整的设置恢复结果；请检查记录。'}
 }
}catch{
 $errorText=$_.Exception.Message;$code=1
 if(-not(Test-Path -LiteralPath (Join-Path $dispatch 'startup.json'))){[ordered]@{status='failed';error=$errorText;settingsChanged=$false}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $dispatch 'startup.json') -Encoding utf8}
}finally{
 if($null -ne $child){$child.WaitForExit();$child.Dispose()}
 if($null -ne $lease){$lease.Dispose()}
 [ordered]@{finishedAt=[DateTime]::UtcNow.ToString('o');run=$out;launcherExitCode=$code;error=$errorText;result=$result;leaseReleased=$true;guardOnly=[bool]$GuardOnly;childStarted=$childStarted;settingsChangedByGuard=$false;performanceQualified=$false}|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $dispatch 'dispatch-completion.json') -Encoding utf8
}
if(-not $NoNotify){
 Add-Type -AssemblyName System.Windows.Forms
 $message=if($code -eq 0 -and $result.status -eq 'gpu-state-diagnostic-complete'){'单灯 GPU 状态诊断已完成并复核，临时设置已恢复。请回到 Codex 分析，再决定共同条件和新基线。'}elseif($code -eq 0 -and $result.status -eq 'development-baseline-passed'){'共同预热校准与同机基线检查通过，临时设置已恢复。请回到 Codex 复核结果。'}else{'本轮未通过或需要检查。请回到 Codex 读取记录；不要直接重复采样。'}
 [System.Windows.Forms.MessageBox]::Show($message+"`r`n`r`n"+$out+"`r`n"+$errorText,'G09 独立任务结束')|Out-Null
}
exit $code
