@echo off
rem One-click: put the tap list on the default TV.
rem Make a desktop shortcut to this file. Requires the server to be running (npm start).
set PORT=3000
curl -s -X POST http://localhost:%PORT%/api/cast/default
if errorlevel 1 (
  echo.
  echo Could not reach brewtoscreen on port %PORT%. Start it with: npm start
  pause
)
