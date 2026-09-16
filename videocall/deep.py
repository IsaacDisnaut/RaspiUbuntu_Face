import json
import time
import threading
import paho.mqtt.client as mqtt
import serial

# ── Config ───────────────────────────────────────────────────
# Default = local Mosquitto started by start-local.bat (same broker the web
# app reaches through the /ws/mqtt proxy). Local TCP has near-zero latency —
# the public broker added 100-500 ms of jitter that made motion stutter.
# To use the old public broker set: BROKER="test.mosquitto.org", PORT=8081,
# USE_TLS_WEBSOCKETS=True.
BROKER             = "localhost"
PORT               = 1883
USE_TLS_WEBSOCKETS = False
SERIAL_PORT        = "COM3"   # change to your port, e.g. /dev/ttyUSB0 on Linux
BAUD_RATE          = 115200

EMOTION_TOPIC = "robot/emotion"

# Flow control: after sending a frame, wait for the Arduino's "RUN COMPLETE"
# up to this many seconds before sending the next one. The Arduino finishes
# one motion at a time — pushing frames faster than that only fills its tiny
# (64-byte) serial buffer with stale positions, which is what caused the
# jerky, laggy movement.
LIVE_FRAME_TIMEOUT     = 1.0   # single live joystick/D-pad frames
SEQUENCE_FRAME_TIMEOUT = 30    # frames inside an AI emotion sequence

# ── Serial ───────────────────────────────────────────────────
try:
    ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
    print(f"Serial port {SERIAL_PORT} opened at {BAUD_RATE} baud")
except serial.SerialException as e:
    print(f"Warning: could not open serial port {SERIAL_PORT}: {e}")
    ser = None

# ── Helpers ──────────────────────────────────────────────────
def send_to_serial(obj):
    if not (ser and ser.is_open):
        return
    line = json.dumps(obj, separators=(',', ':'))
    ser.write((line + "\n").encode('utf-8'))
    print(f"{SERIAL_PORT} sent: {line}")


def drain_serial():
    """Read and print any lines the Arduino already sent (non-blocking).
    Keeps a leftover 'RUN COMPLETE' from a previous frame from satisfying
    the wait for the NEXT frame prematurely."""
    if not (ser and ser.is_open):
        return
    while ser.in_waiting > 0:
        line = ser.readline().decode('utf-8', errors='ignore').strip()
        if line:
            print(f"Arduino: {line}")


def wait_for_run_complete(timeout=30, warn=True):
    """Block until Arduino sends 'RUN COMPLETE' or timeout expires."""
    if not (ser and ser.is_open):
        return
    deadline = time.time() + timeout
    while time.time() < deadline:
        if ser.in_waiting > 0:
            line = ser.readline().decode('utf-8', errors='ignore').strip()
            if line:
                print(f"Arduino: {line}")
            if 'RUN COMPLETE' in line:
                return
        time.sleep(0.02)
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


def serial_worker():
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
            drain_serial()
            send_to_serial(frame)
            if is_sequence:
                wait_for_run_complete(SEQUENCE_FRAME_TIMEOUT)
            else:
                # Short wait = pacing only; no warning spam while the operator
                # holds a direction and frames pace at the hardware's speed.
                wait_for_run_complete(LIVE_FRAME_TIMEOUT, warn=False)


# ── MQTT ─────────────────────────────────────────────────────
def on_connect(client, _userdata, _flags, reason_code, _properties=None):
    print(f"MQTT connected (code {reason_code})")
    client.subscribe(EMOTION_TOPIC)
    print(f"Subscribed to {EMOTION_TOPIC}")


def on_message(_client, _userdata, msg):
    payload = msg.payload.decode('utf-8')
    print(f"\n[{msg.topic}] {payload[:120]}")
    print("-" * 30)
    submit_command(payload)


client = mqtt.Client(
    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    transport="websockets" if USE_TLS_WEBSOCKETS else "tcp",
)

client.on_connect = on_connect
client.on_message = on_message

if USE_TLS_WEBSOCKETS:
    client.tls_set()
client.connect(BROKER, PORT, 60)

threading.Thread(target=serial_worker, daemon=True).start()

print(f"Connecting to {BROKER}:{PORT} …")
client.loop_forever()
