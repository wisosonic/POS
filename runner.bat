@echo off
rem ============================================================================================================
rem  Runs the POS on this PC for trying it out: installs what is needed the first time, prepares a database,
rem  starts the server and the screen TOGETHER IN THIS WINDOW, and opens the browser. Double-click it.
rem  Lines from the server are marked [api], lines from the screen [web]. Press Ctrl+C here to stop both.
rem
rem  This is for TESTING. The shop PC is set up with scripts\windows\install-service.ps1 (docs\07-operations.md).
rem  Options (set before running, or ignore them):
rem    RUNNER_PASSWORD=...   the admin password for a new database (at least 8 characters), instead of being asked
rem    RUNNER_IMPORT=y|n     import the old data from POSDB.sql into a new database, instead of being asked
rem    RUNNER_NO_BROWSER=1   do not open the browser
rem  The same thing without this file: npm run dev   (scripts\dev.mjs)
rem ============================================================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title POS runner

set "API_URL=http://127.0.0.1:3000"
set "WEB_URL=http://localhost:5173"
set "DB=%~dp0apps\api\data\pos.db"

echo.
echo  === Darwish Market POS: test runner ===
echo.

rem ---- 1. Node.js -------------------------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Install the LTS version from https://nodejs.org ^(version 22 or newer^),
  echo  then run this file again.
  goto :fail
)
for /f "tokens=1 delims=." %%v in ('node --version') do set "NODEMAJOR=%%v"
set "NODEMAJOR=%NODEMAJOR:v=%"
if %NODEMAJOR% LSS 22 (
  for /f %%v in ('node --version') do echo  This PC has Node.js %%v. Version 22 or newer is needed: https://nodejs.org
  goto :fail
)
for /f %%v in ('node --version') do echo  [ok] Node.js %%v

rem ---- 2. Requirements --------------------------------------------------------------------------------------
if not exist node_modules (
  echo  [..] First run: installing the requirements. This takes a few minutes and needs the internet.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  The installation failed. Check the internet connection and run this file again.
    goto :fail
  )
) else (
  echo  [ok] Requirements are installed
)

rem ---- 3. Already running? ----------------------------------------------------------------------------------
curl --silent --fail --max-time 2 "%API_URL%/api/v1/healthz" >nul 2>nul
if not errorlevel 1 (
  echo  [ok] The server is already running
  goto :open
)

rem ---- 4. A database ----------------------------------------------------------------------------------------
if exist "%DB%" (
  echo  [ok] Using the existing test database: %DB%
  goto :start
)

echo  [..] No test database yet: making one.
set "IMPORT=%RUNNER_IMPORT%"
if exist "POSDB.sql" if not defined IMPORT (
  set /p "IMPORT=  Import the old shop data from POSDB.sql (takes about 30 seconds)? [y/N] "
)
if /i "%IMPORT%"=="y" (
  if not exist "POSDB.sql" (
    echo  POSDB.sql is not in this folder, so there is nothing to import.
    goto :fail
  )
  echo  [..] Importing the old data. Nothing in POSDB.sql or Uploads is changed.
  call npm run etl -w @pos/api -- --dump ../../POSDB.sql --uploads ../../Uploads
  if errorlevel 1 (
    echo  The import failed. The messages above say why.
    if exist "%DB%" del /q "%DB%" "%DB%-wal" "%DB%-shm" 2>nul
    goto :fail
  )
)

set "PW=%RUNNER_PASSWORD%"
if not defined PW (
  echo.
  echo  Choose the password for the admin account ^(user name: admin^). At least 8 characters.
  echo  Avoid the characters  ^& ^| ^< ^> ^^ %% "  in it.
  set /p "PW=  Password (just press Enter for admin12345): "
)
if not defined PW set "PW=admin12345"
call npm run create-admin -w @pos/api -- admin "%PW%"
if errorlevel 1 (
  echo  The admin account could not be made. The messages above say why ^(the password must be at least 8 characters^).
  goto :fail
)
echo  [ok] Admin account ready: user name  admin   password  %PW%

rem ---- 5. Start: the server and the screen, together, in this window -------------------------------------------
:start
echo  [..] Starting the server and the screen in this window ^(lines are marked [api] and [web]^).
echo       Press Ctrl+C here to stop both.
echo.
node scripts\dev.mjs --open
echo.
echo  The server and the screen are stopped.
goto :done

rem ---- the server was already running: just show the way ------------------------------------------------------
:open
echo.
echo  The POS is at  %WEB_URL%
echo  Sign in as  admin  with the password you chose.
echo  First: Menu ^> Users to add a cashier, Settings ^(the gear^) ^> Exchange rate to set today's rate, then open the register and sell.
echo  It is running in another window: press Ctrl+C there to stop it.
if not defined RUNNER_NO_BROWSER start "" "%WEB_URL%"
echo.
goto :done

:done
if not defined RUNNER_NO_BROWSER pause
endlocal
exit /b 0

:fail
echo.
echo  Stopped. Nothing is broken: fix the cause above and run this file again.
if not defined RUNNER_NO_BROWSER pause
endlocal
exit /b 1
