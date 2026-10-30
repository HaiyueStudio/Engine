@echo off
setlocal
cd /d "%~dp0.."
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required. No publication started.
  pause
  exit /b 1
)
node.exe scripts\publication.mjs %*
set "publication_exit=%errorlevel%"
echo Publication controller exit code: %publication_exit%
echo Keep this output. Acceptance does not mean registry visibility or hash verification.
pause
exit /b %publication_exit%
