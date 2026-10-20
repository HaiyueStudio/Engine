# Read the effective process token, not the account name or group configuration.
function Get-G09LaunchPermissionState {
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 try{
  $principal=New-Object Security.Principal.WindowsPrincipal($identity)
  [ordered]@{
   administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
   identity=$identity.Name
   processId=$PID
   executable=(Join-Path $PSHOME $(if($PSVersionTable.PSVersion.Major -le 5){'powershell.exe'}else{'pwsh.exe'}))
   powershellVersion=$PSVersionTable.PSVersion.ToString()
   method='WindowsPrincipal.IsInRole(Administrator)'
  }
 }finally{$identity.Dispose()}
}
