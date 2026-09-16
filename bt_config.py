"""Bluetooth (RFCOMM / Serial Port Profile) config channel for the robot bridge.

Why this exists: the Pi runs headless next to the robot, but the broker URL
changes every time the operator restarts `cloudflared` — a brand new
xxxx.trycloudflare.com. Instead of plugging in a keyboard or hunting for the
Pi's IP, pair a phone once and send one line from any "Serial Bluetooth
Terminal" app:

    SET xxxx.trycloudflare.com

deep.py picks the change up immediately and reconnects; the value is stored in
robot_config so it survives a reboot.

The same channel carries the other two things you cannot do without a keyboard
once the robot has been wheeled into a new room:

    WIFI <ssid> <password>      join the Wi-Fi here
    WEB <url>                   show <url>/face on the robot's own screen

Both are stored the same way and come back at the next boot — Wi-Fi because
NetworkManager saves the connection, the page because web_kiosk.py reopens
whatever robot_config remembers. Bluetooth is deliberately the transport for
all of it: it is the only link that still works when the Pi is on the wrong
network, or on none.

Implemented on BlueZ's D-Bus API (org.bluez.ProfileManager1) rather than
`sdptool`, which needs bluetoothd's deprecated compat mode. Classic SPP, not
BLE, because it works with every stock Android terminal app and needs no
custom GATT client. (iOS has no SPP — use SSH or `--set-url` there.)
"""

import shlex
import socket
import threading
import traceback

import robot_config
import web_kiosk
import wifi_config

SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb"
PROFILE_PATH = "/org/robotbridge/spp"
AGENT_PATH = "/org/robotbridge/agent"

def peer_label(path):
    """/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF → AA:BB:CC:DD:EE:FF, so the log
    says which phone sent a command when more than one is paired."""
    tail = str(path).rsplit("/", 1)[-1]
    return tail[4:].replace("_", ":") if tail.startswith("dev_") else str(path)


def split_wifi_arg(arg):
    """'MyNet hunter2' → ('MyNet', 'hunter2').

    An unquoted line can't say whether a space belongs to the SSID or the
    password, so the first token is the SSID and the rest is the password —
    and `WIFI "My Network" hunter2` covers the case where that guess is wrong.
    """
    try:
        parts = shlex.split(arg)
    except ValueError:          # unbalanced quote — fall back to plain split
        parts = arg.split()
    if not parts:
        return "", ""
    return parts[0], " ".join(parts[1:])


def redact(text):
    """Keep PINs and Wi-Fi passwords out of the console and the journal."""
    cmd, sep, arg = text.partition(" ")
    keyword = cmd.strip().upper()
    if keyword in ("PIN", "SETPIN") and arg.strip():
        return f"{cmd} ****"
    if keyword == "WIFI":
        ssid, password = split_wifi_arg(arg)
        if password:
            return f"{cmd} {ssid} ****"
    return text


HELP = """Robot bridge — commands (one per line):
  STATUS                 show Wi-Fi + broker + serial + screen state
  LOG [n]                last n messages (default 20)
  WATCH / WATCH OFF      stream messages live as they happen
  GET                    show the broker URL in use
  SET <url|host>         set broker, e.g. SET abc.trycloudflare.com
                         also: SET tcp://192.168.1.5:1883
  WIFI                   show the Wi-Fi network and IP address
  WIFI <ssid> <pass>     join a network (quote an SSID with spaces)
  WIFI SCAN              list the networks in range
  WEB <url>              show <url>/face on the robot's screen, now and at boot
  WEB                    show which page the screen is on
  WEB OFF                close it and stop opening it at boot
  SERIAL <dev|auto>      set Arduino port, e.g. SERIAL /dev/ttyUSB0
  NAME <name>            rename this Bluetooth device
  PIN <pin>              unlock (only if a PIN is configured)
  SETPIN <pin|->         set/clear the PIN ('-' clears it)
  RESET                  clear stored broker URL (back to default)
  PING                   PONG
  HELP                   this text

Broker connects/disconnects are pushed to you automatically."""


class BluetoothConfigService:
    """Runs a GLib main loop in its own thread; safe to start() and forget."""

    def __init__(self, on_change=None, status_provider=None, events=None, web=None):
        self.on_change = on_change or (lambda cfg: None)
        self.status_provider = status_provider or (lambda: {})
        self.events = events        # deep.py's EventLog, or None when standalone
        # web_kiosk.WebKiosk, or None when the screen isn't managed from here.
        # WEB still stores the URL without it — it just won't open until the
        # bridge is restarted.
        self.web = web
        self._thread = None
        self._bus = None
        self._loop = None
        self._adapter_props = None

    # ── lifecycle ────────────────────────────────────────────
    def start(self):
        self._thread = threading.Thread(target=self._run, name="bt-config", daemon=True)
        self._thread.start()

    def _run(self):
        try:
            self._serve()
        except Exception as e:
            print(f"[bt] Bluetooth config service unavailable: {e}")
            print("[bt] The MQTT bridge keeps running; set the broker with "
                  "`python3 deep.py --set-url <url>` instead.")

    def _serve(self):
        import dbus
        import dbus.mainloop.glib
        import dbus.service
        from gi.repository import GLib

        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        bus = dbus.SystemBus()
        self._bus = bus
        service = self

        class Agent(dbus.service.Object):
            """NoInputNoOutput pairing agent — a headless Pi has no keypad, so
            it accepts bonds automatically ("just works" pairing)."""

            @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
            def Release(self):
                pass

            @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
            def AuthorizeService(self, device, uuid):
                print(f"[bt] authorized {uuid} for {device}")

            @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="s")
            def RequestPinCode(self, device):
                return "0000"

            @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="u")
            def RequestPasskey(self, device):
                return dbus.UInt32(0)

            @dbus.service.method("org.bluez.Agent1", in_signature="ouq", out_signature="")
            def DisplayPasskey(self, device, passkey, entered):
                print(f"[bt] passkey {passkey:06d} for {device}")

            @dbus.service.method("org.bluez.Agent1", in_signature="os", out_signature="")
            def DisplayPinCode(self, device, pincode):
                print(f"[bt] pin {pincode} for {device}")

            @dbus.service.method("org.bluez.Agent1", in_signature="ou", out_signature="")
            def RequestConfirmation(self, device, passkey):
                print(f"[bt] confirmed pairing with {device}")

            @dbus.service.method("org.bluez.Agent1", in_signature="o", out_signature="")
            def RequestAuthorization(self, device):
                print(f"[bt] authorized {device}")

            @dbus.service.method("org.bluez.Agent1", in_signature="", out_signature="")
            def Cancel(self):
                pass

        class Profile(dbus.service.Object):
            @dbus.service.method("org.bluez.Profile1", in_signature="", out_signature="")
            def Release(self):
                pass

            @dbus.service.method("org.bluez.Profile1", in_signature="oha{sv}", out_signature="")
            def NewConnection(self, path, fd, properties):
                # dbus hands us a borrowed fd; take() transfers ownership so it
                # stays valid after this method returns.
                raw = fd.take() if hasattr(fd, "take") else int(fd)
                sock = socket.socket(fileno=raw)
                # BlueZ hands the fd over with O_NONBLOCK set. Without this the
                # first recv() raises BlockingIOError — a subclass of OSError,
                # so it looks like a dropped link — and the phone is kicked off
                # the instant it connects.
                sock.setblocking(True)
                who = peer_label(path)
                print(f"[bt] phone connected: {who}")
                if service.events:
                    service.events.add(f"BT phone connected: {who}", important=True)
                threading.Thread(target=service._session, args=(sock, who),
                                 name="bt-session", daemon=True).start()

            @dbus.service.method("org.bluez.Profile1", in_signature="o", out_signature="")
            def RequestDisconnection(self, path):
                print(f"[bt] phone disconnected: {peer_label(path)}")

        cfg = robot_config.load()
        adapter = self._find_adapter(dbus, bus)
        self._adapter_props = dbus.Interface(
            bus.get_object("org.bluez", adapter), "org.freedesktop.DBus.Properties")
        self._make_visible(dbus, cfg.get("bt_name") or "For4Aug")

        agent = Agent(bus, AGENT_PATH)
        agent_mgr = dbus.Interface(bus.get_object("org.bluez", "/org/bluez"),
                                   "org.bluez.AgentManager1")
        agent_mgr.RegisterAgent(AGENT_PATH, "NoInputNoOutput")
        try:
            agent_mgr.RequestDefaultAgent(AGENT_PATH)
        except dbus.DBusException as e:
            print(f"[bt] note: another default agent is registered ({e.get_dbus_name()})")

        profile = Profile(bus, PROFILE_PATH)
        profile_mgr = dbus.Interface(bus.get_object("org.bluez", "/org/bluez"),
                                     "org.bluez.ProfileManager1")
        # Role=server: the Pi only ever advertises and waits. It never scans and
        # never dials out — the phone is always the one that connects, so the
        # robot doesn't care which phone (or how many over time) is used.
        opts = {
            "Name": "For4Aug Config",
            "Role": "server",
            "Channel": dbus.UInt16(1),
            "RequireAuthentication": dbus.Boolean(True),   # phone must be bonded
            "RequireAuthorization": dbus.Boolean(False),   # no prompt on the Pi — it's headless
        }
        try:
            profile_mgr.RegisterProfile(PROFILE_PATH, SPP_UUID, opts)
        except dbus.DBusException:
            # Channel 1 already taken (another SPP service) — let BlueZ pick.
            opts.pop("Channel")
            profile_mgr.RegisterProfile(PROFILE_PATH, SPP_UUID, opts)

        print(f"[bt] listening as '{cfg.get('bt_name') or 'For4Aug'}' "
              f"(Bluetooth SPP) — pair, then send: SET <url>")

        # Pairing or a bluetoothd restart can silently clear these; re-assert.
        GLib.timeout_add_seconds(60, self._reassert, dbus)

        self._loop = GLib.MainLoop()
        self._loop.run()

    def _find_adapter(self, dbus, bus):
        obj_mgr = dbus.Interface(bus.get_object("org.bluez", "/"),
                                 "org.freedesktop.DBus.ObjectManager")
        for path, ifaces in obj_mgr.GetManagedObjects().items():
            if "org.bluez.Adapter1" in ifaces:
                return path
        raise RuntimeError("no Bluetooth adapter found (is `bluetoothd` running?)")

    def _make_visible(self, dbus, name):
        props = {
            "Powered": dbus.Boolean(True),
            "Pairable": dbus.Boolean(True),
            "PairableTimeout": dbus.UInt32(0),   # 0 = never stop accepting bonds
            "Discoverable": dbus.Boolean(True),
            "DiscoverableTimeout": dbus.UInt32(0),
            "Alias": dbus.String(name),
        }
        for key, value in props.items():
            try:
                self._adapter_props.Set("org.bluez.Adapter1", key, value)
            except Exception as e:
                print(f"[bt] could not set {key}: {e}")

    def _reassert(self, dbus):
        """BlueZ reverts Discoverable/Pairable when whichever D-Bus client set
        them goes away — including a `bluetoothctl` session or a second copy of
        this script that exited. Discoverable and Pairable are reverted
        independently, so check both: an adapter that is visible but not
        pairable shows up in the phone's scan list and then refuses to bond."""
        try:
            for prop in ("Discoverable", "Pairable"):
                if not self._adapter_props.Get("org.bluez.Adapter1", prop):
                    print(f"[bt] adapter {prop} was cleared — restoring")
                    cfg = robot_config.load()
                    self._make_visible(dbus, cfg.get("bt_name") or "For4Aug")
                    break
        except Exception:
            pass
        return True  # keep the timer alive

    def rename(self, name):
        if self._adapter_props is None:
            return
        import dbus
        try:
            self._adapter_props.Set("org.bluez.Adapter1", "Alias", dbus.String(name))
        except Exception as e:
            print(f"[bt] rename failed: {e}")

    # ── session ──────────────────────────────────────────────
    def _session(self, sock, peer):
        sess = {
            "authed": not (robot_config.load().get("bt_pin") or "").strip(),
            "watch": False,
        }
        # The bridge's worker threads push events here while this thread may be
        # writing a command reply, so serialise every write to the socket.
        send_lock = threading.Lock()

        def write(text):
            with send_lock:
                sock.sendall((text + "\r\n").encode())

        # Commands that block for a while (joining a Wi-Fi network takes tens
        # of seconds) say so before they start, so the phone isn't staring at
        # a terminal that looks hung.
        sess["write"] = write

        def on_event(line, important):
            # Unasked-for pushes are limited to the things worth interrupting
            # for (broker up/down, serial lost); the rest need WATCH.
            if sess["watch"] or important:
                write(line)

        if self.events:
            self.events.subscribe(on_event)

        buf = b""
        reason = "phone closed the link"
        try:
            sock.setblocking(True)     # belt and braces — see NewConnection
            with send_lock:
                sock.sendall(self._banner().encode())
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf or b"\r" in buf:
                    line, sep, buf = buf.partition(b"\n") if b"\n" in buf else buf.partition(b"\r")
                    text = line.decode("utf-8", errors="ignore").strip()
                    if not text:
                        continue
                    shown = redact(text)
                    print(f"[bt] {peer} > {shown}")
                    if self.events:
                        self.events.add(f"BT {peer} > {shown}")
                    reply = self._handle(text, sess)
                    # Multi-line replies (HELP, LOG, STATUS) would swamp the
                    # console, so log the first line and mark the rest.
                    head = reply.split("\r\n", 1)[0]
                    more = " …" if "\r\n" in reply else ""
                    print(f"[bt] {peer} < {head}{more}")
                    write(reply)
        except OSError as e:
            # Never swallow this silently: a session that dies the moment it
            # opens looks identical to the phone hanging up, and the reason is
            # the only thing that tells the two apart.
            reason = f"link error: {type(e).__name__}: {e}"
        except Exception as e:
            reason = f"bug: {type(e).__name__}: {e}"
            traceback.print_exc()
        finally:
            if self.events:
                self.events.unsubscribe(on_event)
            try:
                sock.close()
            except OSError:
                pass
            print(f"[bt] session closed: {peer} ({reason})")
            if self.events:
                self.events.add(f"BT session closed: {peer} ({reason})")

    def _banner(self):
        return ("\r\n== Robot bridge ==\r\n" + self._status_text() +
                "\r\nHELP for commands, LOG for recent messages, WATCH to stream.\r\n")

    def _status_text(self):
        try:
            st = self.status_provider() or {}
        except Exception as e:
            return f"status unavailable: {e}"
        lines = [f"{'wifi':>13}: {self._wifi_line()}"]
        for key in ("broker", "broker_source", "mqtt", "serial", "serial_state",
                    "web", "web_state", "last_error"):
            if st.get(key):
                lines.append(f"{key:>13}: {st[key]}")
        return "\r\n".join(lines)

    def _wifi_line(self):
        # Asked live rather than cached: this is usually the first thing read
        # after a move, and a stale answer would be worse than none.
        try:
            return wifi_config.status_line()
        except Exception as e:
            return f"unavailable ({e})"

    def _handle(self, text, sess):
        """Returns the reply line; mutates `sess` for stateful commands."""
        cmd, _, arg = text.partition(" ")
        cmd = cmd.strip().upper()
        arg = arg.strip()
        cfg = robot_config.load()
        pin = (cfg.get("bt_pin") or "").strip()

        if cmd in ("HELP", "?"):
            return HELP.replace("\n", "\r\n")
        if cmd == "PING":
            return "PONG"
        if cmd == "STATUS":
            return self._status_text()
        if cmd == "LOG":
            if not self.events:
                return "ERR no event log (running standalone)"
            try:
                count = max(1, min(int(arg), 200)) if arg else 20
            except ValueError:
                return "ERR usage: LOG [count]"
            lines = self.events.recent(count)
            return "\r\n".join(lines) if lines else "(nothing yet)"
        if cmd == "WATCH":
            if not self.events:
                return "ERR no event log (running standalone)"
            sess["watch"] = arg.upper() not in ("OFF", "0", "STOP")
            return ("OK watching — every message is streamed here. WATCH OFF to stop."
                    if sess["watch"] else "OK stopped watching")
        if cmd in ("GET", "URL") and not arg:
            url, source = robot_config.effective_url(cfg)
            return f"OK {url}  (from {source})"
        if cmd == "IP":
            return f"OK {self._wifi_line()}"
        if cmd == "PIN":
            if not pin:
                sess["authed"] = True
                return "OK no PIN configured — already unlocked"
            if arg == pin:
                sess["authed"] = True
                return "OK unlocked"
            return "ERR wrong PIN"

        # WIFI and WEB report when they're bare, so those forms stay readable
        # on a locked session — only the forms that change something are gated.
        mutating = cmd in ("SET", "URL", "SERIAL", "NAME", "SETPIN", "RESET",
                           "WIFI", "WEB")
        if cmd in ("WIFI", "WEB") and (not arg or arg.upper() == "SCAN"):
            mutating = False
        if mutating and pin and not sess["authed"]:
            return "ERR locked — send: PIN <pin>"

        try:
            if cmd in ("SET", "URL"):
                if not arg:
                    return "ERR usage: SET <url|host>"
                url, note = robot_config.normalize_url(arg)
                robot_config.update(mqtt_url=url)
                self.on_change(robot_config.load())
                # The BROKER CONNECTED push follows on its own once it dials in.
                return (f"OK broker = {url}" + (f"  ({note})" if note else "") +
                        " — connecting, watch for BROKER CONNECTED")

            if cmd in ("WIFI", "WIFISCAN"):
                return self._wifi(cmd, arg, sess)

            if cmd == "WEB":
                return self._web(arg, cfg)

            if cmd == "SERIAL":
                if not arg:
                    return "ERR usage: SERIAL <device|auto>"
                robot_config.update(serial_port=arg)
                self.on_change(robot_config.load())
                return f"OK serial = {arg}"

            if cmd == "NAME":
                if not arg:
                    return "ERR usage: NAME <name>"
                robot_config.update(bt_name=arg)
                self.rename(arg)
                return f"OK bluetooth name = {arg} (re-pair if your phone caches the old one)"

            if cmd == "SETPIN":
                new = "" if arg in ("-", "none", "NONE", "") else arg
                robot_config.update(bt_pin=new)
                sess["authed"] = True
                return "OK PIN cleared" if not new else f"OK PIN set ({len(new)} chars)"

            if cmd == "RESET":
                robot_config.update(mqtt_url="", serial_port="auto")
                self.on_change(robot_config.load())
                url, source = robot_config.effective_url()
                return f"OK reset — broker = {url} (from {source})"
        except wifi_config.WifiError as e:
            return f"ERR {e}"
        except ValueError as e:
            return f"ERR {e}"
        except Exception as e:
            return f"ERR {type(e).__name__}: {e}"

        return f"ERR unknown command '{cmd}' — send HELP"

    # ── WIFI / WEB ───────────────────────────────────────────
    def _wifi(self, cmd, arg, sess):
        """WIFI | WIFI SCAN | WIFI <ssid> [password]"""
        if cmd == "WIFISCAN" or arg.upper() == "SCAN":
            rows = wifi_config.scan()
            if not rows:
                return "(no networks in range)"
            return "\r\n".join(f"{signal:>3}%  {security:<11} {ssid}"
                               for ssid, signal, security in rows)
        if not arg:
            return f"OK wifi = {self._wifi_line()}"

        ssid, password = split_wifi_arg(arg)
        progress = sess.get("write") or (lambda _text: None)
        progress(f"… joining {ssid} — up to {wifi_config.CONNECT_TIMEOUT} s")
        info = wifi_config.connect(ssid, password or None)
        # A different network almost always means a different route to the
        # broker, so make the bridge re-dial instead of waiting for a timeout.
        self.on_change(robot_config.load())
        return (f"OK wifi = {info['ssid'] or ssid}  "
                f"{info['ip'] or 'connected, no IP yet'}")

    def _web(self, arg, cfg):
        """WEB | WEB OFF | WEB <url>  — the page on the robot's own screen."""
        if not arg:
            stored = (cfg.get("web_url") or "").strip()
            if not stored:
                return "OK no page set — send: WEB <url>"
            if self.web:
                return f"OK {stored}  ({self.web.status()['state']})"
            return f"OK {stored}"

        if arg.upper() in ("OFF", "STOP", "CLOSE", "-"):
            robot_config.update(web_url="")
            if not self.web:
                return "OK nothing will open at boot"
            self.web.stop()
            # Don't answer OK for a window that is still on the robot's face:
            # the setting is cleared either way, but the operator is standing
            # in front of the screen and can see which of the two happened.
            state = self.web.status()["state"]
            if state != "closed":
                return f"ERR {state} (the stored page was cleared)"
            return "OK screen closed — nothing will open at boot"

        url, note = web_kiosk.normalize_page_url(arg)
        updated = robot_config.update(web_url=url)
        if not self.web:
            return f"OK saved {url} — opens when the bridge restarts"
        self.web.apply(updated)
        return f"OK screen = {url}" + (f"  ({note})" if note else "")


if __name__ == "__main__":
    # Standalone smoke test: run the service with a dummy status provider.
    import time

    svc = BluetoothConfigService(
        on_change=lambda cfg: print(f"[test] config changed: {cfg}"),
        status_provider=lambda: {"broker": robot_config.effective_url()[0],
                                 "mqtt": "(standalone test — not connected)"},
    )
    svc.start()
    print("Bluetooth config service running. Ctrl-C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
