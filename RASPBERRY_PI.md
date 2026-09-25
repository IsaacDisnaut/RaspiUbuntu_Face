# Running the robot bridge on the Raspberry Pi (Ubuntu)

`deep.py` is the piece that sits next to the robot: it subscribes to the MQTT
control topics and writes motion frames to the Arduino over USB serial. On the
Pi it runs as a systemd service, starts at boot, and is configured from a phone
over Bluetooth — no keyboard, no screen, no SSH.

Three things can be set from that phone, and all three survive a reboot:

| | Command | |
|---|---|---|
| the broker | `SET xxxx.trycloudflare.com` | the tunnel changes every restart |
| the Wi-Fi | `WIFI <ssid> <password>` | every room has a different network |
| the screen | `WEB xxxx.trycloudflare.com` | opens `<url>/face` on the robot |

Bluetooth carries all of it on purpose: it is the one link that still works
when the Pi is on the wrong network, or on no network at all.

## Install

```bash
cd ~/Webtester-main/Webtester-main
sudo ./deploy/install-pi.sh
```

That installs the missing apt packages (`python3-paho-mqtt`, `python3-serial`,
`python3-dbus`, `python3-gi`, `bluez`), adds your user to `dialout` and
`bluetooth`, creates `/etc/robot-bridge/config.json`, installs the polkit rule
that lets the `WIFI` command work, and enables the `robot-bridge` service.
Re-running it on an existing install is safe and is how you pick up a new
version.

The polkit rule is there because the bridge runs as a *system* service with no
login session, so polkit does not count it as "active" and would otherwise
refuse to let it change network settings. It grants one user the Wi-Fi actions
`wifi_config.py` calls, and nothing else.

```bash
systemctl status robot-bridge      # is it up?
journalctl -u robot-bridge -f      # live log
sudo systemctl restart robot-bridge
sudo systemctl disable --now robot-bridge   # stop it starting at boot
```

## Setting the broker URL over Bluetooth

The operator PC's `cloudflared tunnel --url` prints a **new**
`xxxx.trycloudflare.com` hostname every time it restarts, so the Pi needs to be
told the new address. Do it from a phone:

1. Pair with **For4Aug** in the phone's Bluetooth settings (no PIN by
   default — it accepts the pairing automatically).
2. Open any SPP terminal app — Android: *Serial Bluetooth Terminal*
   (Kai Morich) works well. Connect to `For4Aug`.
3. Send one line:

   ```
   SET xxxx.trycloudflare.com
   ```

   The reply is `OK broker = wss://xxxx.trycloudflare.com:443/ws/mqtt`. The
   bridge drops the old connection and dials the new broker within a second or
   two — no reboot, no restart. The value is saved, so it is still there after
   a power cut.

> iOS has no Serial Port Profile, so an iPhone can't use this. Use
> `--set-url` over SSH instead (below).

### Commands

| Command | What it does |
|---|---|
| `STATUS` | Wi-Fi, broker, MQTT state, serial port, screen |
| `LOG [n]` | the last n messages (default 20, max 200) |
| `WATCH` / `WATCH OFF` | stream every message live as it happens |
| `GET` | the broker URL currently in use |
| `SET <url or host>` | set the broker (see formats below) |
| `WIFI` / `IP` | the Wi-Fi network and IP address in use |
| `WIFI <ssid> <password>` | join a network — see below |
| `WIFI SCAN` | the networks in range, strongest first |
| `WEB <url>` | show `<url>/face` on the robot's screen — see below |
| `WEB` / `WEB OFF` | which page is showing / close it |
| `SERIAL <dev\|auto>` | set the Arduino port, e.g. `SERIAL /dev/ttyUSB0` |
| `NAME <name>` | rename the Bluetooth device |
| `SETPIN <pin>` / `SETPIN -` | require a PIN for changes / clear it |
| `PIN <pin>` | unlock a session when a PIN is set |
| `RESET` | forget the stored URL, back to `tcp://localhost:1883` |
| `PING`, `HELP` | as they sound |

`WIFI`, `WEB` and `WIFI SCAN` with no arguments only *report*, so they still
answer on a PIN-locked session; the forms that change something do not.

### Watching the traffic

You don't have to ask for the important things — as long as the phone is
connected it is told when the broker connects or drops and when the Arduino is
unplugged, whatever else you're doing:

```
SET abc-def.trycloudflare.com
OK broker = wss://abc-def.trycloudflare.com:443/ws/mqtt — connecting, watch for BROKER CONNECTED
11:43:41 connecting to wss://abc-def.trycloudflare.com:443/ws/mqtt …
11:43:41 *** BROKER CONNECTED  wss://abc-def.trycloudflare.com:443/ws/mqtt
```

If that last line doesn't arrive, the URL is wrong or the tunnel is down — send
`LOG` to see the reason (`connect failed: …`, repeating every 5 s).

`WATCH` adds the per-message traffic on top, which is how you tell where a
stuck robot is stuck — MQTT not arriving, or arriving but not reaching the arm:

```
WATCH
11:43:44 RX [robot/emotion] [{"j1":45,"j2":90}]     ← came from the web app
11:43:44 TX → arduino  {"j1":45,"j2":90}            ← written to the serial port
11:43:45 arduino → RUN COMPLETE                     ← the arm confirmed the move
WATCH OFF
```

`LOG` shows the same history after the fact — the bridge keeps the last 200
events in memory (not on disk, so a restart clears them). Both are the same
information the terminal prints; they exist because a phone standing next to
the robot has no `journalctl`.

It works the other way too: every command a phone sends is printed on the Pi
and goes into the journal, tagged with which phone sent it, so
`journalctl -u robot-bridge` is a full record of who changed what.

```
[bt] phone connected: A4:50:46:1C:2B:3D
[bt] A4:50:46:1C:2B:3D > SET 192.168.1.5
[bt] A4:50:46:1C:2B:3D < OK broker = tcp://192.168.1.5:1883  (assumed plain TCP) …
```

PINs are masked (`SETPIN ****`) so they never reach the console or the journal.

### URL formats `SET` accepts

| You type | It uses | When |
|---|---|---|
| `https://xxxx.trycloudflare.com/` | `wss://xxxx.trycloudflare.com:443/ws/mqtt` | pasted straight from cloudflared — trailing slash and all |
| `https://xxxx.trycloudflare.com` | same as above | without the slash |
| `xxxx.trycloudflare.com` | same as above | just the hostname |
| `192.168.1.5` | `tcp://192.168.1.5:1883` | same Wi-Fi as the operator PC — **lowest latency, prefer this** |
| `192.168.1.5:1883` | `tcp://192.168.1.5:1883` | explicit port |
| `wss://host:8081/` | as written | a broker that serves MQTT at its root |

A bare hostname with dots is assumed to be a tunnel (`wss` + `/ws/mqtt`,
because that is the path `server.js` proxies to Mosquitto); bare IPs and
`localhost` are assumed to be plain TCP.

**The trailing slash is ignored on a pasted address.** `cloudflared` prints the
URL with one and browsers add it back, so `https://host/` means the same as
`https://host` — both get `/ws/mqtt`. It is only taken literally when you type
`ws://` or `wss://` yourself: `wss://test.mosquitto.org:8081/` really does
connect to the root path. Either way the reply echoes the full URL it will
use, so you can see which happened.

## Joining a Wi-Fi network

The robot gets wheeled into a room whose Wi-Fi it has never seen. It cannot be
told over the network (it isn't on one) and it has no keyboard — so tell it
over Bluetooth:

```
WIFI SCAN
100%  WPA2        Venue-Guest
 79%  WPA2        Staff_FIBO
 64%  open        FIBO_Guest

WIFI Venue-Guest hunter2
… joining Venue-Guest — up to 45 s
OK wifi = Venue-Guest  192.168.8.114
```

NetworkManager saves the connection, so the Pi rejoins that network by itself
at every following boot. Nothing about it is stored by the bridge.

- **An SSID with spaces** needs quotes: `WIFI "Meeting Room 2" hunter2`.
  Everything after the first token is the password otherwise.
- **An open network** takes no password: `WIFI FIBO_Guest`.
- Passwords are masked in the console and the journal (`WIFI Venue-Guest ****`),
  the same way PINs are.
- The IP in the reply is the one to hand to the operator PC — a LAN broker
  (`SET 192.168.8.5`) is much lower latency than going out through the tunnel.

Joining a network also makes the bridge re-dial the broker straight away
instead of waiting for the old connection to time out.

> Enterprise networks (`WPA2 802.1X` — eduroam and friends) need a username,
> a certificate or both, which this command does not carry. Set those up once
> with `nmcli` over SSH; afterwards they reconnect on their own.

## The robot's own screen

The customer standing in front of the robot looks at `<server>/face` — the
same web app the operator drives, joined to room `FACE`. `WEB` opens it full
screen on the Pi's own display:

```
WEB abc-def.trycloudflare.com
OK screen = https://abc-def.trycloudflare.com/face  (assumed https, added /face)
```

`/face` is appended for you — send the same address you gave `SET`. Typing it
yourself is fine too (`WEB https://host/face` does not become `/face/face`).

**It reopens at every boot.** The URL is stored in the config file, and the
bridge opens it as soon as the desktop is up — so a robot that is switched on
with nobody near it comes up showing the face page. There is no second service
to install: the `robot-bridge` unit that was already starting `deep.py` does
this too.

### Booting straight to the face — no keyboard, no mouse

Out of the box the Pi stops at the **login screen** and waits for someone to
press Enter. That screen belongs to the display manager's own user, and its X
cookie is unreadable to the bridge, so the page cannot appear until a real
session exists. `WEB` says so plainly rather than looking broken:

```
STATUS
    web_state: stopped at the login screen — nobody is logged in.
               Run sudo ./deploy/kiosk-autologin.sh so the Pi logs in by itself
```

Run that once:

```bash
sudo ./deploy/kiosk-autologin.sh
sudo reboot
```

It switches off the three separate things that each stop a robot from showing
a face unattended:

| | Default | After |
|---|---|---|
| login prompt | waits for Enter | logs the user in by itself |
| screen blank + lock | after 5 minutes | never |
| idle suspend | after 20 minutes | never (GNOME **and** systemd) |

Screen settings are written as dconf *system* defaults, not `gsettings` —
`gsettings` needs a session to write into, and this has to hold from the very
first boot, before anyone has one. They are locked so the settings UI can't
quietly put the blanking back.

> This is a real change to how the machine logs in: anyone who powers the
> robot on is inside that user's session. That is the point for a kiosk, and
> it is why it is a separate script rather than part of the normal install.
> `sudo ./deploy/kiosk-autologin.sh --undo` reverses all of it.

After this, everything is done from the phone: `WIFI` to get on the network,
`SET` for the broker, `WEB` for the page. The Pi needs power and nothing else.

| You type | It opens | When |
|---|---|---|
| `WEB xxxx.trycloudflare.com` | `https://xxxx.trycloudflare.com/face` | through the tunnel — the usual case |
| `WEB 192.168.1.5` | `https://192.168.1.5:3443/face` | `npm start` on the same Wi-Fi (its HTTPS port) |
| `WEB 192.168.1.5:3000` | `http://192.168.1.5:3000/face` | an explicit port that isn't a TLS one |
| `WEB` | — | reports the page and whether it is up |
| `WEB OFF` | — | closes it, and stops it opening at boot |

The reply always echoes the full URL, so you can see which rule applied.

The bridge keeps the page up: if the browser crashes — or someone closes the
window on the robot — it is reopened within a couple of seconds. `WEB OFF` is
how you actually make it stop.

### Camera and microphone

The face page calls `getUserMedia` the instant it loads, and a permission
prompt on a robot with no keyboard is a dead end. So the browser runs against
a dedicated profile in `~/robot-face-profile` with camera and microphone
pre-granted, autoplay allowed, and first-run screens turned off. That profile
is used for nothing but the face page, which is what makes granting them
up front reasonable — your own browsing is untouched.

Firefox and Chromium are both supported (Chromium first if you have it). On
Ubuntu's Firefox snap the profile directory must stay outside a dotted folder,
which is why it is `~/robot-face-profile` and not `~/.robot-face`.

### Self-signed certificates

`npm start` serves the app over **self-signed** HTTPS, and a kiosk browser has
nobody to click "Advanced → Proceed". Chromium is started with
`--ignore-certificate-errors` and sails through; Firefox does not have an
equivalent and will stop at the warning page. Through the tunnel the
certificate is real and neither cares, so prefer `WEB <tunnel host>` — or
install Chromium if you want the LAN address to work unattended.

### Locking it down

Any phone that pairs can change the broker. If the Pi lives somewhere public,
set a PIN once — after that every new Bluetooth session must send
`PIN <pin>` before `SET` is accepted:

```
SETPIN 4242
```

## Setting it over SSH instead

```bash
cd ~/Webtester-main/Webtester-main
python3 deep.py --show-config
python3 deep.py --set-url xxxx.trycloudflare.com
python3 deep.py --set-serial /dev/ttyUSB0     # or 'auto'
python3 deep.py --set-web xxxx.trycloudflare.com   # the face page on the screen
python3 deep.py --web-off                     # stop opening a page
sudo systemctl restart robot-bridge           # picks up the change
```

Wi-Fi over SSH is plain `nmcli` — the Bluetooth `WIFI` command is a wrapper
around exactly this:

```bash
nmcli device wifi list
nmcli device wifi connect "Venue-Guest" password hunter2
```

When the service is installed, its config lives in
`/etc/robot-bridge/config.json`, so export the same path if you run the CLI as
a different user:

```bash
ROBOT_BRIDGE_CONFIG=/etc/robot-bridge/config.json python3 deep.py --show-config
```

## Where settings come from

Highest wins:

1. `/etc/robot-bridge/config.json` — what Bluetooth and `--set-url` write
2. `MQTT_URL` env var
3. `MQTT_BROKER` + `MQTT_PORT` env vars (legacy, plain TCP)
4. `tcp://localhost:1883`

The config file is first so that a phone can always override a URL baked into
the environment.

The same file holds `web_url` (the face page, `""` = open nothing) and
`web_kiosk` (`false` gives a normal window instead of full screen, which is
handy when you are debugging on the Pi itself). Wi-Fi is *not* in here —
NetworkManager owns that.

Keys added by a later version appear on their own; an older
`/etc/robot-bridge/config.json` written by a previous install keeps working
untouched and the missing keys fall back to their defaults.

## The serial port

`serial_port` defaults to `auto`: the bridge takes the first
`/dev/serial/by-id/*` entry, then `/dev/ttyUSB*`, then `/dev/ttyACM*`. That
covers the normal case (one CP2102/CH340 board) and survives the Arduino
enumerating a couple of seconds after boot — the bridge just keeps retrying
every 3 s until it appears, and reopens the port if the cable is pulled and
plugged back in. Pin it explicitly with `SERIAL /dev/ttyUSB0` if the Pi has
more than one USB serial device.

## Running it by hand

```bash
python3 deep.py                  # bridge + Bluetooth config channel
python3 deep.py --no-bluetooth   # bridge only
```

Stop the service first (`sudo systemctl stop robot-bridge`) — two copies would
fight over the serial port.

## Troubleshooting

| Symptom | Check |
|---|---|
| Robot doesn't move | Send `WATCH` from the phone (or `journalctl -u robot-bridge -f`). No `RX` lines = the web app isn't reaching this broker. `RX` but no `TX` = the Arduino isn't open. `TX` but no `arduino →` = the board isn't answering. |
| `serial_state: unavailable: Permission denied` | user not in `dialout`: `sudo usermod -aG dialout $USER`, then reboot |
| `For4Aug` not visible on the phone | `systemctl status bluetooth`, then `systemctl restart robot-bridge` — it re-asserts discoverability every 60 s |
| Phone connects but nothing happens | you're in a BLE app; SPP needs a *classic* Bluetooth serial terminal |
| `session closed` straight after `phone connected` | the reason is in the brackets. `phone closed the link` = the app hung up (or you're on a "connect to test" screen); `link error: …` = a real fault |
| Bluetooth won't register | run `python3 bt_config.py` by hand — it prints the D-Bus error |
| Frames arrive but the arm is jerky | you're going through the tunnel; switch to `SET <LAN IP>` when both machines share Wi-Fi |
| `WIFI` replies `not authorized` | the polkit rule is missing — re-run `sudo ./deploy/install-pi.sh`, which writes `/etc/polkit-1/rules.d/50-robot-bridge.rules` |
| `WIFI` replies `wrong password` | it is the password — nmcli reports the same thing for a wrong one and for a network that wanted one and got none |
| `WEB` says `stopped at the login screen` | the Pi is waiting for someone to log in — `sudo ./deploy/kiosk-autologin.sh`, then reboot |
| `WEB` says `waiting for the screen` | no X server at all. Normal for the first seconds of a boot; if it stays, the Pi booted to a console — `sudo systemctl set-default graphical.target` |
| The face vanishes after a few minutes | screen blanking or idle suspend — `sudo ./deploy/kiosk-autologin.sh` turns both off |
| `WEB` says `no browser installed` | `sudo apt install -y firefox` (or chromium) |
| `WEB` says `a leftover browser still holds …` | a previous browser survived; `sudo systemctl restart robot-bridge` clears it |
| The page opens *behind* other windows | only happens on a Pi someone is working on — the desktop won't let a background service steal focus. At boot there is nothing else on screen |
| Camera prompt on the face page | the profile in `~/robot-face-profile` was replaced; delete it and it is rebuilt on the next `WEB` |

The bridge is deliberately hard to kill: an unreachable broker, a missing
Arduino and a bad URL are all retried rather than fatal, because at boot the
network, the USB device and the tunnel are all likely to be missing for a
while.
