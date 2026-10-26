@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where node.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found. This launcher requires the existing Node.js installation.
  pause
  exit /b 1
)
for /f "delims=" %%T in ('node -p "Date.now()"') do set "G13_RUN_ID=%%T"
if not defined G13_RUN_ID exit /b 1
set "G13_OUTPUT=artifacts/engine-0.2.2/g13/pad-user-start-70187df-%G13_RUN_ID%"
echo G13 physical gamepad validation - qualified package candidate 70187df
echo Output: %G13_OUTPUT%
echo A separate Chrome window will show the controller preparation page.
echo No administrator privileges are required. Keep this terminal open.
if /i "%~1"=="--plan" (
  echo PLAN ONLY: no browser was started and no evidence was accepted.
  echo node scripts/hya-corpus/qualify-physical.mjs --profile physical-gamepad --packages artifacts/engine-0.2.2/g13/packages-handoff-compact/public-packages.json --output %G13_OUTPUT%
  exit /b 0
)
node scripts/hya-corpus/qualify-physical.mjs --profile physical-gamepad --packages artifacts/engine-0.2.2/g13/packages-handoff-compact/public-packages.json --output "%G13_OUTPUT%"
set "G13_EXIT=%ERRORLEVEL%"
echo.
echo Validation exit code: %G13_EXIT%
echo Evidence: %G13_OUTPUT%
echo Saving a run does not grant qualification. Its raw data is assessed separately.
pause
exit /b %G13_EXIT%
