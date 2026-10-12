@echo off
setlocal
title Token Monitor
cd /d "%~dp0"
set "NODE_HOME=G:\D file\Nodejs24\node-v24.18.0-win-x64"
set "PATH=%NODE_HOME%;%PATH%"
REM Electron 43+ downloads its binary on first launch; Node's fetch ignores
REM HTTP_PROXY, so the download goes through this mirror.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

if not exist "%NODE_HOME%\node.exe" (
  echo Node.js v24 was not found at:
  echo %NODE_HOME%
  pause
  exit /b 1
)

if not exist "node_modules\electron\cli.js" (
  echo Project dependencies are missing.
  echo Run npm ci with Node.js v24 first.
  pause
  exit /b 1
)

"%NODE_HOME%\node.exe" "node_modules\electron\cli.js" .
pause
