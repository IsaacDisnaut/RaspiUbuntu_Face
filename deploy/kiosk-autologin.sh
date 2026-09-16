#!/usr/bin/env bash
# Make the Pi come up showing the robot's face with nobody touching it.
#
#   sudo ./deploy/kiosk-autologin.sh          turn it on
#   sudo ./deploy/kiosk-autologin.sh --undo   put it back
#
# Without this the Pi boots to the login screen and waits. That screen belongs
# to the display manager's own user, so the bridge cannot draw on it — the face
# page appears only after somebody presses Enter with a keyboard, which is
# exactly what a robot on wheels does not have.
#
# Three separate things have to be switched off for a screen that stays on:
#   1. the login prompt          → the display manager logs the user in
#   2. the screen blank and lock → GNOME dims and locks after 5 minutes
#   3. idle suspend              → the Pi suspends after 20, killing everything
#
# This is a real change to how the machine logs in: anyone who powers the robot
# on is inside that user's session. That is the point for a kiosk, and it is
# why it is a separate script you run deliberately rather than part of the
# normal install. --undo reverses all of it.
set -euo pipefail

GDM_CONF=/etc/gdm3/custom.conf
LIGHTDM_CONF=/etc/lightdm/lightdm.conf.d/50-robot-kiosk.conf
DCONF_PROFILE=/etc/dconf/profile/user
DCONF_RULES=/etc/dconf/db/local.d/00-robot-kiosk
DCONF_LOCKS=/etc/dconf/db/local.d/locks/00-robot-kiosk

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo:  sudo $0 ${1:-}" >&2
  exit 1
fi

RUN_USER="${SUDO_USER:-}"
if [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]]; then
  RUN_USER="$(getent passwd 1000 | cut -d: -f1)"
fi
if [[ -z "$RUN_USER" ]]; then
  echo "Could not work out which user to log in; set SUDO_USER." >&2
  exit 1
fi

UNDO=0
[[ "${1:-}" == "--undo" ]] && UNDO=1

# ── 1. Log in without a keyboard ─────────────────────────────
enable_gdm() {
  # The [daemon] section already exists on Ubuntu and holds WaylandEnable.
  # Drop our two keys in under it, replacing any previous copy.
  python3 - "$GDM_CONF" "$RUN_USER" <<'PY'
import re, sys
path, user = sys.argv[1], sys.argv[2]
text = open(path).read()
text = re.sub(r"^\s*AutomaticLogin(Enable)?\s*=.*\n", "", text, flags=re.M)
block = f"AutomaticLoginEnable=true\nAutomaticLogin={user}\n"
if re.search(r"^\[daemon\]\s*$", text, flags=re.M):
    text = re.sub(r"^\[daemon\]\s*\n", "[daemon]\n" + block, text, count=1, flags=re.M)
else:
    text = "[daemon]\n" + block + text
open(path, "w").write(text)
print(f"    {path}: AutomaticLogin={user}")
PY
}

disable_gdm() {
  python3 - "$GDM_CONF" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
open(path, "w").write(re.sub(r"^\s*AutomaticLogin(Enable)?\s*=.*\n", "", text, flags=re.M))
print(f"    {path}: automatic login removed")
PY
}

DM="none"
if [[ -f "$GDM_CONF" ]]; then
  DM="gdm3"
elif [[ -d /etc/lightdm ]]; then
  DM="lightdm"
fi

echo "==> Display manager: $DM"
case "$DM:$UNDO" in
  gdm3:0)    enable_gdm ;;
  gdm3:1)    disable_gdm ;;
  lightdm:0) mkdir -p "$(dirname "$LIGHTDM_CONF")"
             printf '[Seat:*]\nautologin-user=%s\nautologin-user-timeout=0\n' \
               "$RUN_USER" > "$LIGHTDM_CONF"
             echo "    wrote $LIGHTDM_CONF" ;;
  lightdm:1) rm -f "$LIGHTDM_CONF"; echo "    removed $LIGHTDM_CONF" ;;
  none:*)    echo "    WARNING: no gdm3 or lightdm found — set autologin by hand." ;;
esac

# ── 2 & 3. Keep the screen on ────────────────────────────────
# Written as dconf *system* defaults rather than `gsettings set`: gsettings
# needs a running session to write into, and this has to hold from the very
# first boot, before anyone has one. The locks stop GNOME's own settings UI
# from quietly putting the blanking back.
if [[ $UNDO -eq 0 ]]; then
  mkdir -p "$(dirname "$DCONF_RULES")" "$(dirname "$DCONF_LOCKS")"
  cat > "$DCONF_RULES" <<'EOF'
# Installed by deploy/kiosk-autologin.sh — the robot's face must stay lit.
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false

[org/gnome/settings-daemon/plugins/power]
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'
idle-dim=false
EOF
  cat > "$DCONF_LOCKS" <<'EOF'
/org/gnome/desktop/session/idle-delay
/org/gnome/desktop/screensaver/lock-enabled
/org/gnome/desktop/screensaver/idle-activation-enabled
/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type
/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type
EOF
  # A system-db line is what makes /etc/dconf/db/local reach the user at all.
  if [[ ! -f "$DCONF_PROFILE" ]]; then
    printf 'user-db:user\nsystem-db:local\n' > "$DCONF_PROFILE"
    echo "    wrote $DCONF_PROFILE"
  elif ! grep -q '^system-db:local$' "$DCONF_PROFILE"; then
    printf 'system-db:local\n' >> "$DCONF_PROFILE"
    echo "    added system-db:local to $DCONF_PROFILE"
  fi
  echo "    screen blanking, locking and idle suspend disabled"
else
  rm -f "$DCONF_RULES" "$DCONF_LOCKS"
  echo "    removed the screen-blanking overrides"
fi
dconf update

# systemd's own idle suspend is separate from GNOME's and ignores it.
if [[ $UNDO -eq 0 ]]; then
  systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target \
    >/dev/null 2>&1 || true
  echo "    suspend masked in systemd"
else
  systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target \
    >/dev/null 2>&1 || true
  echo "    suspend unmasked"
fi

echo
if [[ $UNDO -eq 0 ]]; then
  cat <<EOF
==> Done. Reboot to check it:  sudo reboot

The Pi will log '$RUN_USER' in by itself, the screen will stay on, and the
bridge will open whatever page WEB was last given — no keyboard, no mouse.

  Set the page over Bluetooth:  WEB xxxx.trycloudflare.com
  Or here:                      python3 deep.py --set-web xxxx.trycloudflare.com

Anyone who powers the robot on is now inside '$RUN_USER''s session. Undo with:
  sudo $0 --undo
EOF
else
  echo "==> Reverted. The Pi will ask for a login again after a reboot."
fi
