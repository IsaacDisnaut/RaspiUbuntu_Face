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

This installs `deep.py` as a boot service. Because `cloudflared tunnel --url`
mints a new hostname every time the operator PC restarts the tunnel, and the
Pi is headless, the broker URL is set from a phone over Bluetooth — pair once,
then send one line from any "Serial Bluetooth Terminal" app. The same channel
takes `WIFI <ssid> <password>` when the robot moves to a new network.

From a keyboard on the Pi the same setting is:

```
python3 deep.py --set-url wss://<host>/ws/mqtt
```
