"""Wi-Fi control for the robot bridge, driven from a phone over Bluetooth.

Why this exists: the robot gets moved between rooms, demos and venues, and at
each one the Wi-Fi is different. Without this you need a keyboard and a screen
on the Pi to join a new network — but the Pi is headless, and once it is off
the network SSH is not an option either. Bluetooth still works with no network
at all, so `WIFI <ssid> <password>` from the same phone terminal that sets the
broker URL (see bt_config.py) is the one channel that is always available.

Everything goes through `nmcli`, so the connection is stored by
NetworkManager as a system connection and comes back automatically at the next
boot — this module deliberately keeps no Wi-Fi state of its own.

The bridge runs as a systemd *system* service, which has no login session, so
polkit does not treat it as "active" and would normally refuse the calls that
change connections. deploy/install-pi.sh installs a rule granting the run user
exactly the NetworkManager actions used here.
"""

import re
import shutil
import subprocess

NMCLI = "nmcli"

# `nmcli device wifi connect` has to associate, do DHCP and (often) wait out a
# captive-portal check. 45 s is long enough for a slow AP without leaving the
# phone staring at a dead terminal.
CONNECT_TIMEOUT = 45


class WifiError(Exception):
    """Something the operator needs to read — the message goes to the phone."""


def available():
    return shutil.which(NMCLI) is not None


def _run(args, timeout=25):
    """Run nmcli. Returns (rc, stdout, stderr); a non-zero rc is not an error
    here because several callers treat failure as "not fatal, carry on"."""
    try:
        proc = subprocess.run([NMCLI] + args, capture_output=True, text=True,
                              timeout=timeout)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except FileNotFoundError:
        return 127, "", "nmcli not installed (NetworkManager missing)"
    except subprocess.TimeoutExpired:
        return 124, "", f"nmcli timed out after {timeout}s"
    except OSError as e:
        return 1, "", str(e)


# nmcli -t escapes a literal ':' inside a field as '\:' so the separator stays
# unambiguous — split on colons that aren't escaped, then unescape.
_UNESCAPED_COLON = re.compile(r"(?<!\\):")


def _split(line):
    return [f.replace("\\:", ":").replace("\\\\", "\\")
            for f in _UNESCAPED_COLON.split(line)]


def _explain(rc, err, out):
    """Turn nmcli's failure into something worth reading on a phone screen."""
    text = (err or out or f"nmcli exited {rc}").strip()
    last = text.splitlines()[-1] if text.splitlines() else text
    last = last.replace("Error: ", "")
    if "not authorized" in last.lower() or "authoriz" in last.lower():
        return (last + " — the polkit rule is missing; re-run "
                "sudo ./deploy/install-pi.sh")
    if "Secrets were required" in last or "secrets" in last.lower():
        return "wrong password (or the network wanted one and none was given)"
    if "No network with SSID" in last:
        return last + " — send WIFI SCAN to see what is in range"
    return last


def device():
    """(name, state) of the first Wi-Fi interface, or (None, reason)."""
    rc, out, err = _run(["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"],
                        timeout=15)
    if rc:
        return None, _explain(rc, err, out)
    for line in out.splitlines():
        parts = _split(line)
        if len(parts) >= 3 and parts[1] == "wifi":
            return parts[0], parts[2]
    return None, "no Wi-Fi adapter"


def status():
    """What the operator wants to see: which network, and the IP to reach it on.

    Never raises — this is shown inside the Bluetooth STATUS reply, and a
    broken nmcli must not take the whole status text down with it.
    """
    info = {"device": "", "state": "", "ssid": "", "signal": "", "ip": ""}
    if not available():
        info["state"] = "nmcli not installed"
        return info

    dev, state = device()
    if not dev:
        info["state"] = state
        return info
    info["device"], info["state"] = dev, state

    # The active AP is authoritative for the SSID; the saved connection's name
    # can have been renamed by hand and then it no longer matches.
    rc, out, _ = _run(["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list",
                       "--rescan", "no"], timeout=20)
    if rc == 0:
        for line in out.splitlines():
            parts = _split(line)
            if len(parts) >= 3 and parts[0] == "yes":
                info["ssid"], info["signal"] = parts[1], parts[2]
                break

    rc, out, _ = _run(["-t", "-f", "IP4.ADDRESS", "device", "show", dev], timeout=15)
    if rc == 0:
        for line in out.splitlines():
            _, _, value = line.partition(":")
            value = value.replace("\\:", ":").strip()
            if value and value != "--":
                info["ip"] = value.split("/")[0]
                break
    return info


def status_line():
    """One line for the phone: 'MyNet  192.168.1.42  (78%)'."""
    info = status()
    if info["ssid"] and info["ip"]:
        signal = f"  ({info['signal']}%)" if info["signal"] else ""
        return f"{info['ssid']}  {info['ip']}{signal}"
    if info["ssid"]:
        return f"{info['ssid']}  (no IP yet)"
    return info["state"] or "not connected"


def scan(limit=12):
    """Nearby networks, strongest first, as (ssid, signal, security) rows."""
    if not available():
        raise WifiError("nmcli not installed (NetworkManager missing)")
    # A rescan too soon after the last one is refused; the cached list is still
    # perfectly usable, so the failure is ignored on purpose.
    _run(["device", "wifi", "rescan"], timeout=20)
    rc, out, err = _run(["-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"],
                        timeout=30)
    if rc:
        raise WifiError(_explain(rc, err, out))

    rows, seen = [], set()
    for line in out.splitlines():
        parts = _split(line)
        if len(parts) < 3 or not parts[0] or parts[0] in seen:
            continue          # blank SSID = hidden network; duplicates = mesh APs
        seen.add(parts[0])
        try:
            signal = int(parts[1])
        except ValueError:
            signal = 0
        rows.append((parts[0], signal, parts[2] or "open"))
    rows.sort(key=lambda row: row[1], reverse=True)
    return rows[:limit]


def connect(ssid, password=None, hidden=False):
    """Join `ssid` and save it so it comes back after a reboot.

    Returns the status() dict on success; raises WifiError with a message meant
    for the operator's phone otherwise.
    """
    ssid = (ssid or "").strip()
    if not ssid:
        raise WifiError("empty SSID")
    if not available():
        raise WifiError("nmcli not installed (NetworkManager missing)")
    if password is not None and 0 < len(password) < 8:
        # WPA rejects these anyway, but nmcli's own error is a wall of D-Bus
        # text and this is by far the most common typo.
        raise WifiError("WPA passwords are at least 8 characters")

    _run(["radio", "wifi", "on"], timeout=15)
    # Without a fresh scan a brand-new AP is "No network with SSID ..." even
    # though it is sitting right there.
    _run(["device", "wifi", "rescan"], timeout=20)

    args = ["-w", str(CONNECT_TIMEOUT), "device", "wifi", "connect", ssid]
    if password:
        args += ["password", password]
    if hidden:
        args += ["hidden", "yes"]

    rc, out, err = _run(args, timeout=CONNECT_TIMEOUT + 20)
    if rc:
        raise WifiError(_explain(rc, err, out))
    return status()


def forget(ssid):
    """Delete a saved network so the Pi stops rejoining it."""
    ssid = (ssid or "").strip()
    if not ssid:
        raise WifiError("empty SSID")
    rc, out, err = _run(["connection", "delete", "id", ssid], timeout=20)
    if rc:
        raise WifiError(_explain(rc, err, out))
    return f"forgot {ssid}"


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "scan":
        for name, signal, security in scan():
            print(f"{signal:>3}%  {security:<12} {name}")
    elif len(sys.argv) > 2 and sys.argv[1] == "connect":
        print(connect(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
    else:
        print(f"wifi: {status_line()}")
        print(f"raw : {status()}")
        print("usage: wifi_config.py [scan | connect <ssid> [password]]")
