@echo off
title PI Production Tracker
cd /d "%~dp0"

set APP_PASSWORD=changeme
set APP_SECRET=random-secret-text-9284
set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  Node.js is not installed yet, or the PC needs a restart.
  echo  1. Install it from https://nodejs.org  ^(green LTS button^)
  echo  2. Restart the PC.
  echo  3. Double-click start again.
  echo ============================================================
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo Installing dependencies, this happens only once. Please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo Could not install dependencies. Check your internet and try again.
    echo.
    pause
    exit /b
  )
)

echo.
echo Starting PI Production Tracker...
echo Open http://localhost:3000 in your browser.
echo Close this window to stop the app.
echo.
node src\server.js

echo.
echo ---- The app stopped. Read the message above this line. ----
pause
