@echo off
setlocal
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" "artifacts/engine-0.2.3/g11/launch-physical-current.mjs" keyboard-ime
set "G11_EXIT=%ERRORLEVEL%"
echo.
echo G11 physical collection exit code: %G11_EXIT%
echo Keep the evidence path printed above. This did not publish anything.
pause
exit /b %G11_EXIT%
