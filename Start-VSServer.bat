@echo off
title VS Room Control - Server
cd /d "%~dp0"

echo.
echo   VS Room Control
echo   ---------------
echo.

if not exist "config.json" (
  echo   No config.json found. Creating one from config.example.json...
  copy /y "config.example.json" "config.json" >nul
  echo   Created config.json - open it and set your room IDs, light and
  echo   Wall Player addresses before running a real game.
  echo.
)

if not exist "node_modules" (
  echo   Installing dependencies ^(one time^)...
  call npm install --no-audit --no-fund
  echo.
)

node server\vs-server.js

echo.
echo   The VS server stopped. Press any key to close.
pause >nul
