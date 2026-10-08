param([ValidateSet('Full','Smoke','ServiceCheck','PowerCheck')][string]$Mode='Full',[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repository
$artifactRoot=[IO.Path]::GetFullPath((Join-Path $repository 'artifacts/engine-0.2.1/g09'))
$out=[IO.Path]::GetFullPath($OutputDirectory)
if(-not $out.StartsWith($artifactRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Output must stay inside G09 artifacts'}
if(Test-Path -LiteralPath $out){throw 'Use a fresh output directory; earlier populations must not be overwritten'}
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='safe.directory'
$env:GIT_CONFIG_VALUE_0=$repository
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class HostTraceRow { public int Pid; public string Name; public long Created; public double CpuMs; public double Percent; }
public class HostTraceSample { public string At; public double ElapsedMs; public double TotalPercent; public double CollectionMs; public int Unreadable; public List<HostTraceRow> Processes; }
public static class HostTrace {
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetSystemTimes(out long idle,out long kernel,out long user);
 static Dictionary<int,HostTraceRow> previous = new Dictionary<int,HostTraceRow>();
 static long lastIdle,lastKernel,lastUser,lastTime;
 public static HostTraceSample Read() {
  var started=Stopwatch.GetTimestamp(); long idle,kernel,user;
  if(!GetSystemTimes(out idle,out kernel,out user)) throw new Exception("GetSystemTimes failed");
  var rows=new List<HostTraceRow>(); var current=new Dictionary<int,HostTraceRow>(); int unreadable=0;
  double elapsed=(started-lastTime)*1000.0/Stopwatch.Frequency;
  foreach(var p in Process.GetProcesses()) {
   try {
    var row=new HostTraceRow {Pid=p.Id,Name=p.ProcessName,Created=p.StartTime.ToUniversalTime().Ticks,CpuMs=p.TotalProcessorTime.TotalMilliseconds};
    HostTraceRow old;
    if(previous.TryGetValue(row.Pid,out old)&&row.Created==old.Created&&elapsed>0)row.Percent=100*(row.CpuMs-old.CpuMs)/elapsed/Environment.ProcessorCount;
    current[row.Pid]=row;if(row.Pid!=0)rows.Add(row);
   }catch{unreadable++;}finally{p.Dispose();}
  }
  var total=(kernel-lastKernel)+(user-lastUser);
  var sample=new HostTraceSample {At=DateTime.UtcNow.ToString("o"),ElapsedMs=elapsed,TotalPercent=lastTime==0?0:100.0*(1.0-(double)(idle-lastIdle)/total),CollectionMs=(Stopwatch.GetTimestamp()-started)*1000.0/Stopwatch.Frequency,Unreadable=unreadable,Processes=rows};
  previous=current;lastIdle=idle;lastKernel=kernel;lastUser=user;lastTime=started;return sample;
 }
}
'@
New-Item -ItemType Directory -Path $out | Out-Null
if($Mode -eq 'PowerCheck'){
 . (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-power-control.ps1')
 $powerOnly=$null
 try{$powerOnly=Start-G09PowerControl $out}
 finally{if($null -ne $powerOnly){Stop-G09PowerControl $powerOnly}}
 Write-Output ('Processor power isolation and restoration verified; no service changes or timing samples: '+$out)
 exit 0
}
$service = Get-CimInstance Win32_Service -Filter "Name='WSearch'"
$serviceRegistryPath='HKLM:\SYSTEM\CurrentControlSet\Services\WSearch'
$serviceRegistry=Get-ItemProperty -LiteralPath $serviceRegistryPath
$scope = 'Independent G09 cold/steady calibration followed by fresh same-host baseline; no G05/G07 qualification'
$record = [ordered]@{ startedAt=[DateTime]::UtcNow.ToString('o'); scope=$scope; mode=$Mode; observerPid=$PID; before=($service|Select-Object State,StartMode,ProcessId); output=$out; captureExitCode=1; samplingStarted=$false }
$record.startupBefore=@{Start=$serviceRegistry.Start;HasDelayedAutoStart=($serviceRegistry.PSObject.Properties.Name -contains 'DelayedAutoStart');DelayedAutoStart=$serviceRegistry.DelayedAutoStart}
if($Mode -eq 'Full'){
 $record.applicationPreflight=@(Get-CimInstance Win32_Process -Filter "Name='Code.exe' OR Name='EpicGamesLauncher.exe' OR Name='EpicWebHelper.exe'"|Select-Object ProcessId,Name,CreationDate)
 if($record.applicationPreflight.Count){throw 'VS Code or Epic is still running; no applications will be terminated automatically.'}
}
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $out 'wrapper.ps1')
$record|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $out 'service-state.json') -Encoding utf8
$child = $null
$startupChanged=$false
. (Join-Path $PSScriptRoot 'webgpu-gate/framegraph-power-control.ps1')
$powerRecord=$null
try {
 if($Mode -ne 'ServiceCheck'){$powerRecord=Start-G09PowerControl $out}
try {
 if ($service.State -notin @('Running','Stopped')) { throw ('Windows Search is not in a stable running/stopped state: '+$service.State) }
 if (@((Get-Service WSearch).DependentServices|Where-Object Status -ne 'Stopped').Count) { throw 'Active dependent services' }
 # StopService alone allowed WSearch to restart during the previous population.
 # Prevent restart only for this capture, then restore the exact original startup settings.
 if($service.StartMode -ne 'Disabled'){
  $disable=Invoke-CimMethod -InputObject $service -MethodName ChangeStartMode -Arguments @{StartMode='Disabled'}
  if($disable.ReturnValue -ne 0){throw ('Could not prevent WSearch restart: '+$disable.ReturnValue)}
  $startupChanged=$true
  $record.startupTemporarilyDisabledAt=[DateTime]::UtcNow.ToString('o')
  $record|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $out 'service-state.json') -Encoding utf8
 }
 $now=Get-CimInstance Win32_Service -Filter "Name='WSearch'"
 if ($now.State -ne 'Stopped' -and (Invoke-CimMethod -InputObject $now -MethodName StopService).ReturnValue -ne 0) { throw 'StopService failed' }
 $deadline=[DateTime]::UtcNow.AddSeconds(60)
 do { Start-Sleep -Seconds 1; $now=Get-CimInstance Win32_Service -Filter "Name='WSearch'"; if([DateTime]::UtcNow -gt $deadline){throw 'Service stop timeout'} } until($now.State -eq 'Stopped')
 $record.stoppedAt=[DateTime]::UtcNow.ToString('o')
 $record.isolated=$now|Select-Object State,StartMode,ProcessId
 if($now.StartMode -ne 'Disabled'){throw 'Windows Search restart prevention did not take effect'}
 $record|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $out 'service-state.json') -Encoding utf8
 if($Mode -eq 'ServiceCheck'){
  $record.serviceCheckOnly=$true
  $record.captureExitCode=0
  Write-Output ('Search isolation check passed; no timing samples collected: '+$out)
 }else{
 Write-Output ('Independent sampler started: ' + $out)
 $node=(Get-Command node).Source
 $arguments = @('scripts/verify-framegraph-sampling.mjs',('--'+$Mode.ToLowerInvariant()),('"'+(Join-Path $out 'measurement')+'"'))
 $record.command = @($node) + $arguments
 $child=Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $out 'events.jsonl') -RedirectStandardError (Join-Path $out 'stderr.log')
 $record.childPid=$child.Id
 $record.samplingStarted=$true
 $record|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $out 'service-state.json') -Encoding utf8
 [HostTrace]::Read()|Out-Null
 $trace=[IO.StreamWriter]::new((Join-Path $out 'processes.jsonl'),$false)
 try {
  $tick=0
  do {
   Start-Sleep -Milliseconds 1000
   $sample=[HostTrace]::Read()
   $trace.WriteLine(($sample|ConvertTo-Json -Depth 5 -Compress))
   $trace.Flush()
   $tick++
   if($tick%2 -eq 0){
    $frequency=[ordered]@{At=[DateTime]::UtcNow.ToString('o');Cores=@(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation|Select-Object Name,ProcessorFrequency,PercentProcessorPerformance,PercentProcessorUtility)}
    $frequency|ConvertTo-Json -Depth 4 -Compress|Add-Content -LiteralPath (Join-Path $out 'frequency.jsonl') -Encoding utf8
   }
   # File-only telemetry: do not refresh an interactive UI inside timing windows.
  } until($child.HasExited)
 } finally { $trace.Dispose() }
 $child.WaitForExit();$record.captureExitCode=$child.ExitCode
 }
 $record.isolatedAtEnd=Get-CimInstance Win32_Service -Filter "Name='WSearch'"|Select-Object State,StartMode,ProcessId
 if($record.isolatedAtEnd.State -ne 'Stopped' -or $record.isolatedAtEnd.StartMode -ne 'Disabled'){$record.captureExitCode=1;$record.isolationError='Windows Search changed during capture'}
} catch {
 $record.failure=$_.Exception.Message
 $record.captureExitCode=1
 throw
} finally {
 if($null -ne $child -and -not $child.HasExited){
  # Capture the owned process tree before stopping the Node worker. Do not touch other browsers.
  $all=Get-CimInstance Win32_Process
  $owned=[Collections.Generic.HashSet[int]]::new();[void]$owned.Add($child.Id)
  do{$added=$false;foreach($p in $all){if($owned.Contains([int]$p.ParentProcessId) -and $owned.Add([int]$p.ProcessId)){$added=$true}}}while($added)
  foreach($p in @($all|Where-Object {$owned.Contains([int]$_.ProcessId)})){
   $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ProcessId)
   if($current -and $current.CreationDate -eq $p.CreationDate){Stop-Process -Id $p.ProcessId -ErrorAction Continue}
  }
  $record.interrupted=$true
 }
 $now=Get-CimInstance Win32_Service -Filter "Name='WSearch'"
 if($startupChanged){
  $originalMode=switch($service.StartMode){'Auto'{'Automatic'} 'Manual'{'Manual'} 'Disabled'{'Disabled'} default {throw 'Unsupported original WSearch start mode'}}
  $restoreMode=Invoke-CimMethod -InputObject $now -MethodName ChangeStartMode -Arguments @{StartMode=$originalMode}
  if($restoreMode.ReturnValue -ne 0){throw ('WSearch startup restoration failed: '+$restoreMode.ReturnValue)}
  $currentRegistry=Get-ItemProperty -LiteralPath $serviceRegistryPath
  if($record.startupBefore.HasDelayedAutoStart){
   if($currentRegistry.DelayedAutoStart -ne $record.startupBefore.DelayedAutoStart){Set-ItemProperty -LiteralPath $serviceRegistryPath -Name DelayedAutoStart -Value $record.startupBefore.DelayedAutoStart}
  }elseif($currentRegistry.PSObject.Properties.Name -contains 'DelayedAutoStart'){Remove-ItemProperty -LiteralPath $serviceRegistryPath -Name DelayedAutoStart}
  $now=Get-CimInstance Win32_Service -Filter "Name='WSearch'"
 }
 if($service.State -eq 'Running' -and $now.State -ne 'Running'){
  # A running service can have disabled startup; enable only long enough to restore it.
  $restoreDisabledStartup=$now.StartMode -eq 'Disabled'
  if($restoreDisabledStartup){
   $ret=(Invoke-CimMethod -InputObject $now -MethodName ChangeStartMode -Arguments @{StartMode='Manual'}).ReturnValue
   if($ret -ne 0){throw ('Could not temporarily enable WSearch restoration: '+$ret)}
   $now=Get-CimInstance Win32_Service -Filter "Name='WSearch'"
  }
  try {
  $ret=(Invoke-CimMethod -InputObject $now -MethodName StartService).ReturnValue
  if($ret -notin @(0,10)){throw ('Service restore failed: '+$ret)}
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  do {Start-Sleep -Seconds 1;$now=Get-CimInstance Win32_Service -Filter "Name='WSearch'";if([DateTime]::UtcNow -gt $deadline){throw 'Service restore timeout'}} until($now.State -eq 'Running')
  }finally{
   if($restoreDisabledStartup){
    $ret=(Invoke-CimMethod -InputObject $now -MethodName ChangeStartMode -Arguments @{StartMode='Disabled'}).ReturnValue
    if($ret -ne 0){throw ('Could not restore disabled WSearch startup: '+$ret)}
    $now=Get-CimInstance Win32_Service -Filter "Name='WSearch'"
   }
  }
 }elseif($service.State -eq 'Stopped' -and $now.State -ne 'Stopped'){
  $ret=(Invoke-CimMethod -InputObject $now -MethodName StopService).ReturnValue
  if($ret -ne 0){throw ('Could not restore stopped WSearch state: '+$ret)}
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  do {Start-Sleep -Seconds 1;$now=Get-CimInstance Win32_Service -Filter "Name='WSearch'";if([DateTime]::UtcNow -gt $deadline){throw 'Service stop restoration timeout'}} until($now.State -eq 'Stopped')
 }
 $record.after=$now|Select-Object State,StartMode,ProcessId
 $currentRegistry=Get-ItemProperty -LiteralPath $serviceRegistryPath
 $record.startupAfter=@{Start=$currentRegistry.Start;HasDelayedAutoStart=($currentRegistry.PSObject.Properties.Name -contains 'DelayedAutoStart');DelayedAutoStart=$currentRegistry.DelayedAutoStart}
 $record.restored=$now.State -eq $service.State -and $now.StartMode -eq $service.StartMode -and $record.startupAfter.Start -eq $record.startupBefore.Start -and $record.startupAfter.HasDelayedAutoStart -eq $record.startupBefore.HasDelayedAutoStart -and $record.startupAfter.DelayedAutoStart -eq $record.startupBefore.DelayedAutoStart
 $record.finishedAt=[DateTime]::UtcNow.ToString('o')
 $record|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $out 'service-state.json') -Encoding utf8
 Write-Output ('Windows Search restored: ' + $record.restored + '; ' + $out)
 if(-not $record.restored){throw 'Windows Search restoration check failed'}
}
}finally{
 if($null -ne $powerRecord){
  Stop-G09PowerControl $powerRecord
  Write-Output ('Original power scheme restored: '+$powerRecord.restored+'; temporary scheme removed: '+$powerRecord.removed)
 }
}
if($record.captureExitCode -ne 0){exit 1}
