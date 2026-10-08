param([string]$InitialState,[string]$InitialMode,[string]$OutputDirectory,[switch]$MissingDelayedStart,[switch]$FailDisable,[switch]$FailStop)
$ErrorActionPreference='Stop'
$global:G09ServiceMock=[ordered]@{State=$InitialState;StartMode=$InitialMode;Start=(@{Auto=2;Manual=3;Disabled=4}[$InitialMode]);DelayedAutoStart=1;HasDelayed=(-not $MissingDelayedStart)}
$global:G09ServiceCalls=[Collections.Generic.List[string]]::new()
function Get-CimInstance {
 param($ClassName,$Filter)
 if($ClassName -ne 'Win32_Service' -or $Filter -ne "Name='WSearch'"){throw 'Unexpected CIM query in service-only test'}
 [pscustomobject]@{State=$global:G09ServiceMock.State;StartMode=$global:G09ServiceMock.StartMode;ProcessId=0}
}
function Get-Service {param($Name) if($Name -ne 'WSearch'){throw 'Unexpected service'};[pscustomobject]@{DependentServices=@()}}
function Assert-RegistryPath($Path){if($Path -ne 'HKLM:\SYSTEM\CurrentControlSet\Services\WSearch'){throw 'Unexpected registry path'}}
function Get-ItemProperty {
 param($LiteralPath)
 Assert-RegistryPath $LiteralPath
 $value=[ordered]@{Start=$global:G09ServiceMock.Start}
 if($global:G09ServiceMock.HasDelayed){$value.DelayedAutoStart=$global:G09ServiceMock.DelayedAutoStart}
 [pscustomobject]$value
}
function Set-ItemProperty {param($LiteralPath,$Name,$Value) Assert-RegistryPath $LiteralPath;if($Name -ne 'DelayedAutoStart'){throw 'Unexpected property'};$global:G09ServiceMock.HasDelayed=$true;$global:G09ServiceMock.DelayedAutoStart=$Value}
function Remove-ItemProperty {param($LiteralPath,$Name) Assert-RegistryPath $LiteralPath;if($Name -ne 'DelayedAutoStart'){throw 'Unexpected property'};$global:G09ServiceMock.HasDelayed=$false}
function Start-Sleep {param($Seconds,$Milliseconds)}
function Invoke-CimMethod {
 param($InputObject,$MethodName,$Arguments)
 [void]$global:G09ServiceCalls.Add(($MethodName+':'+$Arguments.StartMode))
 switch($MethodName){
  'ChangeStartMode' {
   if($FailDisable -and $Arguments.StartMode -eq 'Disabled'){return [pscustomobject]@{ReturnValue=2}}
   $global:G09ServiceMock.StartMode=@{Automatic='Auto';Manual='Manual';Disabled='Disabled'}[$Arguments.StartMode]
   $global:G09ServiceMock.Start=@{Auto=2;Manual=3;Disabled=4}[$global:G09ServiceMock.StartMode]
   if($Arguments.StartMode -eq 'Automatic'){$global:G09ServiceMock.HasDelayed=$true;$global:G09ServiceMock.DelayedAutoStart=0}
  }
  'StopService' {if($FailStop){return [pscustomobject]@{ReturnValue=2}};if($global:G09ServiceMock.State -eq 'Stopped'){throw 'StopService called on an already stopped service'};$global:G09ServiceMock.State='Stopped'}
  'StartService' {if($global:G09ServiceMock.StartMode -eq 'Disabled'){throw 'Cannot start a disabled service'};$global:G09ServiceMock.State='Running'}
  default {throw 'Unexpected CIM method'}
 }
 [pscustomobject]@{ReturnValue=0}
}
$wrapper=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../run-framegraph-unattended.ps1'))
$failure=$null
try { & $wrapper -Mode ServiceCheck -OutputDirectory $OutputDirectory } catch { $failure=$_.Exception.Message }
$record=Get-Content -LiteralPath (Join-Path $OutputDirectory 'service-state.json') -Raw|ConvertFrom-Json
Write-Output ('SERVICE_TEST_RESULT='+([ordered]@{record=$record;calls=@($global:G09ServiceCalls);failure=$failure;final=$global:G09ServiceMock}|ConvertTo-Json -Depth 8 -Compress))
