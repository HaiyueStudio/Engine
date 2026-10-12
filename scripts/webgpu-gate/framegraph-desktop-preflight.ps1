function Get-G09DesktopSnapshot {
 param([datetime]$SinceUtc=[datetime]::MinValue)
 $preferences=Get-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop'
 $policyPath='HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop'
 $policy=$null;if(Test-Path -LiteralPath $policyPath){$policy=Get-ItemProperty -LiteralPath $policyPath}
 function Value-Of($name){if($null -ne $policy -and $null -ne $policy.PSObject.Properties[$name]){return $policy.$name};return $preferences.$name}
 $machine=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
 $session=(Get-Process -Id $PID).SessionId;$readable=$true;$last=$null;$locks=0;$errorText=$null
 try{
  $filter=@{LogName='Security';Id=@(4800,4801)}
  if($SinceUtc -gt [datetime]::MinValue){$filter.StartTime=$SinceUtc.ToLocalTime();$events=@(Get-WinEvent -FilterHashtable $filter -ErrorAction Stop)}else{$events=@(Get-WinEvent -FilterHashtable $filter -MaxEvents 128 -ErrorAction Stop)}
  foreach($e in $events){$x=[xml]$e.ToXml();$sid=@($x.Event.EventData.Data|Where-Object {$_.Name -eq 'SessionId'})[0].'#text';if([int]$sid -ne $session){continue};if($null -eq $last){$last=$e.Id};if($SinceUtc -gt [datetime]::MinValue -and $e.Id -eq 4800){$locks++}}
 }catch{if($_.FullyQualifiedErrorId -notmatch 'NoMatchingEventsFound'){$readable=$false;$errorText=$_.Exception.Message}}
 [ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');sessionId=$session;screenSaver=[ordered]@{active=((Value-Of 'ScreenSaveActive') -eq '1');secure=((Value-Of 'ScreenSaverIsSecure') -eq '1');timeoutSeconds=[int](Value-Of 'ScreenSaveTimeOut');executable=(Value-Of 'SCRNSAVE.EXE')};machineInactivitySeconds=[int]$machine.InactivityTimeoutSecs;securityLogReadable=$readable;securityLogError=$errorText;currentlyLocked=($last -eq 4800);lockEventsSinceStart=$locks;sinceUtc=$(if($SinceUtc -gt [datetime]::MinValue){$SinceUtc.ToUniversalTime().ToString('o')}else{$null})}
}
function Assert-G09DesktopReady {
 param([datetime]$SinceUtc=[datetime]::MinValue,[string]$EvidencePath)
 $snapshot=Get-G09DesktopSnapshot
 if($SinceUtc -gt [datetime]::MinValue){$history=Get-G09DesktopSnapshot -SinceUtc $SinceUtc;$snapshot.lockEventsSinceStart=$history.lockEventsSinceStart;$snapshot.sinceUtc=$history.sinceUtc;if(-not $history.securityLogReadable){$snapshot.securityLogReadable=$false;$snapshot.securityLogError=$history.securityLogError}}
 $json=$snapshot|ConvertTo-Json -Depth 5
 $text=$json | & (Join-Path $env:ProgramFiles 'nodejs/node.exe') (Join-Path $PSScriptRoot 'check-framegraph-desktop.mjs')
 $exitCode=$LASTEXITCODE
 if($EvidencePath){[IO.File]::WriteAllText($EvidencePath,($text -join [Environment]::NewLine),[Text.UTF8Encoding]::new($false))}
 $result=$text|ConvertFrom-Json
 if($exitCode -ne 0){throw ('G09_DESKTOP_NOT_READY: '+($result.reasons -join '; ')+'. No desktop settings were changed. Check screen-saver login protection before retrying.')}
 return $result
}