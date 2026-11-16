@echo off
setlocal EnableExtensions DisableDelayedExpansion
if "%~1"=="" goto :usage
if /i "%~1"=="formal" goto :formal
node "%~dp0verify-visual-novel-acceptance.mjs" device --artifact "%~f1" --host windows
set "vn_exit=%errorlevel%"
goto :done

:formal
if "%~2"=="" goto :usage
if "%~3"=="" goto :usage
set "VN_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%VN_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0fixtures\visual-novel-acceptance\windows-formal.ps1" -Run "%~f2" -Device "%~f3"
set "vn_exit=%errorlevel%"
goto :done

:usage
echo Usage: %~nx0 DEVICE_KIT_DIR
echo        %~nx0 formal RUN_JSON DEVICE_KIT_DIR
exit /b 2

:done
echo G07 terminal exit code: %vn_exit%
pause
exit /b %vn_exit%
