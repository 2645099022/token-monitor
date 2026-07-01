@echo off
setlocal
title Token Monitor
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo npm not found. Please install Node.js first.
  pause
  exit /b 1
)
npm start
pause
