@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
set "G13_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if /i "%~1"=="--plan" goto plan
"%G13_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-g13-production.ps1"
set "G13_EXIT=%ERRORLEVEL%"
echo.
echo G13 HYA production launcher exit code: %G13_EXIT%
echo No baseline was promoted and no version was published.
pause
exit /b %G13_EXIT%
:plan
"%G13_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-g13-production.ps1" -Plan
exit /b %ERRORLEVEL%
