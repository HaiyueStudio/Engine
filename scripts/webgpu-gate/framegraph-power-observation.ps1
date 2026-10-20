$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class G09PowerStatus {
 [StructLayout(LayoutKind.Sequential)] public struct Status { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public uint BatteryLifeTime; public uint BatteryFullLifeTime; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetSystemPowerStatus(out Status status);
 public static int ReadAC() { Status status; if(!GetSystemPowerStatus(out status))throw new Exception("GetSystemPowerStatus failed");return status.ACLineStatus; }
}
'@
function Read-G09PowerConfig([string[]]$Arguments){
 $text=& "$env:SystemRoot/System32/powercfg.exe" @Arguments 2>&1
 if($LASTEXITCODE -ne 0){throw ('Power observation failed: '+($text -join ' '))}
 return ($text -join "`n")
}
function Get-G09SchemeId([string]$Text){return [regex]::Match($Text,'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}').Value.ToLowerInvariant()}
$scheme=Get-G09SchemeId (Read-G09PowerConfig @('/getactivescheme'))
if(-not $scheme){throw 'Active power scheme was not observed'}
function Read-G09Setting([string]$Alias){
 $text=Read-G09PowerConfig @('/query',$scheme,'SUB_PROCESSOR',$Alias)
 $values=@([regex]::Matches($text,'0x([a-fA-F0-9]{8})')|ForEach-Object {[Convert]::ToInt32($_.Groups[1].Value,16)})
 # powercfg reports range min/max/increment, then the current AC/DC indices.
 if($values.Count -ne 5 -or $values[-2] -notin (0..100) -or $values[-1] -notin (0..100)){throw ('Unexpected CPU power setting output: '+$Alias)}
 return @($values[-2],$values[-1])
}
$minimum=Read-G09Setting 'PROCTHROTTLEMIN';$maximum=Read-G09Setting 'PROCTHROTTLEMAX'
if((Get-G09SchemeId (Read-G09PowerConfig @('/getactivescheme'))) -ne $scheme){throw 'Power scheme changed during observation'}
[ordered]@{schemaVersion=1;schemeId=$scheme;acLineStatus=[G09PowerStatus]::ReadAC();minimumAcPercent=$minimum[0];maximumAcPercent=$maximum[0];minimumDcPercent=$minimum[1];maximumDcPercent=$maximum[1]}|ConvertTo-Json -Compress
