# A single temporary scheme spans correctness, calibration and the fresh baseline.
function Invoke-G09PowerConfig([string[]]$Arguments){
 $value=& "$env:SystemRoot/System32/powercfg.exe" @Arguments 2>&1
 if($LASTEXITCODE -ne 0){throw ('powercfg failed: '+($Arguments -join ' ')+'; '+($value -join ' '))}
 return ($value -join "`n")
}
function Read-G09PowerObservation {
 $value=& "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -File (Join-Path $PSScriptRoot 'framegraph-power-observation.ps1')
 if($LASTEXITCODE -ne 0){throw 'Could not observe processor power settings'}
 return ($value|ConvertFrom-Json)
}
function Save-G09PowerControl($State){$State|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $State.stateFile -Encoding utf8}
function Stop-G09PowerControl($State){
 try{
  Invoke-G09PowerConfig @('/setactive',$State.original)|Out-Null
  $State.after=Read-G09PowerObservation
  $State.restored=$State.after.schemeId -eq $State.original
  foreach($key in @('minimumAcPercent','maximumAcPercent','minimumDcPercent','maximumDcPercent')){
   if($State.after.$key -ne $State.before.$key){$State.restored=$false}
  }
  if(-not $State.restored){throw 'Original power scheme/settings restoration could not be verified'}
  if($State.created){
   Invoke-G09PowerConfig @('/delete',$State.temporary)|Out-Null
   $listed=Invoke-G09PowerConfig @('/list')
   if($listed.Contains($State.temporary)){throw 'Temporary power scheme remains after deletion'}
  }
  $State.removed=$true
 }catch{$State.restoreFailure=$_.Exception.Message;throw}
 finally{$State.finishedAt=[DateTime]::UtcNow.ToString('o');Save-G09PowerControl $State}
}
function Start-G09PowerControl([string]$OutputDirectory){
 $before=Read-G09PowerObservation
 if($before.schemaVersion -ne 1 -or $before.acLineStatus -ne 1 -or $before.maximumAcPercent -ne 100){throw 'Controlled sampling requires AC power and an original maximum processor state of 100%'}
 $state=[ordered]@{schemaVersion=1;contractId='g09-forward-cold-steady-v3';scope='Temporary common AC processor minimum 100% for all A0/B4 calibration and baseline captures';startedAt=[DateTime]::UtcNow.ToString('o');stateFile=(Join-Path $OutputDirectory 'power-state.json');original=$before.schemeId;temporary=[Guid]::NewGuid().ToString();before=$before;created=$false;activated=$false;restored=$false;removed=$false}
 Save-G09PowerControl $state
 try{
  Invoke-G09PowerConfig @('/duplicatescheme',$state.original,$state.temporary)|Out-Null
  $state.created=$true;Save-G09PowerControl $state
  Invoke-G09PowerConfig @('/setacvalueindex',$state.temporary,'SUB_PROCESSOR','PROCTHROTTLEMIN','100')|Out-Null
  Invoke-G09PowerConfig @('/setactive',$state.temporary)|Out-Null
  $state.activated=$true;$state.during=Read-G09PowerObservation
  if($state.during.schemeId -ne $state.temporary -or $state.during.acLineStatus -ne 1 -or $state.during.minimumAcPercent -ne 100 -or $state.during.maximumAcPercent -ne 100){throw 'Controlled processor power conditions did not take effect'}
  Save-G09PowerControl $state
  return $state
 }catch{
  $state.failure=$_.Exception.Message;Save-G09PowerControl $state
  Stop-G09PowerControl $state
  throw
 }
}
