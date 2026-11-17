@echo off
rem ============================================================
rem  x-auto TEST instance launcher (the account you supervise by hand)
rem    browser : port 9234 / profile C:\x-edge-9234   (unchanged default)
rem    data    : xauto\data                            (unchanged location)
rem    console : http://127.0.0.1:9300
rem
rem  This is the pre-existing behaviour: running tools WITHOUT test.bat
rem  or XAUTO_INSTANCE also lands on test. Nothing here moves old data.
rem
rem  Usage:
rem    test.bat                     launch/reuse the 9234 window
rem    test.bat bind                bind current page account as expected
rem    test.bat status              both instances at a glance
rem    test.bat ui                  console for test (9300)
rem    test.bat run post --yes ...  run any tool as test
rem
rem  Production account lives in prod.bat (port 9235, console 9301).
rem ============================================================
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set XAUTO_INSTANCE=test
set PY=C:\Users\Aron\.workbuddy\binaries\python\envs\default\Scripts\python.exe
if not exist "%PY%" set PY=python

if "%~1"=="" goto launch
if /i "%~1"=="status" goto status
if /i "%~1"=="ui" goto ui
if /i "%~1"=="run" goto run
if /i "%~1"=="bind" goto bind

:launch
"%PY%" tools\x_instance.py test
goto end

:status
"%PY%" tools\x_instance.py --status
goto end

:ui
echo [i] test console: http://127.0.0.1:9300
"%PY%" ui\server.py --instance test --port 9300
goto end

:bind
"%PY%" tools\x_instance.py test --bind
goto end

:run
shift
"%PY%" "tools\x_%~1.py" %2 %3 %4 %5 %6 %7 %8 %9
goto end

:end
