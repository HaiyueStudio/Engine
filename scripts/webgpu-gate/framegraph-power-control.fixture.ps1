param([string]$Scenario,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'framegraph-power-control.ps1')
$script:originalId='381b4222-f694-41f0-9685-ff5bb260df2e'
$script:activeId=$script:originalId;$script:temporaryId=$null;$script:copyExists=$false;$script:minimum=5;$script:calls=@()
function Read-G09PowerObservation {
 $ac=1;$max=100;if($Scenario -eq 'battery'){$ac=0};if($Scenario -eq 'max-limited'){$max=99}
 $min=5;if($script:activeId -ne $script:originalId){$min=$script:minimum;if($Scenario -eq 'readback-mismatch'){$min=99}}
 return [pscustomobject]@{schemaVersion=1;schemeId=$script:activeId;acLineStatus=$ac;minimumAcPercent=$min;maximumAcPercent=$max;minimumDcPercent=5;maximumDcPercent=100}
}
function Invoke-G09PowerConfig([string[]]$Arguments){
 $script:calls+=,($Arguments -join ' ')
 switch($Arguments[0]){
  '/duplicatescheme' {$script:temporaryId=$Arguments[2];$script:copyExists=$true}
  '/setacvalueindex' {if($Arguments[1] -eq $script:originalId){throw 'Original scheme edited'};$script:minimum=[int]$Arguments[4]}
  '/setactive' {
   if($Arguments[1] -ne $script:originalId -and $Scenario -eq 'activation-failure'){throw 'injected activation failure'}
   if($Arguments[1] -eq $script:originalId -and $Scenario -eq 'restoration-failure'){throw 'injected restoration failure'}
   $script:activeId=$Arguments[1]
  }
  '/delete' {if($Arguments[1] -ne $script:temporaryId -or $script:activeId -ne $script:originalId){throw 'Unsafe scheme deletion'};if($Scenario -eq 'deletion-failure'){throw 'injected deletion failure'};$script:copyExists=$false}
  '/list' {return ($script:originalId+$(if($script:copyExists){' '+$script:temporaryId}))}
  default {throw 'Unexpected power command'}
 }
 return 'ok'
}
New-Item -ItemType Directory -Path $OutputDirectory|Out-Null
$record=$null;$failure=$null
try{
 try{$record=Start-G09PowerControl $OutputDirectory;if($Scenario -eq 'capture-failure'){throw 'injected capture failure'}}
 finally{if($null -ne $record){Stop-G09PowerControl $record}}
}catch{$failure=$_.Exception.Message}
$saved=$null;$stateFile=Join-Path $OutputDirectory 'power-state.json'
if(Test-Path -LiteralPath $stateFile){$saved=Get-Content -Raw -LiteralPath $stateFile|ConvertFrom-Json}
Write-Output ('POWER_TEST_RESULT='+([ordered]@{failure=$failure;record=$saved;calls=$script:calls;active=$script:activeId;copyExists=$script:copyExists}|ConvertTo-Json -Depth 8 -Compress))
