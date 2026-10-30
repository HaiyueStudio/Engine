@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
set "G13_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if /i "%~1"=="--plan" goto plan
"%G13_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-g13-windows-final.ps1"
set "G13_EXIT=%ERRORLEVEL%"
echo.
echo G13 Windows validation exit code: %G13_EXIT%
echo The final status and evidence folder are printed above. No version was published.
pause
exit /b %G13_EXIT%
:plan
"%G13_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-g13-windows-final.ps1" -Plan
exit /b %ERRORLEVEL%
