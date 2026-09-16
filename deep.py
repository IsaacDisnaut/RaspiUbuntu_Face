"""MQTT → Arduino serial bridge for the avatar robot.

Runs on the Pi next to the robot (also fine on Windows). It subscribes to the
control topics, coalesces the flood of live joystick frames down to what the
Arduino can actually execute, and writes them to the serial port.

Two things make it survive a headless boot:
  • the broker URL, Wi-Fi and serial port live in robot_config (a JSON file),
    and can be changed over Bluetooth from a phone — see bt_config.py — because
    `cloudflared tunnel --url` mints a new trycloudflare.com host every restart;
  • nothing here is fatal: a missing broker, a missing Arduino, or a URL change
    all just retry / reconnect, so systemd can start it at boot before the USB
    device or the network is ready.

It also puts the customer-facing page on the robot's own screen: whatever URL
is stored as `web_url` is opened full screen as <url>/face (web_kiosk.py) and
reopened at every boot, so the robot comes up showing a face with nobody
touching it.

CLI:
  python3 deep.py                       run the bridge
  python3 deep.py --set-url <url|host>  store a broker URL and exit
  python3 deep.py --set-serial <dev>    store the Arduino port ('auto' to detect)
  python3 deep.py --set-web <url|host>  store the face page (<url>/face) and exit
  python3 deep.py --web-off             stop opening a page on the screen
  python3 deep.py --show-config         print stored + effective settings
  python3 deep.py --no-bluetooth        run without the Bluetooth config channel
  python3 deep.py --no-web              run without opening the screen
"""

import collections
import glob
import json
import os
import sys
import threading
import time

import paho.mqtt.client as mqtt
import serial

import robot_config
import web_kiosk

# Ubuntu/Raspberry Pi ships paho-mqtt 1.6 (apt), Windows pip installs 2.x, and
# the two differ in how the client is constructed and how callbacks are called.
# Support both so the same file runs on the robot Pi and the operator PC.
PAHO_V2 = hasattr(mqtt, "CallbackAPIVersion")

# Subscribe to BOTH topics: the web app publishes live joystick/D-pad frames
# AND AI emotion sequences to robot/emotion, but robot/control is kept as a
# fallback in case a client publishes live control there.
SUB_TOPICS = ["robot/emotion", "robot/control"]

# Flow control: after sending a frame, wait for the Arduino's "RUN COMPLETE"
# up to this many seconds before sending the next one. The Arduino finishes
# one motion at a time — pushing frames faster than that only fills its tiny
# (64-byte) serial buffer with stale positions, which is what caused the
# jerky, laggy movement.
LIVE_FRAME_TIMEOUT     = 1.0   # single live joystick/D-pad frames
SEQUENCE_FRAME_TIMEOUT = 30    # frames inside an AI emotion sequence

_reload  = threading.Event()   # set when Bluetooth/CLI changes the config
_status  = {"mqtt": "starting", "serial_state": "starting"}
_status_lock = threading.Lock()
_kiosk   = None                # web_kiosk.WebKiosk once the screen is managed


def set_status(**kw):
    with _status_lock:
        _status.update(kw)


def get_status():
    with _status_lock:
        return dict(_status)


class EventLog:
    """Recent activity, kept so a phone on the Bluetooth link can see it.

    Console output is unchanged — this is the same information for someone
    holding a phone next to the robot with no shell and no journalctl.
    Events marked `important` (broker connected, serial lost) are pushed to
    every open Bluetooth session unasked; the rest only reach sessions that
    asked for them with WATCH.
    """

    def __init__(self, capacity=200):
        self._items = collections.deque(maxlen=capacity)
        self._subs = []
        self._lock = threading.Lock()

    def add(self, text, important=False):
        line = time.strftime("%H:%M:%S ") + text
        with self._lock:
            self._items.append(line)
            subs = list(self._subs)
        for fn in subs:
            try:
                fn(line, important)
            except Exception:
                pass          # a dead Bluetooth session must not break the bridge

    def recent(self, count=20):
        with self._lock:
            return list(self._items)[-count:]

    def subscribe(self, fn):
        with self._lock:
            self._subs.append(fn)

    def unsubscribe(self, fn):
        with self._lock:
            if fn in self._subs:
                self._subs.remove(fn)


EVENTS = EventLog()


# ── Serial ───────────────────────────────────────────────────
def autodetect_port():
    """Pick the Arduino's tty. USB devices often enumerate a second or two
    after systemd starts us at boot, so this is re-run on every reopen."""
    if os.name == "nt":
        return "COM3"
    # by-id survives replugging and renumbering; prefer it when present.
    for pattern in ("/dev/serial/by-id/*", "/dev/ttyUSB*", "/dev/ttyACM*"):
        found = sorted(glob.glob(pattern))
        if found:
            return found[0]
    return None


class SerialLink:
    """Serial port that opens lazily and reopens itself after unplug/replug."""

    RETRY_SECONDS = 3.0

    def __init__(self, port, baud):
        self.port = port
        self.baud = baud
        self._ser = None
        self._next_try = 0.0
        self._lock = threading.Lock()

    def _resolve(self):
        if self.port and self.port != "auto":
            return self.port
        return autodetect_port()

    def _open(self):
        """Returns an open serial object or None. Never raises."""
        if self._ser and self._ser.is_open:
            return self._ser
        if time.time() < self._next_try:
            return None
        self._next_try = time.time() + self.RETRY_SECONDS

        target = self._resolve()
        if not target:
            set_status(serial="(none found)", serial_state="waiting for Arduino")
            return None
        try:
            self._ser = serial.Serial(target, self.baud, timeout=1)
            print(f"Serial port {target} opened at {self.baud} baud")
            set_status(serial=target, serial_state="open")
            EVENTS.add(f"serial open {target}", important=True)
            return self._ser
        except (serial.SerialException, OSError) as e:
            self._ser = None
            set_status(serial=target, serial_state=f"unavailable: {e}")
            return None

    def _drop(self, why):
        print(f"Serial link lost ({why}) — will reopen")
        EVENTS.add(f"serial LOST ({why})", important=True)
        try:
            if self._ser:
                self._ser.close()
        except Exception:
            pass
        self._ser = None
        set_status(serial_state=f"lost: {why}")

    def reconfigure(self, port, baud):
        with self._lock:
            if port == self.port and baud == self.baud:
                return
            print(f"Serial reconfigured: {self.port} → {port}")
            self.port, self.baud = port, baud
            self._next_try = 0.0
            self._drop("reconfigured")

    def send(self, obj):
        with self._lock:
            ser = self._open()
            if not ser:
                return
            line = json.dumps(obj, separators=(',', ':'))
            try:
                ser.write((line + "\n").encode("utf-8"))
                print(f"{ser.port} sent: {line}")
                EVENTS.add(f"TX → arduino  {line}")
            except (serial.SerialException, OSError) as e:
                self._drop(str(e))

    def drain(self):
        """Read and print any lines the Arduino already sent (non-blocking).
        Keeps a leftover 'RUN COMPLETE' from a previous frame from satisfying
        the wait for the NEXT frame prematurely."""
        with self._lock:
            ser = self._ser
            if not (ser and ser.is_open):
                return
            try:
                while ser.in_waiting > 0:
                    line = ser.readline().decode("utf-8", errors="ignore").strip()
                    if line:
                        print(f"Arduino: {line}")
                        EVENTS.add(f"arduino → {line}")
            except (serial.SerialException, OSError) as e:
                self._drop(str(e))

    def wait_for_run_complete(self, timeout=30, warn=True):
        """Block until Arduino sends 'RUN COMPLETE' or timeout expires."""
        with self._lock:
            ser = self._ser
            if not (ser and ser.is_open):
                return
            deadline = time.time() + timeout
            try:
                while time.time() < deadline:
                    if ser.in_waiting > 0:
                        line = ser.readline().decode("utf-8", errors="ignore").strip()
                        if line:
                            print(f"Arduino: {line}")
                            EVENTS.add(f"arduino → {line}")
                        if "RUN COMPLETE" in line:
                            return
                    time.sleep(0.02)
            except (serial.SerialException, OSError) as e:
                self._drop(str(e))
                return
        if warn:
            print("Warning: timed out waiting for Arduino RUN COMPLETE")


# ── Command coalescing ───────────────────────────────────────
# The browser publishes live control frames many times per second while the
# joystick/D-pad is held. Executing every one of them queues stale positions
# and the robot lags behind, replaying old moves (= stutter). Instead keep
# only the NEWEST command and let a single worker feed the serial port as
# fast as the hardware confirms each motion.
_pending      = None
_pending_lock = threading.Lock()
_pending_ev   = threading.Event()


def submit_command(payload_str):
    global _pending
    try:
        parsed = json.loads(payload_str)
    except Exception as e:
        print(f"Emotion parse error: {e}")
        return
    with _pending_lock:
        _pending = parsed          # overwrite — older unsent commands are stale
    _pending_ev.set()


def _take_pending():
    global _pending
    with _pending_lock:
        cmd = _pending
        _pending = None
        _pending_ev.clear()
    return cmd


def _has_pending():
    with _pending_lock:
        return _pending is not None


def serial_worker(link):
    while True:
        _pending_ev.wait()
        cmd = _take_pending()
        if cmd is None:
            continue
        frames = cmd if isinstance(cmd, list) else [cmd]
        # Arrays are emotion sequences even with a single frame — publishEmotion
        # always sends an array; live joystick/D-pad frames are bare objects.
        is_sequence = isinstance(cmd, list)
        for i, frame in enumerate(frames):
            # Newer input (e.g. the operator grabbing the joystick) overrides
            # the rest of a playing emotion sequence.
            if is_sequence and i > 0 and _has_pending():
                print("Sequence interrupted by newer command")
                break
            print(f"Frame {i + 1}/{len(frames)}: {frame}")
            link.drain()
            link.send(frame)
            if is_sequence:
                link.wait_for_run_complete(SEQUENCE_FRAME_TIMEOUT)
            else:
                # Short wait = pacing only; no warning spam while the operator
                # holds a direction and frames pace at the hardware's speed.
                link.wait_for_run_complete(LIVE_FRAME_TIMEOUT, warn=False)


# ── MQTT ─────────────────────────────────────────────────────
def on_connect(client, _userdata, _flags, reason_code, _properties=None):
    # Same positional slot for the result code in paho 1.x and 2.x.
    print(f"MQTT connected (code {reason_code})")
    set_status(mqtt="connected", last_error="")
    # Pushed to every open Bluetooth session: this is the "did my new URL
    # actually work?" answer the operator is waiting for after SET.
    EVENTS.add(f"*** BROKER CONNECTED  {get_status().get('broker', '?')}", important=True)
    for topic in SUB_TOPICS:
        client.subscribe(topic)
        print(f"Subscribed to {topic}")


def on_disconnect(_client, _userdata, *args):
    # paho 1.x passes (rc,); 2.x passes (flags, reason_code, properties).
    reason_code = args[1] if len(args) >= 3 else (args[0] if args else "?")
    print(f"MQTT disconnected (code {reason_code}) — paho will retry")
    set_status(mqtt="reconnecting")
    EVENTS.add(f"broker disconnected (code {reason_code})", important=True)


def on_message(_client, _userdata, msg):
    payload = msg.payload.decode("utf-8")
    print(f"\n[{msg.topic}] {payload[:120]}")
    print("-" * 30)
    EVENTS.add(f"RX [{msg.topic}] {payload[:100]}")
    submit_command(payload)


def build_client(spec):
    if PAHO_V2:
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            transport=spec["transport"],
        )
    else:
        client = mqtt.Client(transport=spec["transport"])
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    # paho requests "/" by default; server.js only proxies /ws/mqtt, so without
    # this the handshake falls through to Socket.IO and the connection is refused.
    if spec["transport"] == "websockets":
        client.ws_set_options(path=spec["ws_path"])
    if spec["tls"]:
        client.tls_set()
    return client


def mqtt_supervisor(link):
    """One connection per config generation; a config change tears it down and
    reconnects to the new broker without restarting the process."""
    while True:
        cfg = robot_config.load()
        link.reconfigure(cfg.get("serial_port") or "auto",
                         int(cfg.get("baud_rate") or 115200))

        raw_url, source = robot_config.effective_url(cfg)
        try:
            spec = robot_config.parse_url(raw_url)
        except ValueError as e:
            print(f"Bad broker URL '{raw_url}' ({e}) — using {robot_config.DEFAULT_URL}")
            set_status(broker=raw_url, broker_source=source, mqtt="bad URL",
                       last_error=str(e))
            spec = robot_config.parse_url(robot_config.DEFAULT_URL)

        where = f"{spec['host']}:{spec['port']}"
        if spec["transport"] == "websockets":
            where += spec["ws_path"]
        set_status(broker=spec["url"], broker_source=source, mqtt="connecting")
        print(f"Connecting to {where} ({spec['transport']}"
              f"{', TLS' if spec['tls'] else ''}) — from {source} …")
        EVENTS.add(f"connecting to {spec['url']} …", important=True)

        client = build_client(spec)
        _reload.clear()

        # Retry instead of dying if the broker isn't up yet (tunnel not started,
        # operator PC still booting) — but abandon the attempt the moment a new
        # URL arrives over Bluetooth.
        connected = False
        while not _reload.is_set():
            try:
                client.connect(spec["host"], spec["port"], 60)
                connected = True
                break
            except Exception as e:
                print(f"MQTT connect failed ({e}) — retrying in 5 s")
                set_status(mqtt=f"unreachable: {e}", last_error=str(e))
                # Not "important": this repeats every 5 s while a tunnel is
                # down, and pushing it unasked would bury the phone in noise.
                EVENTS.add(f"connect failed: {e} — retry in 5 s")
                _reload.wait(5)

        if connected:
            client.loop_start()
            _reload.wait()          # blocks until the config changes
            print("Config changed — reconnecting")
            try:
                client.disconnect()
                client.loop_stop()
            except Exception:
                pass


def on_config_change(cfg):
    if _kiosk:
        # Covers the CLI and any future writer; the Bluetooth WEB handler has
        # already applied its own change by the time this runs, and apply() is
        # a no-op when nothing moved.
        _kiosk.apply(cfg)
    _reload.set()


# ── CLI ──────────────────────────────────────────────────────
def cli(argv):
    """Returns True if the argument was a one-shot command (don't run the bridge)."""
    if not argv:
        return False
    cmd = argv[0]

    if cmd in ("--set-url", "--url"):
        if len(argv) < 2:
            print("usage: deep.py --set-url <url|host>")
            sys.exit(2)
        try:
            url, note = robot_config.normalize_url(argv[1])
        except ValueError as e:
            print(f"error: {e}")
            sys.exit(2)
        path = robot_config.save({**robot_config.load(), "mqtt_url": url})
        print(f"broker = {url}" + (f"  ({note})" if note else ""))
        print(f"saved to {path}")
        return True

    if cmd == "--set-serial":
        if len(argv) < 2:
            print("usage: deep.py --set-serial <device|auto>")
            sys.exit(2)
        path = robot_config.save({**robot_config.load(), "serial_port": argv[1]})
        print(f"serial = {argv[1]}\nsaved to {path}")
        return True

    if cmd in ("--set-web", "--web"):
        if len(argv) < 2:
            print("usage: deep.py --set-web <url|host>")
            sys.exit(2)
        try:
            url, note = web_kiosk.normalize_page_url(argv[1])
        except ValueError as e:
            print(f"error: {e}")
            sys.exit(2)
        path = robot_config.save({**robot_config.load(), "web_url": url})
        print(f"screen = {url}" + (f"  ({note})" if note else ""))
        print(f"saved to {path}  — restart the bridge to open it now")
        return True

    if cmd == "--web-off":
        path = robot_config.save({**robot_config.load(), "web_url": ""})
        print(f"screen = (nothing)\nsaved to {path}")
        return True

    if cmd in ("--show-config", "--status"):
        cfg = robot_config.load()
        url, source = robot_config.effective_url(cfg)
        browser, family = web_kiosk.find_browser()
        print(f"config file : {robot_config.config_path()}")
        print(f"stored      : {json.dumps(cfg, indent=2)}")
        print(f"broker      : {url}  (from {source})")
        print(f"serial       : {cfg.get('serial_port')} "
              f"(auto → {autodetect_port() or 'nothing detected'})")
        print(f"screen       : {cfg.get('web_url') or '(nothing)'}")
        print(f"browser      : {browser or 'none installed'}"
              f"{f' ({family})' if browser else ''}")
        print(f"display      : {'yes' if web_kiosk.display_env() else 'no desktop session'}")
        return True

    if cmd in ("-h", "--help"):
        print(__doc__)
        return True

    return False


def main():
    global _kiosk

    flags = ("--no-bluetooth", "--no-web")
    args = [a for a in sys.argv[1:] if a not in flags]
    if cli(args):
        return

    cfg = robot_config.load()
    link = SerialLink(cfg.get("serial_port") or "auto",
                      int(cfg.get("baud_rate") or 115200))

    # Started before anything else: at boot the desktop usually isn't up yet,
    # and the supervisor spends that time waiting for it rather than blocking.
    if "--no-web" not in sys.argv[1:] and os.name != "nt":
        _kiosk = web_kiosk.WebKiosk(events=EVENTS, status_cb=set_status)
        _kiosk.start()
        _kiosk.apply(cfg)

    if "--no-bluetooth" not in sys.argv[1:] and os.name != "nt":
        try:
            import bt_config
            bt_config.BluetoothConfigService(
                on_change=on_config_change,
                status_provider=get_status,
                events=EVENTS,
                web=_kiosk,
            ).start()
        except Exception as e:
            print(f"[bt] Bluetooth config channel not started: {e}")

    threading.Thread(target=serial_worker, args=(link,), daemon=True).start()
    mqtt_supervisor(link)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
