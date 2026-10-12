@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-framegraph-calibration.ps1" -GpuStateDiagnostic %*
set "G09_EXIT=%ERRORLEVEL%"
if "%G09_EXIT%"=="0" exit /b 0
echo.
echo G09 did not start. Read the message above. No need to wait for completion.
pause
exit /b %G09_EXIT%
