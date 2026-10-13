# Versioned development-sampling Chrome profile override. No global driver setting is written.
if(-not ('G09NvPower' -as [type])){Add-Type -Path (Join-Path $PSScriptRoot 'framegraph-nvapi-chrome-power.cs')}
function Read-G09ChromePower {
 $probe=[G09NvPower]::new()
 try{$probe.Read()}finally{$probe.Dispose()}
}
function Test-G09ChromePowerEqual($a,$b) {
 foreach($key in @('Found','ProfileName','ApplicationName','ApplicationCount','SettingId','Type','Location','CurrentPredefined','PredefinedValid','PredefinedValue','Value')){if($a.$key -ne $b.$key){return $false}}
 return $true
}
function Save-G09ChromePowerState($state) {
 [IO.File]::WriteAllText($state.stateFile,($state|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
function Stop-G09ChromePower($state) {
 $current=Read-G09ChromePower
 if(-not(Test-G09ChromePowerEqual $current $state.before)){
  if($current.ProfileName -ne $state.before.ProfileName -or $current.ApplicationName -ne 'chrome.exe' -or $current.ApplicationCount -ne 1 -or -not $current.Found -or $current.Value -ne 1 -or $current.Location -ne 0 -or $current.CurrentPredefined -ne 0){throw 'Chrome GPU power setting changed externally; saved journal retained, refusing to overwrite it'}
  $probe=[G09NvPower]::new()
  try {
   if($state.before.Found -and $state.before.Location -eq 0 -and $state.before.CurrentPredefined -eq 0){$probe.SetValue($state.before.Value)}else{$probe.DeleteOverride()}
  }finally{$probe.Dispose()}
 }
 $state.after=Read-G09ChromePower
 $state.restored=Test-G09ChromePowerEqual $state.after $state.before
 $state.finishedAt=[DateTime]::UtcNow.ToString('o')
 Save-G09ChromePowerState $state
 if(-not $state.restored){throw ('Chrome GPU power restore verification failed; journal: '+$state.stateFile)}
}
function Start-G09ChromePower([string]$OutputDirectory) {
 $before=Read-G09ChromePower
 if($before.ProfileName -ne 'Google Chrome' -or $before.ApplicationName -ne 'chrome.exe' -or $before.ApplicationCount -ne 1){throw 'Expected the existing single-application Google Chrome profile; no settings changed'}
 $path=Join-Path $OutputDirectory 'gpu-power-state.json'
 if(Test-Path -LiteralPath $path){throw 'Refusing to overwrite an existing GPU restoration journal'}
 $state=[ordered]@{schemaVersion=1;scope='Temporary Chrome-only prefer-maximum-performance sampling; not a GPU frequency lock or release qualification';stateFile=$path;startedAt=[DateTime]::UtcNow.ToString('o');before=$before;applied=$false;restored=$false;after=$null;finishedAt=$null}
 Save-G09ChromePowerState $state
 try {
  $probe=[G09NvPower]::new()
  try {if(-not(Test-G09ChromePowerEqual ($probe.Read()) $before)){throw 'Chrome GPU power policy changed before intervention'};$probe.SetPreferMaximum()}finally{$probe.Dispose()}
  $state.during=Read-G09ChromePower
  if(-not $state.during.Found -or $state.during.Value -ne 1 -or $state.during.Location -ne 0 -or $state.during.CurrentPredefined -ne 0){throw 'Chrome prefer-maximum-performance readback failed'}
  $state.applied=$true;Save-G09ChromePowerState $state
  return $state
 }catch {
  $failure=$_.Exception.Message
  try{Stop-G09ChromePower $state}catch{throw ($failure+'; restoration failed: '+$_.Exception.Message)}
  throw $failure
 }
}