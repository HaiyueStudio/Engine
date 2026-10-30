@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
echo G13 physical gamepad - pinned current candidate. Keep this terminal open.
node scripts/run-g13-physical-candidate.mjs --profile=physical-gamepad %*
set "G13_EXIT=%ERRORLEVEL%"
echo.
echo Validation exit code: %G13_EXIT%
echo Saving evidence does not grant qualification; the original events are assessed separately.
pause
exit /b %G13_EXIT%
