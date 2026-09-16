# RaspiUbuntu_Face

Avatar robot tele-presence: a customer stands in front of the robot, an
operator sits at a PC, and the two talk over a WebRTC video call in the
browser while the operator drives the robot's head and arms.

This repository holds the **web application and the robot control bridge**
only. Internal design notes, reviews and the AI experiments are kept out.

## Pieces

| Path | What it does |
| --- | --- |
| `videocall/server.js` | Node/Express + Socket.IO signalling server, serves the web app |
| `videocall/public/`, `public/` | Operator UI, customer face page (`/face`), Three.js URDF robot viewer |
| `deep.py` | MQTT → Arduino serial bridge; coalesces live joystick frames into commands the Arduino can execute |
| `robot_config.py` | Persistent JSON settings (broker URL, serial port, Wi-Fi) shared by the bridge and the config channels |
| `bt_config.py` | Bluetooth (RFCOMM) config channel — set the broker URL from a phone on a headless Pi |
| `wifi_config.py` | Join a new Wi-Fi network over the same Bluetooth channel |
| `web_kiosk.py` | Opens the robot's own screen full-screen on the face page |
| `yolo_server.py`, `yolo.py` | Optional YOLO detection service the web app calls at `/api/detect` |
| `arduino/robot_head/` | Firmware for the head/arm servos |
| `deploy/`, `mosquitto/`, `Dockerfile`, `docker-compose.yml` | Install scripts, MQTT broker config, container setup |

## Operator PC (Windows)

```
start-local.bat
```

It starts the local Mosquitto broker, the Node server on port 3000, the
`deep.py` bridge, optionally the YOLO server, and finally a Cloudflare tunnel
that prints the public HTTPS URL. MQTT rides the same URL at `/ws/mqtt`.

To run the server on its own:

```
cd videocall && npm install && npm start      # http://localhost:3000
```

Node 18+ is required (the server uses native `fetch`).

## Robot Raspberry Pi (Ubuntu)

```
sudo ./deploy/install-pi.sh
```

This installs `deep.py` as a boot service and pulls in what the Bluetooth
channel needs (`python3-dbus`, `python3-gi`, `bluez`).

From a keyboard on the Pi the broker URL is set with:

```
python3 deep.py --set-url wss://<host>/ws/mqtt
```

But the Pi is usually headless, which is what the Bluetooth channel below is
for.

## Bluetooth setup channel

`cloudflared tunnel --url` mints a **new** `xxxx.trycloudflare.com` hostname
every time the operator PC restarts the tunnel, and the robot gets wheeled
between rooms with different Wi-Fi. Both need changing on a Pi that has no
keyboard, no screen, and — when it is on the wrong network — no SSH either.
Bluetooth is the one link that still works with no network at all.

`bt_config.py` exposes a classic **RFCOMM / Serial Port Profile** channel over
BlueZ's D-Bus API. `deep.py` starts it automatically at boot; pass
`--no-bluetooth` to skip it. (It is skipped on Windows, where you have a
keyboard anyway.)

### Pairing

1. On the phone, pair with **`For4Aug`** — the default name, changed with
   `NAME <name>`.
2. Open any "Serial Bluetooth Terminal" app (Android) and connect to it.
3. Send `HELP` to confirm the channel answers.

Classic SPP is used rather than BLE because it works with every stock Android
terminal app and needs no custom GATT client. **iOS has no SPP** — on iPhone
use SSH or `deep.py --set-url` instead.

### Commands

One per line:

| Command | What it does |
| --- | --- |
| `STATUS` | Wi-Fi + broker + serial + screen state |
| `LOG [n]` | last n messages (default 20) |
| `WATCH` / `WATCH OFF` | stream messages live as they happen |
| `GET` | show the broker URL in use |
| `SET <url\|host>` | set broker, e.g. `SET abc.trycloudflare.com`, or `SET tcp://192.168.1.5:1883` |
| `WIFI` | show the current network and IP address |
| `WIFI <ssid> <pass>` | join a network (quote an SSID with spaces) |
| `WIFI SCAN` | list the networks in range |
| `WEB <url>` | show `<url>/face` on the robot's screen, now and at boot |
| `WEB` | show which page the screen is on |
| `WEB OFF` | close it and stop opening it at boot |
| `SERIAL <dev\|auto>` | set the Arduino port, e.g. `SERIAL /dev/ttyUSB0` |
| `NAME <name>` | rename this Bluetooth device (re-pair afterwards) |
| `PIN <pin>` | unlock, if a PIN is configured |
| `SETPIN <pin\|->` | set or clear the PIN (`-` clears it) |
| `RESET` | clear the stored broker URL, back to default |
| `PING` | `PONG` |
| `HELP` | the same list, from the device |

Broker connects and disconnects are pushed to the phone automatically, so
after `SET` you can just watch for `BROKER CONNECTED`.

### Typical session

```
SET abc123.trycloudflare.com     → OK broker = wss://abc123.trycloudflare.com/ws/mqtt
WIFI "Meeting Room" hunter2      → OK wifi = Meeting Room  192.168.1.42
WEB abc123.trycloudflare.com     → OK screen = https://abc123.trycloudflare.com/face
STATUS                           → everything in one reply
```

A bare host is expanded to `wss://<host>/ws/mqtt`; `tcp://host:1883` is taken
as given. Settings are written to `robot_config` (a JSON file), so they all
survive a reboot — Wi-Fi because NetworkManager saves the connection, the page
because the kiosk reopens whatever was last stored.

### Locking it down

There is **no PIN by default**, so any paired phone can change settings. Set
one with `SETPIN 1234`; after that, commands that change something need
`PIN 1234` first in each session. Read-only forms (`STATUS`, `GET`, bare
`WIFI`, bare `WEB`, `WIFI SCAN`) stay readable on a locked session.
