@echo off
setlocal
cd /d "%~dp0.."
echo Verifying the frozen candidate and installed package files. Please wait for the test window.
"C:\Program Files\nodejs\node.exe" "artifacts/engine-0.2.3/g11/device-acceptance-20261107/focus-307771a/payload/start-device.mjs" keyboard-ime
set "G11_EXIT=%ERRORLEVEL%"
echo.
echo G11 physical collection exit code: %G11_EXIT%
echo Keep the evidence folder printed above. Physical acceptance requires review.
pause
exit /b %G11_EXIT%
