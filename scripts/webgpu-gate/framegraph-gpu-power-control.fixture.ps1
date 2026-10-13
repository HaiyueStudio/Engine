param([string]$Scenario,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path $OutputDirectory -ErrorAction Stop|Out-Null
Add-Type -TypeDefinition @'
using System;
public sealed class G09NvPower:IDisposable {
 public sealed class Snapshot {
  public bool Found; public string ProfileName="Google Chrome",ApplicationName="chrome.exe";
  public uint ApplicationCount=1,SettingId=274197361,Type,Location,CurrentPredefined,PredefinedValid,PredefinedValue,Value;
  public Snapshot Copy(){return (Snapshot)MemberwiseClone();}
 }
 public static Snapshot Database=new Snapshot(); public static string Mode; public static int Writes; static bool mismatch;
 public Snapshot Read(){var s=Database.Copy();if(mismatch){mismatch=false;s.Value=0;}return s;}
 public void SetPreferMaximum(){SetValue(1);}
 public void SetValue(uint v){Writes++;Database.Found=true;Database.Value=v;
  if(Mode=="write-failure"&&v==1)throw new Exception("Injected save failure");
  if(Mode=="readback-mismatch"&&v==1)mismatch=true;
 }
 public void DeleteOverride(){Writes++;if(Mode=="restoration-failure")throw new Exception("Injected restoration failure");Database=new Snapshot();}
 public void Dispose(){}
}
'@
. (Join-Path $PSScriptRoot 'framegraph-gpu-power-control.ps1')
[G09NvPower]::Mode=$Scenario
if($Scenario -eq 'success-override'){[G09NvPower]::Database.Found=$true;[G09NvPower]::Database.Value=2}
if($Scenario -eq 'shared-profile'){[G09NvPower]::Database.ApplicationCount=2}
$before=Read-G09ChromePower
$record=$null;$failure=$null
try{
 $record=Start-G09ChromePower $OutputDirectory
 if($Scenario -eq 'capture-failure'){throw 'Injected capture failure'}
 if($Scenario -eq 'foreign-change'){[G09NvPower]::Database.Value=2}
}catch{$failure=$_.Exception.Message}
finally{
 if($null -ne $record){try{Stop-G09ChromePower $record}catch{$failure=$_.Exception.Message}}
}
$path=Join-Path $OutputDirectory 'gpu-power-state.json'
$journal=if(Test-Path -LiteralPath $path){Get-Content -LiteralPath $path -Raw|ConvertFrom-Json}else{$null}
$result=@{before=$before;after=(Read-G09ChromePower);writes=[G09NvPower]::Writes;failure=$failure;journal=$journal}
Write-Output ('GPU_TEST_RESULT='+($result|ConvertTo-Json -Depth 8 -Compress))