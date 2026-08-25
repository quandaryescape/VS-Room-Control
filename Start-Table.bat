@echo off
REM ===========================================================================
REM  Launches this room's touchscreen table in kiosk mode.
REM
REM  Copy this file to each table PC, set ROOM and SERVER below, and put a
REM  shortcut to it in:
REM     shell:startup   (Win+R, paste that, drop the shortcut in)
REM
REM  WHY THE EXTRA FLAGS:
REM  Chrome only hands out cameras on a "secure origin". http://localhost
REM  counts; http://192.168.x.x does NOT. Since the table needs its USB camera
REM  to send video to the other room, we mark this one server as trusted with
REM  --unsafely-treat-insecure-origin-as-secure. That flag applies to this
REM  launch only, uses a throwaway profile, and does not affect normal browsing
REM  on the machine. (The alternative is running the VS server over HTTPS with
REM  a self-signed certificate - see docs/HARDWARE.md.)
REM ===========================================================================

REM ---- edit these two lines per table -------------------------------------
set ROOM=A
set SERVER=http://192.168.1.20:8990
REM -------------------------------------------------------------------------

set URL=%SERVER%/table/?room=%ROOM%
set PROFILE=%LOCALAPPDATA%\VSTable\%ROOM%

set BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%BROWSER%" set BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%BROWSER%" set BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if not exist "%BROWSER%" set BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe

if not exist "%BROWSER%" (
  echo Could not find Chrome or Edge. Install one, or edit BROWSER in this file.
  pause
  exit /b 1
)

echo Launching table %ROOM% against %SERVER%
start "" "%BROWSER%" ^
  --kiosk "%URL%" ^
  --user-data-dir="%PROFILE%" ^
  --unsafely-treat-insecure-origin-as-secure=%SERVER% ^
  --use-fake-ui-for-media-stream ^
  --autoplay-policy=no-user-gesture-required ^
  --disable-features=TranslateUI,MediaRouter ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  --noerrdialogs ^
  --disable-session-crashed-bubble ^
  --disable-infobars ^
  --check-for-update-interval=31536000
