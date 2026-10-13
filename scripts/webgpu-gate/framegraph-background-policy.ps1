function Get-G09DiagnosticBlockingProcesses {
 param([object[]]$Processes, [switch]$AllowCodex)
 $names=@('ChatGPT','Codex','Code','EpicGamesLauncher','EpicWebHelper','steam','steamwebhelper','Taskmgr')
 if($AllowCodex){$names=@($names|Where-Object {$_ -notin @('ChatGPT','Codex')})}
 @($Processes|Where-Object {([IO.Path]::GetFileNameWithoutExtension($_.Name)) -in $names}|ForEach-Object {[pscustomobject]@{Name=$_.Name;Pid=$_.ProcessId}})
}
function Assert-G09DiagnosticHostClosed {
 $blocked=@(Get-G09DiagnosticBlockingProcesses -Processes @(Get-CimInstance Win32_Process))
 if($blocked.Count -gt 0){throw ('Close these background applications from their tray menus before sampling (nothing was terminated): '+(($blocked|ForEach-Object {$_.Name+' PID '+$_.Pid}) -join ', '))}
}
# Startup wait only. Reads process metadata; never terminates applications or changes power.
function Get-G09GpuStartBlockers {
 param([switch]$AllowCodex)
 $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
 @(Get-G09DiagnosticBlockingProcesses -Processes $processes -AllowCodex:$AllowCodex)
 @($processes | Where-Object {$_.Name -in @('chrome.exe','msedge.exe')} | ForEach-Object {[pscustomobject]@{Name=$_.Name;Pid=$_.ProcessId}})
}
function Format-G09GpuStartBlockers([object[]]$Processes) {
 (($Processes | Group-Object Name | Sort-Object Name | ForEach-Object {$_.Name+' ('+$_.Count+')'}) -join ', ')
}
function Assert-G09GpuDiagnosticReady {
 $blocked=@(Get-G09GpuStartBlockers)
 if($blocked.Count){throw ('Background applications reopened during sampling: '+(Format-G09GpuStartBlockers $blocked)+'. Close their windows or exit from the tray.')}
}
function Wait-G09GpuDiagnosticStart {
 param([ValidateRange(1,3600)][int]$TimeoutSeconds=300,[ValidateRange(10,10000)][int]$PollMilliseconds=2000)
 $clock=[Diagnostics.Stopwatch]::StartNew()
 $previous=$null
 while($true){
  $blocked=@(Get-G09GpuStartBlockers)
  if($blocked.Count -eq 0){Write-Host 'All required applications are closed. Starting diagnostic.';return}
  $summary=Format-G09GpuStartBlockers $blocked
  if($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds){throw ('Wait timed out. Still running: '+$summary+'. Sampling did not start; CPU/GPU settings were not changed.')}
  if($summary -ne $previous){Write-Host ('Waiting for: '+$summary+'. Close their windows or exit from the tray.');$previous=$summary}
  $remainingMs=[Math]::Max(1,($TimeoutSeconds-$clock.Elapsed.TotalSeconds)*1000)
  Start-Sleep -Milliseconds ([int][Math]::Min($PollMilliseconds,$remainingMs))
 }
}