# RaspiUbuntu_Face

Avatar robot tele-presence: a customer stands in front of the robot, an
operator sits at a PC, and the two talk over a WebRTC video call in the
browser while the operator drives the robot's head and arms.

This repository holds the **web application and the robot control bridge**
only. Internal design notes, reviews and the AI experiments are kept out.

## Where to run the server

**Run the server on the Windows operator PC.** That is the recommended setup
and the one [`start-local.bat`](start-local.bat) automates end to end —
Mosquitto, the Node server, the `deep.py` bridge, the optional YOLO detector
and the Cloudflare tunnel, in one double-click. The Windows PC also has the
CPU headroom for YOLO detection, which the Pi does not.

The robot Pi then runs only the bridge (`deep.py`) and its own screen, and
connects out to the operator PC's tunnel URL.

```
Windows operator PC                    Raspberry Pi (robot)
┌────────────────────────┐             ┌──────────────────────┐
│ Node server  :3000     │◀── tunnel ──│ deep.py  (bridge)    │
│ Mosquitto    :1883/9001│    (MQTT    │ web_kiosk → /face    │
│ cloudflared  (public)  │   over WSS) │ Arduino via serial   │
└────────────────────────┘             └──────────────────────┘
        ▲
        └── operator's browser, and the customer's page at /face
```

Because the tunnel hostname changes every time `cloudflared` restarts, the Pi
has to be told the new URL — which is what the [Bluetooth setup
channel](#bluetooth-setup-channel) below is for.

Ubuntu can host the server too (see [Running the server on
Ubuntu](#running-the-server-on-ubuntu)), but Windows is the supported path.

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

## Running the server on Ubuntu

Windows is recommended, but nothing in the server is Windows-specific — it
runs on Ubuntu (including a Raspberry Pi 5 on arm64) if you would rather host
it there.

```
sudo apt install -y nodejs npm mosquitto
sudo systemctl start mosquitto
cd videocall && npm install --omit=dev
NODE_ENV=production PORT=3000 node server.js
```

Then expose it the same way:

```
cloudflared tunnel --url http://localhost:3000
```

On arm64, install cloudflared from the published `.deb`:

```
curl -L -o cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cf.deb
```

There is no Linux equivalent of `start-local.bat`, so the pieces are started
by hand. For a real deployment on a VPS with a domain, use
[`deploy/setup.sh`](deploy/setup.sh) instead — nginx, certbot and PM2.

One upside worth knowing: when the server runs on the *robot's own* Pi, the
broker is at `localhost`, so `deep.py` never has to be told a changing tunnel
hostname. Set it once and it stays correct:

```
python3 deep.py --set-url tcp://localhost:1883
python3 deep.py --set-web http://localhost:3000
```

The trade-off is the missing startup script and less CPU for YOLO.

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

## MQTT broker and TLS certificates

The browser and `deep.py` meet on an MQTT broker. Mosquitto is configured with
three listeners ([`mosquitto/mosquitto.conf`](mosquitto/mosquitto.conf), and
`mosquitto-local.conf` for Windows):

| Port | Protocol | Used by |
| --- | --- | --- |
| 1883 | plain MQTT TCP | `deep.py` and other server-side clients |
| 9001 | plain WebSocket | the Node server's `/ws/mqtt` proxy — **the normal path** |
| 9443 | WebSocket Secure (WSS) | direct browser access on the LAN, no proxy |

All three are `allow_anonymous true`, so there are no broker usernames or
passwords to set up.

### You usually do not need a certificate

Port 9001 carries plain WebSocket, and the Node server proxies it at
`/ws/mqtt` on the same origin as the web app. When you reach the app through
the Cloudflare tunnel, Cloudflare terminates TLS, so the browser gets `wss://`
end to end without Mosquitto holding a certificate at all. This is what
`start-local.bat` sets up and what the web app defaults to.

Certificates matter only for **port 9443** — connecting a browser straight to
Mosquitto over the LAN, bypassing the Node server.

### Generating the certificate

It is generated automatically. The Node server calls `generateMqttCerts()` at
startup ([videocall/server.js:319](videocall/server.js#L319)), which writes a
self-signed 2048-bit RSA cert valid for 10 years to `mosquitto/certs/` and
**skips if the files already exist**:

```
mosquitto/certs/cert.pem
mosquitto/certs/key.pem
```

To generate them without starting the server, on Windows:

```
.\mosquitto\generate-certs.ps1
```

That script is pure PowerShell — it does not need openssl. With openssl
available, the equivalent is:

```
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=localhost" \
  -keyout mosquitto/certs/key.pem -out mosquitto/certs/cert.pem
```

`mosquitto/certs/` is gitignored — keys are never committed.

### Two things that catch people out

1. **`mosquitto-local.conf` has hard-coded paths.** It ships pointing at
   `D:\CODING\For4Aug\mosquitto\certs\`. Edit `certfile` and `keyfile` to
   your own checkout, or Mosquitto will fail to start the 9443 listener.
2. **Browsers reject self-signed certificates.** Visit
   `https://localhost:9443` once and click *Advanced → Proceed* before the
   web app can open a WSS connection to it.

### The Node server's own certificate is separate

In development the server also self-signs an HTTPS cert into `videocall/.ssl/`
for `https://localhost:3443`. Different file, same idea, also gitignored. With
`NODE_ENV=production` the server serves plain HTTP on :3000 and expects
Cloudflare, nginx or Railway to provide TLS — which is what `start-local.bat`
does.

## AI API keys (optional)

Video calling and robot control need no keys at all. Without them the server
prints `No API key …` and starts normally; only the speech-to-text and AI chat
features return `503`. Set them up only if you want those.

### The `apikey` file

Create a file called `apikey` in the **project root** — not inside
`videocall/`, since the server reads `../apikey` relative to itself
([videocall/server.js:50](videocall/server.js#L50)). One provider per line:

```
Groq: gsk_xxxxxxxxxxxxxxxxxxxx
Openrouter: sk-or-v1-xxxxxxxxxxxxxxxx
Gemini: AIzaxxxxxxxxxxxxxxxxxxxx
```

The name before the colon is the source of truth and is case-insensitive.
The file is gitignored.

| Provider | Default model | Endpoint |
| --- | --- | --- |
| `groq` | `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` |
| `openrouter` | `qwen/qwen-2.5-72b-instruct` | `https://openrouter.ai/api/v1` |
| `gemini` | `gemini-2.0-flash` | Google Generative Language API |

To offer a specific set of models in the UI, follow a provider line with a
JSON array:

```
Groq: gsk_xxxxxxxxxxxxxxxxxxxx
[
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant"
]
```

### Speech-to-text is Groq-only

`/api/stt` posts to Groq's `whisper-large-v3-turbo` and ignores the other
providers, so transcription needs a **Groq** key specifically even if another
provider is set for chat.

### Environment variables instead

For a cloud deploy (Railway and similar), skip the file and set:

```
GROQ_API_KEY=…
OPENROUTER_API_KEY=…
GEMINI_API_KEY=…
```

The file wins where both are present. A single legacy `API_KEY` also works —
the provider is sniffed from the prefix (`gsk_` → Groq, `sk-or-` → OpenRouter,
`AIza`/`AQ.` → Gemini).

### Or just type it into the UI

If the server has no key, the web app's **Settings** panel shows an API-key
field and the key is kept in that browser. When the server does have one, the
field is hidden and the server's key is used — so an operator never handles
the key.
