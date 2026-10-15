$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'chrome-profile-cleanup.ps1') -LoadFunctionsOnly
$profile='D:\Test Space\haiyue-webgpu-gate-owned'
$browser='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$started=[datetime]'2026-10-13T12:00:00Z'
function Candidate([string]$command,[string]$executable=$browser,[datetime]$created=$started.AddSeconds(1)){
 [pscustomobject]@{CommandLine=$command;ExecutablePath=$executable;CreationDate=$created;ProcessId=7}
}
$checks=0
foreach($command in @(
 ('"'+$browser+'" --type=utility --user-data-dir="'+$profile+'" /prefetch:8'),
 ('"'+$browser+'" "--user-data-dir='+$profile+'"')
)){
 if(-not (Test-OwnedFixtureProcess (Candidate $command) $profile $browser $started)){throw ('Expected owned command: '+$command)}
 $checks++
}
$unquotedProfile='D:\Test\haiyue-webgpu-gate-owned'
if(-not (Test-OwnedFixtureProcess (Candidate ('msedge.exe --user-data-dir='+$unquotedProfile+' --type=crashpad-handler')) $unquotedProfile $browser $started)){throw 'Unquoted path without spaces did not match'}
$checks++
foreach($candidate in @(
 (Candidate ('msedge.exe --user-data-dir='+$profile+' --type=utility')),
 (Candidate ('msedge.exe --user-data-dir="'+$profile+'-different"')),
 (Candidate ('msedge.exe --user-data-dir="'+$profile+'\child"')),
 (Candidate ('msedge.exe --something="'+$profile+'"')),
 (Candidate 'msedge.exe --user-data-dir="C:\Users\User\Browser"'),
 (Candidate ('msedge.exe --user-data-dir="'+$profile+'"') 'C:\Other\msedge.exe'),
 (Candidate ('msedge.exe --user-data-dir="'+$profile+'"') $browser $started.AddSeconds(-1)),
 ([pscustomobject]@{CommandLine=('msedge.exe --user-data-dir="'+$profile+'"');CreationDate=$started;ExecutablePath=$null}),
 $null
)){
 if(Test-OwnedFixtureProcess $candidate $profile $browser $started){throw 'Unrelated or unidentified process matched'}
 $checks++
}
$ownedCandidate=Candidate ('msedge.exe --user-data-dir="'+$profile+'"')
foreach($scenario in @('live','timestamp-representation-differs','recycled-during-query','recycled-pending','wrong-profile','changed-generation','missing-identity','already-exited','already-exited-pending','missing-process','exit-pending','termination-error')){
 $script:order=New-Object 'Collections.Generic.List[string]'
 $script:fake=[pscustomobject]@{Exited=($scenario -like 'already-exited*');Disposed=$false;LastWait=0;StartTime=$(if($scenario -eq 'timestamp-representation-differs'){$started.AddHours(-1)}else{$ownedCandidate.CreationDate})}
 $script:fake | Add-Member ScriptProperty Handle {$script:order.Add('pin');return 123}
 $script:fake | Add-Member ScriptProperty HasExited {return $this.Exited}
 $script:fake | Add-Member ScriptMethod WaitForExit {param($milliseconds) $this.LastWait=$milliseconds;$script:order.Add('wait');return ($this.Exited -and $scenario -notin @('already-exited-pending','recycled-pending'))}
 $script:fake | Add-Member ScriptMethod Dispose {$this.Disposed=$true;$script:order.Add('dispose')}
 $open={param($processId) if($scenario -ne 'missing-process'){$script:fake}}
 $read={param($processId)
  $script:order.Add('query')
  if($scenario -in @('recycled-during-query','recycled-pending')){$script:fake.Exited=$true}
  if($scenario -eq 'missing-identity'){return $null}
  if($scenario -eq 'wrong-profile'){return (Candidate 'msedge.exe --user-data-dir="D:\UserProfile"')}
  if($scenario -eq 'changed-generation'){return (Candidate ('msedge.exe --user-data-dir="'+$profile+'"') $browser $started.AddSeconds(2))}
  return $ownedCandidate
 }
 $terminate={param($process)
  $script:order.Add('terminate')
  if($scenario -eq 'termination-error'){throw 'controlled termination failure'}
  if($scenario -ne 'exit-pending'){$process.Exited=$true}
 }
 $errorSeen=$false
 try{$result=Stop-OwnedFixtureProcess $ownedCandidate $profile $browser $started $open $read $terminate -WaitMilliseconds 17}
 catch{if($scenario -ne 'termination-error' -or $_ -notmatch 'controlled termination failure'){throw};$errorSeen=$true}
 if($scenario -eq 'termination-error'){
  if(-not $errorSeen){throw 'Termination failure was suppressed'}
 }else{
  $expected=switch($scenario){
   'live' {'terminated'}
   'timestamp-representation-differs' {'terminated'}
   'recycled-during-query' {'exited-during-query'}
   'already-exited' {'already-exited'}
   'already-exited-pending' {'exit-pending'}
   'recycled-pending' {'exit-pending'}
   'missing-process' {'gone'}
   'exit-pending' {'exit-pending'}
   default {'identity-changed'}
  }
  if($result.state -ne $expected){throw ("Unexpected state for ${scenario}: "+$result.state)}
 }
 $shouldTerminate=$scenario -in @('live','timestamp-representation-differs','exit-pending','termination-error')
 if($script:order.Contains('terminate') -ne $shouldTerminate){throw ('Unsafe termination decision: '+$scenario)}
 if($script:order.Contains('query') -and $script:order.IndexOf('pin') -ge $script:order.IndexOf('query')){throw 'Identity queried before pinning the process generation'}
 if($script:order.Contains('wait') -and $script:fake.LastWait -ne 17){throw 'Caller deadline slice was not respected'}
 if($scenario -ne 'missing-process' -and -not $script:fake.Disposed){throw 'Native process handle leaked'}
 $checks++
}
foreach($scenario in @('live','exited-and-signaled','exited-not-signaled','gone','foreign')){
 $script:fake=[pscustomobject]@{HasExited=($scenario -like 'exited-*');Handle=123;Disposed=$false;Signaled=($scenario -eq 'exited-and-signaled')}
 $script:fake | Add-Member ScriptMethod WaitForExit {param($milliseconds) return $this.Signaled}
 $script:fake | Add-Member ScriptMethod Dispose {$this.Disposed=$true}
 $list={param($name) if($scenario -eq 'foreign'){Candidate 'msedge.exe --user-data-dir="D:\UserProfile"'}else{$ownedCandidate}}
 $open={param($processId) if($scenario -ne 'gone'){$script:fake}}
 $scan=Get-OwnedFixtureProcessScan $profile $browser $started $list $open
 $expectedLive=if($scenario -in @('live','exited-not-signaled')){1}else{0}
 if($scan.live.Count -ne $expectedLive){throw ('Incorrect live residual classification: '+$scenario)}
 if($scenario -eq 'exited-and-signaled' -and ($scan.events[0].state -ne 'enumerated-after-exit' -or $scan.events[0].exitSignaled -ne $true)){throw 'Missing native exit proof'}
 if($scenario -notin @('foreign','gone') -and -not $script:fake.Disposed){throw 'Scan handle leaked'}
 $checks++
}
Write-Output ('Owned-process policy checks passed: '+$checks)
