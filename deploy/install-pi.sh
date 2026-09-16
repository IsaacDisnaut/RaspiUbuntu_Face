#!/usr/bin/env bash
# Install deep.py as a boot service on a Raspberry Pi / Ubuntu box.
#
#   sudo ./deploy/install-pi.sh
#
# Afterwards the bridge starts at every boot, reconnects to the broker on its
# own, and can be pointed at a new tunnel URL over Bluetooth (see
# RASPBERRY_PI.md). Re-running it is safe — it only fills in what's missing.
set -euo pipefail

SERVICE=robot-bridge
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$DIR/deploy/$SERVICE.service"
UNIT_DST="/etc/systemd/system/$SERVICE.service"
CONF_DIR=/etc/robot-bridge
POLKIT_RULE=/etc/polkit-1/rules.d/50-robot-bridge.rules

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo:  sudo $0" >&2
  exit 1
fi

# The service must run as a human user (not root): it needs the login user's
# groups for the serial port, and its config should be editable over SSH.
RUN_USER="${SUDO_USER:-}"
if [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]]; then
  RUN_USER="$(getent passwd 1000 | cut -d: -f1)"
fi
if [[ -z "$RUN_USER" ]]; then
  echo "Could not work out which user to run as; set SUDO_USER." >&2
  exit 1
fi

if systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE.service"; then
  echo "==> $SERVICE already installed — refreshing the unit and restarting"
else
  echo "==> Installing $SERVICE for user '$RUN_USER' from $DIR"
fi

# ── Dependencies ─────────────────────────────────────────────
# python3-dbus + python3-gi drive BlueZ; bluez provides bluetoothd itself.
NEEDED=()
for pkg in python3-paho-mqtt python3-serial python3-dbus python3-gi bluez; do
  dpkg -s "$pkg" >/dev/null 2>&1 || NEEDED+=("$pkg")
done
if ((${#NEEDED[@]})); then
  echo "==> Installing: ${NEEDED[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${NEEDED[@]}"
else
  echo "==> All Python/Bluetooth packages already present"
fi

# ── Permissions ──────────────────────────────────────────────
# dialout: /dev/ttyUSB* (the Arduino). bluetooth: BlueZ's D-Bus policy.
for grp in dialout bluetooth; do
  if getent group "$grp" >/dev/null && ! id -nG "$RUN_USER" | grep -qw "$grp"; then
    echo "==> Adding $RUN_USER to group $grp"
    usermod -aG "$grp" "$RUN_USER"
  fi
done

# ── Config directory ─────────────────────────────────────────
# Owned by the run user so the Bluetooth handler can rewrite the broker URL.
mkdir -p "$CONF_DIR"
chown "$RUN_USER":"$RUN_USER" "$CONF_DIR"
chmod 755 "$CONF_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
  install -o "$RUN_USER" -g "$RUN_USER" -m 644 /dev/stdin "$CONF_DIR/config.json" <<'JSON'
{
  "mqtt_url": "",
  "serial_port": "auto",
  "baud_rate": 115200,
  "bt_name": "For4Aug",
  "bt_pin": "",
  "web_url": "",
  "web_kiosk": true
}
JSON
  echo "==> Wrote default $CONF_DIR/config.json"
else
  # Keys added after the first install are filled in from robot_config.DEFAULTS
  # at load time, so an older file keeps working untouched.
  echo "==> Keeping existing $CONF_DIR/config.json"
fi

# ── Wi-Fi over Bluetooth ─────────────────────────────────────
# The bridge is a *system* service, so it has no login session and polkit does
# not consider it "active" — without this rule `WIFI <ssid> <pass>` comes back
# "not authorized" even though the user could do it from the desktop. Scoped to
# this user and to the Wi-Fi actions wifi_config.py actually calls.
if [[ -d /etc/polkit-1/rules.d ]]; then
  cat > "$POLKIT_RULE" <<EOF
// Installed by deploy/install-pi.sh — lets the robot bridge join Wi-Fi
// networks from the Bluetooth WIFI command while running headless.
polkit.addRule(function(action, subject) {
    if (subject.user == "$RUN_USER" && (
            action.id == "org.freedesktop.NetworkManager.settings.modify.system" ||
            action.id == "org.freedesktop.NetworkManager.settings.modify.own" ||
            action.id == "org.freedesktop.NetworkManager.network-control" ||
            action.id == "org.freedesktop.NetworkManager.enable-disable-wifi" ||
            action.id == "org.freedesktop.NetworkManager.wifi.scan" ||
            action.id == "org.freedesktop.NetworkManager.wifi.share.open" ||
            action.id == "org.freedesktop.NetworkManager.wifi.share.protected")) {
        return polkit.Result.YES;
    }
});
EOF
  chmod 644 "$POLKIT_RULE"
  echo "==> Installed $POLKIT_RULE (Wi-Fi changes for '$RUN_USER')"
  systemctl restart polkit >/dev/null 2>&1 || true
else
  echo "==> WARNING: /etc/polkit-1/rules.d is missing — the WIFI command will"
  echo "    likely fail with 'not authorized'. Join Wi-Fi with nmcli instead."
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "==> WARNING: nmcli not found — the WIFI command needs NetworkManager."
fi

# ── The robot's own screen ───────────────────────────────────
# Only a warning: the bridge is perfectly useful without a screen, and a
# headless robot is a normal way to run it.
if ! command -v firefox >/dev/null 2>&1 &&
   ! command -v chromium >/dev/null 2>&1 &&
   ! command -v chromium-browser >/dev/null 2>&1; then
  echo "==> Note: no browser found. 'WEB <url>' needs one:"
  echo "    sudo apt install -y firefox      (or chromium)"
fi

# ── Bluetooth daemon ─────────────────────────────────────────
systemctl enable bluetooth >/dev/null 2>&1 || true
systemctl start bluetooth  >/dev/null 2>&1 || true

# A hand-started copy would hold the serial port and the Bluetooth SPP profile,
# so the service would come up half-crippled ("UUID already registered").
# Match only real Python processes — a plain `pgrep -f deep.py` also hits the
# shell that launched them, and any editor or grep with the name on its line.
STRAY=""
for pid in $(pgrep -f "deep\.py" 2>/dev/null || true); do
  [[ "$pid" == "$$" ]] && continue
  comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
  [[ "$comm" == python* ]] && STRAY+="$pid "
done
if [[ -n "$STRAY" ]]; then
  echo "==> WARNING: deep.py is already running by hand (PID ${STRAY})."
  echo "    Stop it (Ctrl-C in that terminal) or the service will fight it for"
  echo "    the serial port and the Bluetooth profile."
fi

# ── Service unit ─────────────────────────────────────────────
sed -e "s|@USER@|$RUN_USER|g" -e "s|@DIR@|$DIR|g" "$UNIT_SRC" > "$UNIT_DST"
chmod 644 "$UNIT_DST"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"     # starts it if stopped, restarts it if running

sleep 2
echo
systemctl --no-pager --lines=15 status "$SERVICE" || true
if ! systemctl is-active --quiet "$SERVICE"; then
  echo
  echo "==> Service is NOT running. Full log:  journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi
cat <<EOF

==> Done. The bridge now starts automatically at boot.

  Logs        : journalctl -u $SERVICE -f
  Restart     : sudo systemctl restart $SERVICE
  Set broker  : sudo -u $RUN_USER ROBOT_BRIDGE_CONFIG=$CONF_DIR/config.json \\
                  python3 $DIR/deep.py --set-url <host-or-url>
  Set screen  : sudo -u $RUN_USER ROBOT_BRIDGE_CONFIG=$CONF_DIR/config.json \\
                  python3 $DIR/deep.py --set-web <host-or-url>
  Over Bluetooth: pair with "For4Aug", open a Serial Bluetooth Terminal, send
                  SET  xxxx.trycloudflare.com     the broker
                  WIFI <ssid> <password>          join the Wi-Fi here
                  WEB  xxxx.trycloudflare.com     put <url>/face on the screen

  For WEB to work with no keyboard attached, the Pi also has to log itself in
  and stop blanking the screen — that is a separate, deliberate step:

      sudo $DIR/deploy/kiosk-autologin.sh

  (If '$RUN_USER' was just added to a group, that only affects new logins —
   the service already got the groups via SupplementaryGroups.)
EOF
