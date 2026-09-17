@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing app dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Installation failed. Check the network and retry.
    pause
    exit /b 1
  )
)
start "" "node_modules\electron\dist\electron.exe" .
