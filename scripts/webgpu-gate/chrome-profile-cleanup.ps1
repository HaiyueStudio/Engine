param([string]$ProfilePath,[string]$BrowserPath,[string]$LaunchedAt,[switch]$LoadFunctionsOnly)
$ErrorActionPreference='Stop'

function Test-OwnedFixtureProcess($Candidate,[string]$ExpectedProfile,[string]$ExpectedBrowser,[datetime]$StartedAt) {
 if(-not $Candidate -or -not $Candidate.CommandLine -or -not $Candidate.ExecutablePath -or -not $Candidate.CreationDate){return $false}
 if(-not [string]::Equals($Candidate.ExecutablePath,$ExpectedBrowser,[StringComparison]::OrdinalIgnoreCase)){return $false}
 if($Candidate.CreationDate.ToUniversalTime() -lt $StartedAt.ToUniversalTime()){return $false}
 $escaped=[regex]::Escape($ExpectedProfile)
 $alternatives='"--user-data-dir='+$escaped+'"|--user-data-dir="'+$escaped+'"'
 if($ExpectedProfile -notmatch '\s'){$alternatives+='|--user-data-dir='+$escaped}
 $pattern='(?:^|\s)(?:'+$alternatives+')(?=\s|$)'
 return [regex]::IsMatch($Candidate.CommandLine,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Stop-OwnedFixtureProcess($Candidate,[string]$ExpectedProfile,[string]$ExpectedBrowser,[datetime]$StartedAt,
 [scriptblock]$OpenProcess={param($processId) Get-Process -Id $processId -ErrorAction SilentlyContinue},
 [scriptblock]$ReadProcess={param($processId) Get-CimInstance Win32_Process -Filter ('ProcessId='+$processId)},
 [scriptblock]$TerminateProcess={param($process) Stop-Process -InputObject $process -Force -ErrorAction Stop},
 [int]$WaitMilliseconds=2000) {
 $role='browser'
 if($Candidate.CommandLine -match '--utility-sub-type=([^\s"]+)'){$role=$Matches[1]}
 elseif($Candidate.CommandLine -match '--type=([^\s"]+)'){$role=$Matches[1]}
 $event=[ordered]@{pid=[int]$Candidate.ProcessId;role=$role;state='gone'}
 $owned=& $OpenProcess $Candidate.ProcessId
 if(-not $owned){return [pscustomobject]$event}
 try {
  # Pin this generation BEFORE querying its identity. If the PID is recycled
  # during the query, this retained handle is signalled and must not be killed.
  $null=$owned.Handle
  if($owned.HasExited){$event.exitSignaled=$owned.WaitForExit($WaitMilliseconds);$event.state=if($event.exitSignaled){'already-exited'}else{'exit-pending'};return [pscustomobject]$event}
  $current=& $ReadProcess $Candidate.ProcessId
  if($owned.HasExited){$event.exitSignaled=$owned.WaitForExit($WaitMilliseconds);$event.state=if($event.exitSignaled){'exited-during-query'}else{'exit-pending'};return [pscustomobject]$event}
  if(-not (Test-OwnedFixtureProcess $current $ExpectedProfile $ExpectedBrowser $StartedAt) -or $current.CreationDate -ne $Candidate.CreationDate){
   $event.state='identity-changed';return [pscustomobject]$event
  }
  # CIM's creation timestamp is compared with the same source, not with a
  # differently represented .NET timestamp. The live pinned handle prevents
  # PID reuse between the fresh identity query and termination.
  $event.creationUtc=$current.CreationDate.ToUniversalTime().ToString('o')
  & $TerminateProcess $owned
  $event.exitSignaled=$owned.WaitForExit($WaitMilliseconds)
  $event.state=if($event.exitSignaled){'terminated'}else{'exit-pending'}
  return [pscustomobject]$event
 }catch {
  if($owned.HasExited){$event.exitSignaled=$owned.WaitForExit($WaitMilliseconds);$event.state=if($event.exitSignaled){'exited-during-cleanup'}else{'exit-pending'};return [pscustomobject]$event}
  throw
 }finally{$owned.Dispose()}
}

function Get-OwnedFixtureProcessScan([string]$ExpectedProfile,[string]$ExpectedBrowser,[datetime]$StartedAt,
 [scriptblock]$ListProcesses={param($name) Get-CimInstance Win32_Process -Filter ("Name='"+$name+"'")},
 [scriptblock]$OpenProcess={param($processId) Get-Process -Id $processId -ErrorAction SilentlyContinue}) {
 $live=@();$events=@()
 foreach($candidate in @(& $ListProcesses ([IO.Path]::GetFileName($ExpectedBrowser)))){
  if(-not (Test-OwnedFixtureProcess $candidate $ExpectedProfile $ExpectedBrowser $StartedAt)){continue}
  $owned=& $OpenProcess $candidate.ProcessId
  if(-not $owned){$events+=@([pscustomobject]@{pid=[int]$candidate.ProcessId;state='gone-before-open'});continue}
  try {
   $null=$owned.Handle
   # Win32_Process may still enumerate an exited browser helper. Require an
   # exited AND signalled native handle before excluding such a row; a live or
   # still-exiting process remains a failure regardless of enumeration timing.
   if($owned.HasExited -and $owned.WaitForExit(0)){
    $events+=@([pscustomobject]@{pid=[int]$candidate.ProcessId;state='enumerated-after-exit';exitSignaled=$true})
   }else{$live+=@($candidate)}
  }finally{$owned.Dispose()}
 }
 return [pscustomobject]@{live=@($live);events=@($events)}
}

if($LoadFunctionsOnly){return}
if(-not $ProfilePath -or -not $BrowserPath -or -not $LaunchedAt){throw 'Owned fixture cleanup requires profile, executable and launch time'}
$profile=[IO.Path]::GetFullPath($ProfilePath)
$browser=[IO.Path]::GetFullPath($BrowserPath)
if(-not [IO.Path]::GetFileName($profile).StartsWith('haiyue-webgpu-gate-',[StringComparison]::Ordinal)){throw 'Unexpected fixture profile'}
$startedAt=[datetime]::Parse($LaunchedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)
$browserName=[IO.Path]::GetFileName($browser)
if($browserName -notin @('chrome.exe','msedge.exe')){throw 'Unexpected fixture browser executable'}
$terminated=@();$emptyPasses=0;$remaining=@();$events=@()
# Process termination is asynchronous: pending kernel I/O can outlive HasExited.
# This is a separate post-capture drain deadline, never a frame/sample budget.
$cleanupBudgetMs=60000
$timer=[Diagnostics.Stopwatch]::StartNew()
while($timer.ElapsedMilliseconds -lt $cleanupBudgetMs){
 $scan=Get-OwnedFixtureProcessScan $profile $browser $startedAt
 $remaining=@($scan.live);$events+=@($scan.events)
 if($remaining.Count -eq 0){
  $emptyPasses++
  if($emptyPasses -ge 2){break}
 }else{
  $emptyPasses=0
  foreach($candidate in $remaining){
   $waitMs=[int][math]::Max(0,[math]::Min(2000,$cleanupBudgetMs-$timer.ElapsedMilliseconds))
   if($waitMs -eq 0){break}
   $event=Stop-OwnedFixtureProcess $candidate $profile $browser $startedAt -WaitMilliseconds $waitMs
   $event | Add-Member -NotePropertyName elapsedMs -NotePropertyValue $timer.ElapsedMilliseconds
   $events+=@($event)
   if($event.state -eq 'terminated'){$terminated+=@($event.pid)}
  }
 }
 Start-Sleep -Milliseconds 200
}
$scan=Get-OwnedFixtureProcessScan $profile $browser $startedAt
$remaining=@($scan.live);$events+=@($scan.events)
if($remaining.Count -ne 0){throw ('Owned fixture browser processes remain after '+$timer.ElapsedMilliseconds+' ms: '+($remaining.ProcessId -join ', ')+'; cleanup events: '+(ConvertTo-Json -InputObject @($events) -Compress -Depth 4))}
[pscustomobject]@{status='passed';scope='Only this capture profile and executable, created after its launch; live handle pinned before identity query';terminatedPids=@($terminated | Sort-Object -Unique);remaining=0;cleanupBudgetMs=$cleanupBudgetMs;durationMs=$timer.ElapsedMilliseconds;events=@($events)} | ConvertTo-Json -Compress -Depth 4
