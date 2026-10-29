@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
set "G13_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if /i "%~1"=="--plan" goto plan
"%G13_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-g13-windows-gates.ps1"
set "G13_EXIT=%ERRORLEVEL%"
echo.
echo G13 global gate and rehearsal exit code: %G13_EXIT%
echo Original failures retained. No version published.
pause
exit /b %G13_EXIT%
:plan
"%G13_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-g13-windows-gates.ps1" -Plan
exit /b %ERRORLEVEL%
