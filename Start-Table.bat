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

REM Start-Table.bat --windowed opens a normal window on the same profile, so
REM Chrome's "Use and move your camera" prompt can be clicked with a mouse.
set MODE=--kiosk
if /i "%~1"=="--windowed" set MODE=--new-window
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

REM No --use-fake-ui-for-media-stream. It auto-accepted the camera, but only
REM the picture: Chrome's fake prompt never grants the separate "move your
REM camera" permission, so the OBSBOT could not be steered. Chrome now asks
REM once - "Use and move your camera" - and remembers it in this profile.
REM Tap Allow on the table the first time, or run with --windowed.
echo Launching table %ROOM% against %SERVER%
start "" "%BROWSER%" ^
  %MODE% "%URL%" ^
  --user-data-dir="%PROFILE%" ^
  --unsafely-treat-insecure-origin-as-secure=%SERVER% ^
  --autoplay-policy=no-user-gesture-required ^
  --disable-features=TranslateUI,MediaRouter ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  --noerrdialogs ^
  --disable-session-crashed-bubble ^
  --disable-infobars ^
  --check-for-update-interval=31536000
