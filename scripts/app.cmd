@echo off
setlocal
set "BOOT_ERP_NODE=%LOCALAPPDATA%\boot_erp\tools\node-v24.21.0-win-x64"
if exist "%BOOT_ERP_NODE%\node.exe" set "PATH=%BOOT_ERP_NODE%;%PATH%"
pushd "%~dp0.."
call npm.cmd %*
set "BOOT_ERP_EXIT=%ERRORLEVEL%"
popd
exit /b %BOOT_ERP_EXIT%
