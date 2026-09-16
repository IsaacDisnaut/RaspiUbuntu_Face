"""Persistent settings for the robot bridge (deep.py).

The broker URL has to survive a reboot and be changeable without a keyboard —
`cloudflared tunnel --url` mints a NEW xxxx.trycloudflare.com hostname every
time the operator PC restarts the tunnel, and the Pi is usually headless. So
the URL lives in a small JSON file that both the Bluetooth service
(bt_config.py) and the CLI (`python3 deep.py --set-url ...`) write, and deep.py
re-reads whenever it changes.

Precedence for the effective broker URL:
  1. config file "mqtt_url"      ← Bluetooth / --set-url write here, so a
                                   phone can always override a stale value
  2. env MQTT_URL
  3. env MQTT_BROKER + MQTT_PORT (legacy host/port pair, plain TCP)
  4. tcp://localhost:1883
"""

import json
import os
import re
import tempfile
from urllib.parse import urlparse

DEFAULT_URL = "tcp://localhost:1883"

# server.js proxies the broker's WebSocket listener at this path, so a tunnel
# hostname on its own means "the broker behind that tunnel".
DEFAULT_WS_PATH = "/ws/mqtt"

_SCHEME_PORTS = {"tcp": 1883, "mqtt": 1883, "mqtts": 8883, "ssl": 8883,
                 "ws": 80, "wss": 443}
_TLS_SCHEMES = ("wss", "mqtts", "ssl")
_WS_SCHEMES = ("ws", "wss")

DEFAULTS = {
    "mqtt_url": "",          # "" = fall through to env / DEFAULT_URL
    "serial_port": "auto",   # "auto" = first /dev/serial/by-id, then ttyUSB*/ttyACM*
    "baud_rate": 115200,
    "bt_name": "For4Aug",
    "bt_pin": "",            # "" = no PIN; any paired phone may change settings
    # The face page shown on the robot's own screen (web_kiosk.py). Storing it
    # here is what makes it come back at the next boot; "" = open nothing.
    "web_url": "",
    "web_kiosk": True,       # False = a normal window, for debugging on site
}


def config_path():
    """System-wide when we can write there, per-user otherwise."""
    env = os.environ.get("ROBOT_BRIDGE_CONFIG", "").strip()
    if env:
        return env
    system = "/etc/robot-bridge/config.json"
    if os.path.exists(system) and os.access(system, os.W_OK):
        return system
    parent = os.path.dirname(system)
    if os.access(parent, os.W_OK) or (not os.path.exists(parent) and os.access("/etc", os.W_OK)):
        return system
    home = os.path.expanduser("~/.config/robot-bridge/config.json")
    return home


def load():
    """Never raises — a corrupt file must not stop the robot from booting."""
    cfg = dict(DEFAULTS)
    path = config_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
        if isinstance(stored, dict):
            for key in DEFAULTS:
                if key in stored and stored[key] is not None:
                    cfg[key] = stored[key]
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[config] ignoring unreadable {path}: {e}")
    return cfg


def save(cfg):
    """Atomic write so a power cut mid-save can't leave a half file."""
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {key: cfg.get(key, DEFAULTS[key]) for key in DEFAULTS}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".config-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def update(**changes):
    cfg = load()
    cfg.update(changes)
    save(cfg)
    return cfg


# ── URL handling ─────────────────────────────────────────────
_HOSTISH = re.compile(r"^[A-Za-z0-9._-]+(:\d+)?(/.*)?$")


def normalize_url(raw):
    """Turn whatever the operator typed into a full broker URL.

    Returns (url, note). Raises ValueError on input we can't make sense of.
    Accepts the things people actually paste:
        xxxx.trycloudflare.com           → wss://xxxx.trycloudflare.com/ws/mqtt
        https://xxxx.trycloudflare.com   → wss://xxxx.trycloudflare.com/ws/mqtt
        https://xxxx.trycloudflare.com/  → wss://xxxx.trycloudflare.com/ws/mqtt
        192.168.1.5                      → tcp://192.168.1.5:1883
        192.168.1.5:1883                 → tcp://192.168.1.5:1883
        tcp://host:1883, wss://host/path → used as-is
    """
    raw = (raw or "").strip().strip('"').strip("'")
    if not raw:
        raise ValueError("empty URL")

    note = ""
    # Did the operator actually type ws:// or wss://? A lone "/" means
    # different things depending on the answer — see the path logic below.
    typed_ws_scheme = ("://" in raw and
                       raw.split("://", 1)[0].strip().lower() in _WS_SCHEMES)
    if "://" not in raw:
        if not _HOSTISH.match(raw):
            raise ValueError(f"'{raw}' is not a host or URL")
        head = raw.split("/", 1)[0]
        host, _, port = head.partition(":")
        # A bare hostname with dots and no port is almost always the tunnel;
        # bare IPs and localhost mean the LAN broker's plain-TCP listener.
        is_ip = re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host)
        if port or is_ip or host in ("localhost", "127.0.0.1") or "." not in host:
            raw = "tcp://" + raw
            note = "assumed plain TCP"
        else:
            raw = "wss://" + raw
            note = "assumed tunnel (wss)"

    parsed = urlparse(raw)
    scheme = (parsed.scheme or "tcp").lower()
    if scheme == "https":
        scheme, note = "wss", "https → wss"
    elif scheme == "http":
        scheme, note = "ws", "http → ws"
    if scheme not in _SCHEME_PORTS:
        raise ValueError(f"unsupported scheme '{scheme}' (use tcp/mqtt/mqtts/ws/wss)")
    if not parsed.hostname:
        raise ValueError(f"no host in '{raw}'")

    host = parsed.hostname
    port = parsed.port or _SCHEME_PORTS[scheme]
    path = parsed.path or ""
    if scheme in _WS_SCHEMES:
        # A trailing "/" on a pasted tunnel address is noise, not a request for
        # the broker's root path — cloudflared prints the URL that way and
        # browsers add the slash back. So https://host/ and a bare host both
        # get the proxy path. Only an explicitly typed ws://|wss://host/ is
        # taken literally, which keeps root-path brokers (the old public
        # test.mosquitto.org:8081) reachable.
        if not path or (path == "/" and not typed_ws_scheme):
            path = DEFAULT_WS_PATH
            note = (note + ", " if note else "") + f"path {DEFAULT_WS_PATH}"

    url = f"{scheme}://{host}:{port}{path}"
    return url, note


def parse_url(url):
    """Full URL → the pieces paho needs. Raises ValueError if unusable."""
    url, _ = normalize_url(url)
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    return {
        "url": url,
        "host": parsed.hostname,
        "port": parsed.port or _SCHEME_PORTS[scheme],
        "transport": "websockets" if scheme in _WS_SCHEMES else "tcp",
        "tls": scheme in _TLS_SCHEMES,
        "ws_path": parsed.path or DEFAULT_WS_PATH,
    }


def effective_url(cfg=None):
    """Apply the precedence chain documented at the top of this file."""
    cfg = cfg if cfg is not None else load()
    stored = (cfg.get("mqtt_url") or "").strip()
    if stored:
        return stored, "config file"

    env_url = os.environ.get("MQTT_URL", "").strip()
    if env_url:
        return env_url, "MQTT_URL env"

    host = os.environ.get("MQTT_BROKER", "").strip()
    if host:
        port = os.environ.get("MQTT_PORT", "1883").strip() or "1883"
        return f"tcp://{host}:{port}", "MQTT_BROKER env"

    return DEFAULT_URL, "default"
