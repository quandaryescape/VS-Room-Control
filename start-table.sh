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

# The kiosk must run as the table's own desktop user. Under sudo the session
# bus and XDG_RUNTIME_DIR belong to uid 0, so Chrome cannot reach the desktop
# ("cannot create directory /run/user/0") and refuses to run as root anyway.
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run this with sudo - the kiosk needs the desktop user's session."
  echo "Run it plainly:"
  echo "    ROOM=A SERVER=http://192.168.1.20:8990 ./start-table.sh"
  exit 1
fi

# ---- edit these two lines per table -------------------------------------
ROOM="${ROOM:-A}"
SERVER="${SERVER:-http://192.168.1.20:8990}"
# -------------------------------------------------------------------------

# A bare host:port makes an unusable URL, and Chrome silently ignores
# --unsafely-treat-insecure-origin-as-secure unless the origin has a scheme -
# which costs you the camera without any visible error.
case "$SERVER" in
  http://*|https://*) ;;
  *) SERVER="http://$SERVER" ;;
esac
SERVER="${SERVER%/}"

URL="$SERVER/table/?room=$ROOM"

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
  echo "Install one - the .deb build of Chrome is the safe choice for a kiosk:"
  echo "    wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  echo "    sudo apt install -y ./google-chrome-stable_current_amd64.deb"
  exit 1
fi

# --- where the throwaway profile lives ------------------------------------
# The snap build of Chromium runs confined: AppArmor grants it non-hidden
# paths under $HOME plus its own ~/snap/chromium tree, and nothing else.
# Pointing --user-data-dir at ~/.config/vstable there gets you
#   "Failed To Create Data Directory - Chromium cannot read and write to its
#    data directory"
# and a blank window. Put the profile somewhere the snap can actually write.
browser_is_snap() {
  local resolved
  resolved="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$resolved" in /snap/*|*/snap/bin/*) return 0 ;; esac
  # Ubuntu ships /usr/bin/chromium and /usr/bin/chromium-browser as small
  # shell wrappers that exec the snap, so the path alone does not give it
  # away - look inside if it is a script rather than a binary.
  if head -c 2 "$resolved" 2>/dev/null | grep -q '#!' &&
     grep -qi 'snap' "$resolved" 2>/dev/null; then
    return 0
  fi
  return 1
}

if browser_is_snap "$BROWSER"; then
  PROFILE="$HOME/snap/chromium/common/vstable/$ROOM"
  echo "Note: $BROWSER is the snap build of Chromium."
  echo "  Using profile $PROFILE (the snap cannot write to ~/.config)."
  echo "  The table needs its USB camera. If the feed stays black, run:"
  echo "      sudo snap connect chromium:camera"
  echo "  Installing .deb Chrome avoids both issues - see the README."
else
  PROFILE="$HOME/.config/vstable/$ROOM"
fi

mkdir -p "$PROFILE" 2>/dev/null || true
if [ ! -w "$PROFILE" ]; then
  echo "Cannot write to the browser profile directory: $PROFILE"
  echo "Chromium will fail to start with a blank window. Install .deb Chrome:"
  echo "    wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  echo "    sudo apt install -y ./google-chrome-stable_current_amd64.deb"
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
