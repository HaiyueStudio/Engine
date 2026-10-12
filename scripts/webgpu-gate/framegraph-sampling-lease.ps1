function Enter-G09MainPassLease([string]$Directory,[string]$DispatchDirectory){
 $path=Join-Path $Directory 'gpu-main-pass-single-instance.lock'
 try{$stream=[IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)}catch [IO.IOException]{throw 'G09_ALREADY_RUNNING'}
 try{
  $owner=[ordered]@{pid=$PID;createdAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o');acquiredAt=[DateTime]::UtcNow.ToString('o');dispatch=$DispatchDirectory}
  $bytes=[Text.Encoding]::UTF8.GetBytes(($owner|ConvertTo-Json -Compress));$stream.SetLength(0);$stream.Write($bytes,0,$bytes.Length);$stream.Flush()
  return $stream
 }catch{$stream.Dispose();throw}
}
function Get-G09LegacyMainPassWorkers {
 @(Get-CimInstance Win32_Process|Where-Object {($_.ProcessId -ne $PID) -and (($_.Name -eq 'powershell.exe' -and $_.CommandLine -match ' -File .*(?:launch-gpu-main-pass-closed|launch-gpu-batch-(?:completion-(?:closed|desktop)|long)|start-framegraph-unattended|run-framegraph-unattended)\.ps1') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match '(?:profile-gpu-main-pass|profile-gpu-batch-(?:completion|long)|verify-framegraph-sampling)\.mjs'))}|Select-Object Name,ProcessId,CreationDate)
}
