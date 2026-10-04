@echo off
setlocal
set "BOOT_ERP_NODE=%LOCALAPPDATA%\boot_erp\tools\node-v24.21.0-win-x64"
if not exist "%BOOT_ERP_NODE%\node.exe" (
  echo Node.js 24.21.0 is not prepared. See docs/environment.md.
  exit /b 1
)
set "PATH=%BOOT_ERP_NODE%;C:\Program Files\PostgreSQL\18\bin;%PATH%"
call npm.cmd --prefix "%~dp0..\tools\toolchain-check" %*
exit /b %ERRORLEVEL%
