#!/usr/bin/env bash
# ===========================================================================
#  Makes VS Room Control start by itself on Ubuntu.
#
#    sudo ./install-linux.sh server
#         Installs a systemd service. The VS server starts at boot, before
#         anyone logs in, and restarts itself if it ever dies.
#
#    ./install-linux.sh table --room A --server http://192.168.1.20:8990
#         Installs a desktop autostart entry. The kiosk browser comes up when
#         this machine's desktop session logs in. Run as the table's own
#         user, NOT with sudo - it needs that user's graphical session.
#
#    ./install-linux.sh check-table
#         Diagnoses a table that did not come up by itself: autostart entry,
#         exec bits, automatic login, browser, and whether the VS server is
#         answering. Run it as the table user on the table PC.
#
#    sudo ./install-linux.sh uninstall-server
#         ./install-linux.sh uninstall-table
#
#  Check on it afterwards:
#      systemctl status vs-server
#      journalctl -u vs-server -f
# ===========================================================================
set -euo pipefail

HERE="$(dirname "$(readlink -f "$0")")"
SERVICE_NAME="vs-server"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
AUTOSTART_PATH="$HOME/.config/autostart/vs-table.desktop"

die() { echo "  ! $*" >&2; exit 1; }

usage() {
  # Print the header comment block: everything from line 2 up to the first
  # line that is not a comment.
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
  exit 1
}

# Refuse to install from somewhere the checkout cannot actually be run from.
# The usual way to land here is copying the repo off a Windows share: you end
# up inside ~/.gvfs or /run/user/1000/gvfs, which is a FUSE mount that (a) is
# mounted noexec, and (b) root cannot even traverse - so `sudo ./install-linux.sh`
# fails with a baffling "command not found". A network mount is also the wrong
# home for a boot service: it only exists inside a logged-in desktop session,
# so at boot time systemd would find nothing there.
require_runnable_location() {
  case "$HERE" in
    */gvfs/*|/run/user/*|*/.gvfs/*)
      die "$HERE is a GVFS network mount.
    Nothing can be executed from there, and it does not exist at boot time.
    Copy the project to local disk first, for example:
        cp -r \"$HERE\" ~/vs-room-control
        cd ~/vs-room-control && chmod +x *.sh
        sudo ./install-linux.sh server" ;;
  esac

  if command -v findmnt >/dev/null 2>&1; then
    case ",$(findmnt -no OPTIONS --target "$HERE" 2>/dev/null)," in
      *,noexec,*)
        die "$HERE is on a noexec mount, so the launchers cannot run from there.
    Copy the project to local disk (e.g. ~/vs-room-control) and re-run." ;;
    esac
  fi

  local f
  for f in start-vsserver.sh start-table.sh; do
    [ -x "$HERE/$f" ] || die "$HERE/$f is not executable.
    The exec bit does not survive a copy over FTP/SMB. Fix it with:
        chmod +x \"$HERE\"/*.sh"
  done
}

# ---------------------------------------------------------------- server ---
install_server() {
  require_runnable_location
  [ "$(id -u)" -eq 0 ] || die "Installing the service needs root. Try: sudo $0 server"

  # Run the service as the human who owns the checkout, not as root. npm
  # install, config.json and any logs then stay owned by that user.
  local run_user run_group
  run_user="${SUDO_USER:-$(stat -c '%U' "$HERE")}"
  [ "$run_user" != "root" ] || die "Refusing to run the server as root. Check out the repo as a normal user and re-run with sudo from there."
  run_group="$(id -gn "$run_user")"

  command -v node >/dev/null 2>&1 || die "Node.js is not installed. sudo apt install -y nodejs npm"

  echo "  Installing ${SERVICE_NAME}.service"
  echo "    directory : $HERE"
  echo "    user      : $run_user"

  cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=VS Room Control server
Documentation=file://$HERE/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$run_user
Group=$run_group
WorkingDirectory=$HERE
ExecStart=$HERE/start-vsserver.sh
Restart=on-failure
RestartSec=5

# The server restores both rooms' lights and walls on SIGTERM. Give it room
# to finish that before systemd reaches for SIGKILL.
KillSignal=SIGTERM
TimeoutStopSec=20

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
UNIT

  chmod 644 "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  sleep 2
  echo
  systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
  echo
  echo "  Done. It will now come up on every boot."
  echo "    logs    : journalctl -u $SERVICE_NAME -f"
  echo "    stop    : sudo systemctl stop $SERVICE_NAME"
  echo "    restart : sudo systemctl restart $SERVICE_NAME"
  echo
  echo "  Remember to edit $HERE/config.json, then restart the service."
}

uninstall_server() {
  [ "$(id -u)" -eq 0 ] || die "Needs root. Try: sudo $0 uninstall-server"
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  echo "  Removed ${SERVICE_NAME}.service"
}

# ----------------------------------------------------------------- table ---
install_table() {
  require_runnable_location
  local room="A" server="http://192.168.1.20:8990"

  while [ $# -gt 0 ]; do
    case "$1" in
      --room)   room="${2:-}";   shift 2 ;;
      --server) server="${2:-}"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [ "$(id -u)" -ne 0 ] || die "Do NOT sudo this one. Run it as the table PC's own desktop user."
  [ -n "$room" ]   || die "--room needs a value (A or B)"
  [ -n "$server" ] || die "--server needs a value, e.g. http://192.168.1.20:8990"

  # A bare host:port is the easy mistake here. It produces a nonsense URL and,
  # worse, Chrome ignores --unsafely-treat-insecure-origin-as-secure for an
  # origin with no scheme - so the table loads but never gets its camera.
  case "$server" in
    http://*|https://*) ;;
    *) server="http://$server"
       echo "  (no scheme given, using $server)" ;;
  esac

  # Trailing slash would turn the URL into a double-slash and break the
  # secure-origin flag matching.
  server="${server%/}"

  mkdir -p "$(dirname "$AUTOSTART_PATH")"
  cat > "$AUTOSTART_PATH" <<DESKTOP
[Desktop Entry]
Type=Application
Name=VS Table $room
Comment=VS Room Control touchscreen table (kiosk)
Exec=env ROOM=$room SERVER=$server "$HERE/start-table.sh"
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
DESKTOP

  chmod 644 "$AUTOSTART_PATH"

  echo "  Installed $AUTOSTART_PATH"
  echo "    room   : $room"
  echo "    server : $server"
  echo
  echo "  Test it now without rebooting:  $HERE/start-table.sh"
  echo

  # An autostart entry runs at graphical LOGIN, not at boot. Without automatic
  # login the table sits on the GDM password prompt forever and nothing starts,
  # which looks exactly like "the autostart is broken". Say so loudly here
  # rather than as a footnote.
  if [ -r /etc/gdm3/custom.conf ] &&
     grep -Eq '^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*[Tt]rue' /etc/gdm3/custom.conf; then
    echo "  Automatic login is on, so this comes up on every boot."
  else
    echo "  !! Automatic login is NOT enabled on this machine."
    echo "     Autostart entries run when a desktop session STARTS, so with the"
    echo "     login screen in the way nothing will launch at boot. Turn it on:"
    echo "         Settings > Users > Unlock > Automatic Login"
    echo "     or in /etc/gdm3/custom.conf under [daemon]:"
    echo "         AutomaticLoginEnable=true"
    echo "         AutomaticLogin=${USER:-$(id -un)}"
  fi
  echo
  echo "  Recheck any time with:  $0 check-table"
}

uninstall_table() {
  rm -f "$AUTOSTART_PATH"
  echo "  Removed $AUTOSTART_PATH"
}

# ------------------------------------------------------------ check-table ---
# Everything that has to be true for the kiosk to come up by itself, checked
# one at a time. Run this on the table PC when it did not start.
check_table() {
  local ok=0 warn=0
  say()  { printf '  %s %s\n' "$1" "$2"; }
  good() { say ' ok ' "$1"; }
  bad()  { say ' !! ' "$1"; ok=1; }
  note() { say ' -- ' "$1"; warn=1; }

  echo
  echo "  VS table autostart check"
  echo "  ------------------------"

  # 1. the autostart entry
  if [ -f "$AUTOSTART_PATH" ]; then
    good "autostart entry present: $AUTOSTART_PATH"
    local exec_line
    exec_line="$(grep -m1 '^Exec=' "$AUTOSTART_PATH" || true)"
    say '    ' "$exec_line"
    if grep -q '^Hidden=true' "$AUTOSTART_PATH"; then
      bad "entry has Hidden=true - something disabled it. Re-run: $0 table --room A --server URL"
    fi
    if command -v desktop-file-validate >/dev/null 2>&1; then
      if desktop-file-validate "$AUTOSTART_PATH" >/dev/null 2>&1; then
        good "entry parses cleanly"
      else
        bad "entry is malformed:"
        desktop-file-validate "$AUTOSTART_PATH" 2>&1 | sed 's/^/        /'
      fi
    fi
  else
    bad "no autostart entry at $AUTOSTART_PATH - run: $0 table --room A --server URL"
  fi

  # 2. the launcher itself
  if [ -x "$HERE/start-table.sh" ]; then
    good "start-table.sh is executable"
  else
    bad "start-table.sh is NOT executable - chmod +x \"$HERE\"/*.sh"
  fi

  # 3. a graphical session at all
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    good "graphical session (${XDG_SESSION_TYPE:-unknown})"
  else
    note "no graphical session detected - autostart entries only run inside one."
  fi

  # 4. automatic login - the usual reason "it didn't run at boot". Without it
  #    the machine sits on the login screen and no session, hence no autostart.
  local autologin="unknown"
  if [ -r /etc/gdm3/custom.conf ]; then
    if grep -Eq '^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*[Tt]rue' /etc/gdm3/custom.conf; then
      autologin="on"
    else
      autologin="off"
    fi
  fi
  case "$autologin" in
    on)  good "automatic login is enabled" ;;
    off) bad "automatic login is OFF - the PC stops at the login screen at boot,
        so nothing autostarts. Settings > Users > Unlock > Automatic Login,
        or set in /etc/gdm3/custom.conf under [daemon]:
            AutomaticLoginEnable=true
            AutomaticLogin=${USER:-$(id -un)}" ;;
    *)   note "could not read /etc/gdm3/custom.conf - check automatic login by hand" ;;
  esac

  # 5. a browser to launch
  local browser=""
  for c in google-chrome-stable google-chrome chromium chromium-browser microsoft-edge-stable microsoft-edge; do
    command -v "$c" >/dev/null 2>&1 && { browser="$c"; break; }
  done
  if [ -n "$browser" ]; then good "browser found: $browser"; else bad "no Chrome/Chromium/Edge on PATH"; fi

  # 6. can we actually reach the server the entry points at
  local server
  server="$(sed -n 's/.*SERVER=\([^ ]*\).*/\1/p' "$AUTOSTART_PATH" 2>/dev/null || true)"
  case "${server:-http://placeholder}" in
    http://*|https://*) ;;
    *) bad "SERVER in the autostart entry has no scheme: $server
        Chrome ignores --unsafely-treat-insecure-origin-as-secure for a
        schemeless origin, so the table would load but never get a camera.
        Re-run: $0 table --room A --server http://$server" ;;
  esac
  if [ -n "$server" ] && command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 4 -o /dev/null "$server/api/health"; then
      good "VS server answering at $server"
    else
      note "no answer from $server/api/health (start-table.sh waits 2 min for this)"
    fi
  fi

  echo
  if [ "$ok" -ne 0 ]; then
    echo "  Fix the !! lines above, then reboot to retest."
  elif [ "$warn" -ne 0 ]; then
    echo "  Nothing fatal. Check the -- lines."
  else
    echo "  All good - it should come up on the next boot."
  fi
  echo "  Test the launcher right now without rebooting:"
  echo "      $HERE/start-table.sh"
  echo
}

# ------------------------------------------------------------------ main ---
case "${1:-}" in
  server)            shift; install_server "$@" ;;
  table)             shift; install_table "$@" ;;
  check-table)       shift; check_table ;;
  uninstall-server)  shift; uninstall_server ;;
  uninstall-table)   shift; uninstall_table ;;
  *) usage ;;
esac
