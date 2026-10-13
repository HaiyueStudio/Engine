@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0start-framegraph-calibration.ps1" %*
set "G09_EXIT=%ERRORLEVEL%"
if /I "%~1"=="-Plan" exit /b %G09_EXIT%
echo.
echo FrameGraph sampler exit code: %G09_EXIT%
pause
exit /b %G09_EXIT%