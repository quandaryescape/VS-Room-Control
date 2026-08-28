#!/usr/bin/env bash
# ===========================================================================
#  Launches this room's touchscreen table in kiosk mode.
#  (Linux equivalent of Start-Table.bat)
#
#  Copy this file to each table PC, set ROOM and SERVER below, then:
#      ./install-linux.sh table
#  which drops an autostart entry into ~/.config/autostart so it comes up
#  with the desktop session at login.
#
#  WHY THE EXTRA FLAGS:
#  Chrome only hands out cameras on a "secure origin". http://localhost
#  counts; http://192.168.x.x does NOT. Since the table needs its USB camera
#  to send video to the other room, we mark this one server as trusted with
#  --unsafely-treat-insecure-origin-as-secure. That flag applies to this
#  launch only, uses a throwaway profile, and does not affect normal browsing
#  on the machine. (The alternative is running the VS server over HTTPS with
#  a self-signed certificate - see docs/HARDWARE.md.)
# ===========================================================================
set -uo pipefail

# ---- edit these two lines per table -------------------------------------
ROOM="${ROOM:-A}"
SERVER="${SERVER:-http://192.168.1.20:8990}"
# -------------------------------------------------------------------------

URL="$SERVER/table/?room=$ROOM"
PROFILE="$HOME/.config/vstable/$ROOM"

# --- find a browser ------------------------------------------------------
BROWSER=""
for candidate in google-chrome-stable google-chrome chromium chromium-browser microsoft-edge-stable microsoft-edge; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER="$(command -v "$candidate")"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "Could not find Chrome, Chromium or Edge."
  echo "Install one, e.g.:  sudo apt install -y chromium-browser"
  echo "or edit BROWSER in this file."
  exit 1
fi

# --- keep the screen awake ------------------------------------------------
# A table that blanks mid-game looks broken. Best effort; ignore failures on
# Wayland or a headless-ish session.
if [ "${XDG_SESSION_TYPE:-}" = "x11" ] && command -v xset >/dev/null 2>&1; then
  xset s off        >/dev/null 2>&1 || true
  xset s noblank    >/dev/null 2>&1 || true
  xset -dpms        >/dev/null 2>&1 || true
fi
if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.session idle-delay 0                      >/dev/null 2>&1 || true
  gsettings set org.gnome.desktop.screensaver lock-enabled false            >/dev/null 2>&1 || true
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing >/dev/null 2>&1 || true
fi

# --- wait for the VS server ----------------------------------------------
# At boot the table PC is usually up before the server box is. Rather than
# opening on a connection-refused page, sit here for up to two minutes.
if command -v curl >/dev/null 2>&1; then
  echo "Waiting for $SERVER ..."
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 -o /dev/null "$SERVER/table/"; then break; fi
    sleep 2
  done
fi

# Chrome remembers that it was killed and offers to restore tabs, which on a
# kiosk means a dialog nobody can dismiss. Scrub the crash flags each launch.
if [ -f "$PROFILE/Default/Preferences" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' \
    "$PROFILE/Default/Preferences" 2>/dev/null || true
fi

echo "Launching table $ROOM against $SERVER"
exec "$BROWSER" \
  --kiosk "$URL" \
  --user-data-dir="$PROFILE" \
  --unsafely-treat-insecure-origin-as-secure="$SERVER" \
  --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=TranslateUI,MediaRouter \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --password-store=basic \
  --no-first-run \
  --no-default-browser-check \
  --check-for-update-interval=31536000
