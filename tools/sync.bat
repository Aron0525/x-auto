@echo off
rem Sync extension code to target browser profile dir
rem Usage: sync.bat test      -> E:\DSH\tui\edge-test\extension
rem        sync.bat official  -> E:\DSH\tui\edge-official\extension
rem        sync.bat all       -> both

setlocal enabledelayedexpansion
set SRC=E:\DSH\tui\extension
set TARGET=%1
if "%TARGET%"=="" set TARGET=test

if not exist "%SRC%" ( echo [ERROR] Source not found: %SRC% & pause & exit /b 1 )

if /i "%TARGET%"=="test"     call :do_copy "E:\DSH\tui\edge-test\extension"     "TEST"
if /i "%TARGET%"=="official" call :do_copy "E:\DSH\tui\edge-official\extension" "OFFICIAL"
if /i "%TARGET%"=="all" (
  call :do_copy "E:\DSH\tui\edge-test\extension"     "TEST"
  call :do_copy "E:\DSH\tui\edge-official\extension" "OFFICIAL"
)

echo.
echo Next: open the browser window, go to edge://extensions,
echo       click RELOAD on the X Auto SOP card.
echo.
pause
exit /b 0

:do_copy
set DST=%~1
set LABEL=%~2
if not exist "%DST%" mkdir "%DST%"
del /q "%DST%\*.js"   2>nul
del /q "%DST%\*.html" 2>nul
del /q "%DST%\*.json" 2>nul
xcopy "%SRC%\*" "%DST%\" /E /Y /Q >nul
if errorlevel 1 ( echo [ERROR] Copy failed to %LABEL% & exit /b 1 )
echo [OK] Synced to %LABEL% : %DST%
exit /b 0