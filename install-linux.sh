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

  # Trailing slash would turn the URL into a double-slash and break the
  # secure-origin flag matching.
  server="${server%/}"

  mkdir -p "$(dirname "$AUTOSTART_PATH")"
  cat > "$AUTOSTART_PATH" <<DESKTOP
[Desktop Entry]
Type=Application
Name=VS Table $room
Comment=VS Room Control touchscreen table (kiosk)
Exec=env ROOM=$room SERVER=$server $HERE/start-table.sh
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
DESKTOP

  chmod 644 "$AUTOSTART_PATH"

  echo "  Installed $AUTOSTART_PATH"
  echo "    room   : $room"
  echo "    server : $server"
  echo
  echo "  The kiosk will start at the next login of this user."
  echo "  Test it now without rebooting:  $HERE/start-table.sh"
  echo "  (ROOM and SERVER above are passed in, so the defaults inside"
  echo "   start-table.sh do not need editing.)"
  echo
  echo "  For an unattended table, also turn on automatic login:"
  echo "    Settings > Users > Automatic Login"
}

uninstall_table() {
  rm -f "$AUTOSTART_PATH"
  echo "  Removed $AUTOSTART_PATH"
}

# ------------------------------------------------------------------ main ---
case "${1:-}" in
  server)            shift; install_server "$@" ;;
  table)             shift; install_table "$@" ;;
  uninstall-server)  shift; uninstall_server ;;
  uninstall-table)   shift; uninstall_table ;;
  *) usage ;;
esac
