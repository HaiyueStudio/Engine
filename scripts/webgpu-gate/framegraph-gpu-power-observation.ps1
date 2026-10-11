$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -eq 5){$env:PSModulePath=Join-Path $PSHOME 'Modules'}
. (Join-Path $PSScriptRoot 'framegraph-gpu-power-control.ps1')
Read-G09ChromePower|ConvertTo-Json -Depth 4 -Compress
