"""Full-screen browser on the robot's own screen, pointed at the face page.

The customer standing in front of the robot looks at a screen showing
`<server>/face` — the same web app the operator drives, joined to room FACE.
Somebody has to open that page, and on a robot that was just wheeled into a
room there is no keyboard to open it with. So the same phone that sets the
broker URL over Bluetooth can send

    WEB xxxx.trycloudflare.com

and this module opens `https://xxxx.trycloudflare.com/face` full screen on the
Pi's display. The URL is stored in robot_config, so the page comes back on its
own at the next boot: deep.py starts the supervisor below as it comes up, well
before the desktop exists, and it waits for one to appear.

Two things make that work from a systemd *system* service, which is the awkward
part — the service has no login session, so it inherits no DISPLAY, no
XAUTHORITY and no session bus:

  • `display_env()` finds the running X (or Wayland) session and rebuilds just
    enough environment to put a window on it. Until a session exists it returns
    None and the supervisor simply waits, which is the normal state for the
    first ~20 s of a boot.
  • the browser runs against a dedicated profile with camera and microphone
    pre-granted. A permission prompt on a robot with no keyboard is a dead end,
    and the face page needs getUserMedia immediately.
"""

import glob
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from urllib.parse import urlparse

# The room the customer-side page joins; server.js serves the SPA here and
# public/app.js reads the pathname to auto-join room FACE.
FACE_PATH = "/face"

# server.js in development mode serves the app over self-signed HTTPS on 3443
# and 301-redirects plain HTTP 3000 to it, so a LAN address with no port means
# this port. (In production it is behind a tunnel or nginx on 443.)
DEV_HTTPS_PORT = 3443

# Ports that are TLS when the operator types "host:port" with no scheme.
_TLS_PORTS = (443, 3443, 8443)

_HOSTISH = re.compile(r"^[A-Za-z0-9._-]+(:\d+)?(/.*)?$")
_IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")

# Preferred first: Chromium takes --kiosk and auto-accepts camera prompts and
# self-signed certs from the command line. Firefox needs a prepared profile
# (see _write_firefox_prefs) but is what Ubuntu on the Pi actually ships.
BROWSERS = [
    ("chromium", "chromium"),
    ("chromium-browser", "chromium"),
    ("google-chrome", "chromium"),
    ("google-chrome-stable", "chromium"),
    ("firefox", "firefox"),
    ("firefox-esr", "firefox"),
]

# Deliberately NOT a dotted directory: the Firefox snap is confined to
# non-hidden paths under $HOME, and a hidden one fails to launch at all.
PROFILE_DIRNAME = "robot-face-profile"

# Neither is a failure to back off from — the supervisor keeps polling, because
# both resolve on their own once the desktop comes up. They are told apart
# because they need completely different fixes and look identical from outside.
WAITING_FOR_SCREEN = "waiting for the screen (no desktop session yet)"
LOGIN_SCREEN = ("stopped at the login screen — nobody is logged in. Run "
                "sudo ./deploy/kiosk-autologin.sh so the Pi logs in by itself")
SCREEN_NOT_READY = (WAITING_FOR_SCREEN, LOGIN_SCREEN)


# ── URL ──────────────────────────────────────────────────────
def normalize_page_url(raw):
    """Turn what the operator typed into the full face-page URL.

    Returns (url, note); raises ValueError on input we can't make sense of.
        xxxx.trycloudflare.com          → https://xxxx.trycloudflare.com/face
        https://xxxx.trycloudflare.com/ → https://xxxx.trycloudflare.com/face
        192.168.1.5                     → https://192.168.1.5:3443/face
        192.168.1.5:3000                → http://192.168.1.5:3000/face
        http://host:3000/face           → used as-is
    """
    raw = (raw or "").strip().strip('"').strip("'")
    if not raw:
        raise ValueError("empty URL")

    note = ""
    if "://" not in raw:
        if not _HOSTISH.match(raw):
            raise ValueError(f"'{raw}' is not a host or URL")
        head = raw.split("/", 1)[0]
        host, _, port = head.partition(":")
        if not port:
            # A bare hostname is the tunnel (real cert, port 443). A bare IP is
            # the operator PC on the same Wi-Fi, where `npm start` is serving
            # its self-signed HTTPS on 3443.
            if _IPV4.match(host) or host in ("localhost", "127.0.0.1"):
                raw = f"https://{raw}:{DEV_HTTPS_PORT}"
                note = f"assumed dev server :{DEV_HTTPS_PORT}"
            else:
                raw = "https://" + raw
                note = "assumed https"
        else:
            scheme = "https" if int(port) in _TLS_PORTS else "http"
            raw = f"{scheme}://{raw}"
            note = f"assumed {scheme}"

    parsed = urlparse(raw)
    scheme = (parsed.scheme or "https").lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"unsupported scheme '{scheme}' (use http or https)")
    if not parsed.hostname:
        raise ValueError(f"no host in '{raw}'")

    # The whole point of the command: whatever they gave us, land on /face.
    # Typing it explicitly must not produce /face/face.
    path = parsed.path.rstrip("/")
    if not path.endswith(FACE_PATH):
        path += FACE_PATH
        note = (note + ", " if note else "") + f"added {FACE_PATH}"

    url = f"{scheme}://{parsed.netloc}{path}"
    if parsed.query:
        url += "?" + parsed.query
    return url, note


# ── Where the screen is ──────────────────────────────────────
def find_browser():
    """(path, family) of the first browser installed, or (None, None)."""
    for name, family in BROWSERS:
        path = shutil.which(name)
        if path:
            return path, family
    return None, None


def _x_display():
    """':1' from /tmp/.X11-unix/X1 — the socket exists exactly while X does."""
    sockets = sorted(glob.glob("/tmp/.X11-unix/X[0-9]*"))
    if not sockets:
        return None
    return ":" + os.path.basename(sockets[0])[1:]


def _x_authority(runtime_dir, home):
    """The magic-cookie file for the running X server.

    Read out of the X server's own command line (`Xorg ... -auth <file>`) so
    this works under gdm, lightdm and a plain startx without knowing which is
    in use — gdm3 puts it somewhere nobody would guess
    (/run/user/1000/gdm/Xauthority).
    """
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as fh:
                args = fh.read().decode("utf-8", "ignore").split("\0")
        except OSError:
            continue          # process exited between listdir and open
        if not args or not args[0]:
            continue
        if os.path.basename(args[0]) not in ("Xorg", "X", "Xwayland"):
            continue
        if "-auth" in args:
            candidate = args[args.index("-auth") + 1]
            if candidate and os.access(candidate, os.R_OK):
                return candidate

    for candidate in [os.path.join(runtime_dir, "gdm", "Xauthority"),
                      os.path.join(home, ".Xauthority")]:
        if os.access(candidate, os.R_OK):
            return candidate
    for candidate in glob.glob(os.path.join(runtime_dir, "*", "Xauthority")):
        if os.access(candidate, os.R_OK):
            return candidate
    return None


def _runtime_dir():
    return os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"


def _wayland_display(runtime_dir):
    if os.environ.get("WAYLAND_DISPLAY"):
        return os.environ["WAYLAND_DISPLAY"]
    found = [f for f in sorted(glob.glob(os.path.join(runtime_dir, "wayland-[0-9]*")))
             if not f.endswith(".lock")]
    return os.path.basename(found[0]) if found else None


def screen_reason():
    """Why display_env() came back empty.

    An X server being up is not the same as being able to draw on it: at the
    display manager's login screen the server belongs to the *greeter* user
    and its cookie is unreadable to us, so the browser has nothing to attach
    to until a real session exists. That needs autologin, not patience —
    unlike the first seconds of a boot, which need only patience.
    """
    if _x_display() or _wayland_display(_runtime_dir()):
        return LOGIN_SCREEN
    return WAITING_FOR_SCREEN


def display_env():
    """Environment for a GUI child process, or None while there is no screen.

    None is not an error at boot: the bridge starts before anyone has logged
    into the desktop, and the supervisor just tries again.
    """
    if os.name == "nt":
        return None
    runtime_dir = _runtime_dir()
    home = os.path.expanduser("~")

    env = {
        "HOME": home,
        "USER": os.environ.get("USER", ""),
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "XDG_RUNTIME_DIR": runtime_dir,
    }
    # Snap-packaged browsers (Ubuntu ships Firefox as a snap) need the session
    # bus to reach the desktop portals.
    bus = os.path.join(runtime_dir, "bus")
    if os.path.exists(bus):
        env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"

    display = os.environ.get("DISPLAY") or _x_display()
    if display:
        auth = os.environ.get("XAUTHORITY") or _x_authority(runtime_dir, home)
        # No readable cookie means the running X server is somebody else's —
        # the login greeter. Returning the display anyway would launch a
        # browser that dies on "cannot open display", which reads like a
        # broken browser rather than "log in first".
        if not auth:
            return None
        env["DISPLAY"] = display
        env["XAUTHORITY"] = auth
        return env

    wayland = _wayland_display(runtime_dir)
    if wayland:
        env["WAYLAND_DISPLAY"] = wayland
        env["XDG_SESSION_TYPE"] = "wayland"
        env["MOZ_ENABLE_WAYLAND"] = "1"
        return env
    return None


# ── Browser profile ──────────────────────────────────────────
# The face page calls getUserMedia the moment it loads. Firefox would put a
# camera/microphone doorhanger on screen and wait for a click that is never
# coming, so the permissions are granted in the profile instead. This profile
# is used for nothing but the face page, which is what makes that acceptable.
FIREFOX_PREFS = """// Written by web_kiosk.py on every launch — edits are overwritten.
user_pref("permissions.default.camera", 1);
user_pref("permissions.default.microphone", 1);
user_pref("media.navigator.permission.disabled", true);
// The LAN address is plain HTTP; getUserMedia is blocked on insecure origins
// unless these are set.
user_pref("media.devices.insecure.enabled", true);
user_pref("media.getusermedia.insecure.enabled", true);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
// Nothing below can be dismissed on a robot with no keyboard.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.auto", false);
user_pref("browser.tabs.warnOnClose", false);
"""


def profile_dir(home=None):
    return os.path.join(home or os.path.expanduser("~"), PROFILE_DIRNAME)


def _prepare_firefox_profile(path):
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(FIREFOX_PREFS)
    # A profile left locked by a killed browser makes the next launch pop a
    # "Firefox is already running" dialog and give up.
    for stale in ("lock", ".parentlock"):
        try:
            os.unlink(os.path.join(path, stale))
        except OSError:
            pass


def build_argv(browser, family, url, profile, kiosk=True):
    if family == "chromium":
        argv = [browser,
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--noerrdialogs",
                "--disable-infobars",
                "--disable-session-crashed-bubble",
                "--autoplay-policy=no-user-gesture-required",
                # No one can click through a camera prompt or a self-signed
                # certificate warning on the robot.
                "--use-fake-ui-for-media-stream",
                "--ignore-certificate-errors",
                "--unsafely-treat-insecure-origin-as-secure=" + _origin(url)]
        argv += ["--kiosk"] if kiosk else ["--start-maximized"]
        return argv + [url]

    argv = [browser, "--profile", profile, "--no-remote"]
    if kiosk:
        argv.append("--kiosk")
    return argv + [url]


def _origin(url):
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


# ── Supervisor ───────────────────────────────────────────────
class WebKiosk:
    """Keeps the face page on screen: launches it, restarts it if it dies, and
    waits patiently when there is no display yet.

    Safe to construct and start() even where none of this can work (no browser,
    no desktop, Windows) — it reports that in the status and does nothing else.
    """

    RETRY_SECONDS = 10
    MAX_BACKOFF = 120
    # No desktop yet is the normal state for the first seconds of a boot, not a
    # failure — poll steadily for it instead of backing off.
    SCREEN_POLL_SECONDS = 5
    # A browser that exits sooner than this after launching never really came
    # up (missing display, bad profile), so back off instead of hammering.
    QUICK_EXIT_SECONDS = 20

    def __init__(self, events=None, status_cb=None):
        self.events = events
        self.status_cb = status_cb or (lambda **kw: None)
        self._url = ""
        self._proc = None
        self._kiosk = True
        self._lock = threading.RLock()
        # Held across "kill the old browser" and "start the new one" so the two
        # can never overlap — they share one profile directory, and Firefox
        # refuses to start against a profile another copy still holds.
        self._launch_lock = threading.Lock()
        self._wake = threading.Event()
        self._state = "idle"

    # ── public API ───────────────────────────────────────────
    def start(self):
        threading.Thread(target=self._supervise, name="web-kiosk",
                         daemon=True).start()

    def apply(self, cfg):
        """Follow the stored config — called at startup and on every change."""
        self.open(cfg.get("web_url") or "", kiosk=cfg.get("web_kiosk", True))

    def open(self, url, kiosk=True):
        """Show `url` (already normalized), or nothing when url is empty."""
        with self._lock:
            unchanged = url == self._url and kiosk == self._kiosk
            self._url, self._kiosk = url, kiosk
            proc = None if unchanged else self._proc
            if not unchanged:
                self._proc = None
        if unchanged:
            self._wake.set()      # still nudge: may need a first launch
            return
        with self._launch_lock:
            stopped = self._kill(proc)
        if url:
            self._set_state("opening")
        else:
            self._set_state("closed" if stopped
                            else "close failed — the browser would not exit")
        self._wake.set()

    def stop(self):
        self.open("")

    def status(self):
        with self._lock:
            proc = self._proc
            url = self._url
        alive = proc is not None and proc.poll() is None
        return {"url": url, "state": self._state, "running": alive}

    # ── internals ────────────────────────────────────────────
    def _set_state(self, state):
        self._state = state
        self.status_cb(web=self._url or "(none)", web_state=state)

    def _log(self, text, important=False):
        print(f"[web] {text}")
        if self.events:
            self.events.add(f"web: {text}", important=important)

    def _want(self):
        with self._lock:
            return self._url, self._kiosk

    def _supervise(self):
        backoff = self.RETRY_SECONDS
        while True:
            url, kiosk = self._want()
            if not url:
                self._wake.wait()
                self._wake.clear()
                continue

            started = time.time()
            ok, why = self._launch(url, kiosk)
            if not ok:
                first_time = self._state != why
                self._set_state(why)
                if why in SCREEN_NOT_READY:
                    # Say it once, then keep quietly checking — at boot this is
                    # simply "the desktop hasn't finished starting", and if it
                    # is the login screen, someone logging in fixes it live.
                    if first_time:
                        self._log(why)
                    self._wait(self.SCREEN_POLL_SECONDS)
                    continue
                # Only worth interrupting the operator once, not every retry.
                if backoff == self.RETRY_SECONDS:
                    self._log(why)
                self._wait(backoff)
                backoff = min(backoff * 2, self.MAX_BACKOFF)
                continue

            self._set_state("showing " + url)
            self._log(f"showing {url}", important=True)
            self._watch(url, kiosk)

            if self._want() != (url, kiosk):
                backoff = self.RETRY_SECONDS      # new URL — start clean
                continue
            if time.time() - started < self.QUICK_EXIT_SECONDS:
                self._log("browser exited immediately — see "
                          f"{os.path.join(profile_dir(), 'browser.log')}")
                self._wait(backoff)
                backoff = min(backoff * 2, self.MAX_BACKOFF)
            else:
                self._log("browser closed — reopening")
                backoff = self.RETRY_SECONDS

    def _watch(self, url, kiosk):
        """Block until the browser exits or the wanted page changes."""
        while True:
            self._wait(2.0)
            if self._want() != (url, kiosk):
                return
            with self._lock:
                proc = self._proc
            if proc is None or proc.poll() is not None:
                return

    def _wait(self, seconds):
        self._wake.wait(seconds)
        self._wake.clear()

    def _launch(self, url, kiosk):
        browser, family = find_browser()
        if not browser:
            return False, "no browser installed (sudo apt install firefox)"
        env = display_env()
        if env is None:
            return False, screen_reason()

        profile = profile_dir(env["HOME"])
        argv = build_argv(browser, family, url, profile, kiosk)
        log_path = os.path.join(profile, "browser.log")

        with self._launch_lock:
            try:
                if family == "firefox":
                    _prepare_firefox_profile(profile)
                else:
                    os.makedirs(profile, exist_ok=True)
            except OSError as e:
                return False, f"cannot write {profile}: {e}"

            ok, why = self._clear_profile(profile)
            if not ok:
                return False, why
            try:
                log = open(log_path, "w", encoding="utf-8")
            except OSError:
                log = subprocess.DEVNULL
            try:
                # start_new_session: the browser forks a tree of content
                # processes, and its own process group is the only handle that
                # kills all of them at once when the URL changes.
                proc = subprocess.Popen(argv, env=env, cwd=env["HOME"],
                                        stdin=subprocess.DEVNULL,
                                        stdout=log, stderr=subprocess.STDOUT,
                                        start_new_session=True)
            except OSError as e:
                return False, f"launch failed: {e}"
            finally:
                if log is not subprocess.DEVNULL:
                    log.close()

        with self._lock:
            self._proc = proc
        return True, ""

    def _kill(self, proc):
        """Stop the browser and everything it forked. Returns whether it died.

        The browser's own process group is the handle for the whole tree of
        content processes; killing the parent alone leaves them on the screen.
        """
        if proc is None or proc.poll() is not None:
            return True
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(os.getpgid(proc.pid), sig)
            except OSError:
                try:
                    proc.send_signal(sig)
                except OSError:
                    pass
            try:
                proc.wait(timeout=8)
                return True
            except subprocess.TimeoutExpired:
                continue
        self._log(f"could not stop the browser (pid {proc.pid})")
        return False

    def _profile_holders(self, profile):
        """PIDs of browser processes still using our profile directory.

        The match is deliberately strict — an *exact* argv element, on a
        process whose executable is actually a browser. A loose substring
        search over the whole command line also hits the shell, editor or
        `grep` that merely has the path on its line, and this function's
        callers send signals to whatever it returns.
        """
        markers = (profile, f"--user-data-dir={profile}")
        holders = []
        me = os.getpid()
        for entry in os.listdir("/proc"):
            if not entry.isdigit() or int(entry) == me:
                continue
            try:
                with open(f"/proc/{entry}/cmdline", "rb") as fh:
                    args = fh.read().decode("utf-8", "ignore").split("\0")
            except OSError:
                continue          # process exited between listdir and open
            if not args or not args[0]:
                continue
            name = os.path.basename(args[0])
            if not name.startswith(("firefox", "chromium", "chrome", "google-chrome")):
                continue
            if any(marker in args for marker in markers):
                holders.append(int(entry))
        return holders

    def _clear_profile(self, profile):
        """Make sure nothing else holds the profile before launching into it.

        Worth checking rather than hoping for: a browser left behind by a
        killed service still owns the profile, and Firefox's refusal to start
        against a profile that is already open is *silent* — an empty log and
        an instant exit. Catching it here turns that into a readable status.
        """
        holders = self._profile_holders(profile)
        if not holders:
            return True, ""
        self._log(f"stopping leftover browser (pid {holders[0]})")
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in holders:
                try:
                    # Our own launches are process-group leaders, so this takes
                    # the content processes with it. Anything else gets a plain
                    # signal — never a stranger's whole group.
                    if os.getpgid(pid) == pid:
                        os.killpg(pid, sig)
                    else:
                        os.kill(pid, sig)
                except OSError:
                    pass
            deadline = time.time() + 6
            while time.time() < deadline:
                holders = self._profile_holders(profile)
                if not holders:
                    return True, ""
                time.sleep(0.25)
        return False, f"a leftover browser (pid {holders[0]}) still holds {profile}"


if __name__ == "__main__":
    # Standalone check: `python3 web_kiosk.py <url>` reports what would happen,
    # `python3 web_kiosk.py <url> --open` actually puts it on screen.
    import sys

    page = ""
    if len(sys.argv) > 1:
        page, hint = normalize_page_url(sys.argv[1])
        print(f"url     : {page}" + (f"  ({hint})" if hint else ""))

    found, kind = find_browser()
    print(f"browser : {found or 'NONE FOUND'} ({kind})")

    env = display_env()
    if env is None:
        print(f"display : {WAITING_FOR_SCREEN}")
    else:
        shown = [f"{k}={env[k]}" for k in ("DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY")
                 if k in env]
        print("display : " + "  ".join(shown))
    print(f"profile : {profile_dir()}")

    if page and "--open" in sys.argv[2:]:
        screen = WebKiosk()
        screen.start()
        screen.open(page)
        print("opening — Ctrl-C to close it again")
        try:
            while True:
                time.sleep(3)
                print(screen.status())
        except KeyboardInterrupt:
            screen.stop()
            time.sleep(1)
