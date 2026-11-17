@echo off
rem ============================================================
rem  x-auto PROD instance launcher (production account)
rem    browser : port 9235 / profile C:\x-edge-9235
rem    data    : xauto\data\prod   (own state.json, limits, behavior, logs)
rem    console : http://127.0.0.1:9301
rem
rem  Account gate: every tool checks "handle logged in this window"
rem  against xauto\data\accounts.json[prod] BEFORE any action.
rem  Mismatch -> refuses to run. Rebind after login:  prod.bat bind
rem
rem  Usage:
rem    prod.bat                     launch prod browser window (login once)
rem    prod.bat bind                bind current page account as expected
rem    prod.bat status              both instances at a glance
rem    prod.bat ui                  console for prod (open 9301, NOT 9300)
rem    prod.bat run post --yes ...  run any tool as prod
rem      tools are named x_<word>.py : post reply browse notif loop session ...
rem
rem  test account stays untouched: use test.bat (port 9234, console 9300)
rem ============================================================
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set XAUTO_INSTANCE=prod
set PY=C:\Users\Aron\.workbuddy\binaries\python\envs\default\Scripts\python.exe
if not exist "%PY%" set PY=python

if "%~1"=="" goto launch
if /i "%~1"=="status" goto status
if /i "%~1"=="ui" goto ui
if /i "%~1"=="run" goto run
if /i "%~1"=="bind" goto bind

:launch
"%PY%" tools\x_instance.py prod
goto end

:status
"%PY%" tools\x_instance.py --status
goto end

:ui
echo [i] prod console: http://127.0.0.1:9301
"%PY%" ui\server.py --instance prod --port 9301
goto end

:bind
"%PY%" tools\x_instance.py prod --bind
goto end

:run
shift
"%PY%" "tools\x_%~1.py" %2 %3 %4 %5 %6 %7 %8 %9
goto end

:end
