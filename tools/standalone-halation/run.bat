@echo off
rem Film Halation standalone batch processor - double-click to run.
rem Processes all JPG/PNG images in THIS folder and saves <name>_halation.<ext>.
rem Optional: drag image files onto this batch file to process only those.
setlocal
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  rem Node not on PATH: try the standard install location
  set "NODE=%ProgramFiles%\nodejs\node.exe"
  if not exist "%NODE%" (
    echo [error] Node.js not found. Install Node.js from https://nodejs.org and retry.
    pause
    exit /b 1
  )
)
rem 16GB V8 heap + explicit GC: supports very large photos (200MP+ on a 32GB-RAM PC).
rem Adjust to your RAM: 32GB -> 16384 (default), 16GB -> 12288, 8GB -> 8192.
rem --expose-gc lets the tool free big buffers before encoding (lowers peak memory).
"%NODE%" --expose-gc --max-old-space-size=16384 "%~dp0halation-cli.standalone.cjs" %*
echo.
pause
