import sys
sys.path.insert(0, r"D:\python_packages")

from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime
import json
import cv2
import numpy as np
from ultralytics import YOLO

model = YOLO("yolov8n.pt")
NAMES = model.names
CONF_THRESHOLD = 0.60

class DetectHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != '/detect':
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        arr = np.frombuffer(body, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            self.send_response(400)
            self.end_headers()
            return

        results = model(frame, verbose=False, conf=CONF_THRESHOLD)[0]
        detections = []
        for box in results.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            detections.append({
                'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                'conf': round(float(box.conf[0]), 2),
                'label': NAMES[int(box.cls[0])],
            })

        # ── console log (only >= 50% confidence) ──
        ts = datetime.now().strftime('%H:%M:%S')
        visible = [d for d in detections if d['conf'] >= 0.5]
        if visible:
            items = ', '.join(
                f"{d['label']} {int(d['conf']*100)}% ({(d['x1']+d['x2'])//2},{(d['y1']+d['y2'])//2})"
                for d in visible
            )
            print(f"[{ts}] {len(visible)} object(s): {items}")

        resp = json.dumps(detections).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(resp))
        self._cors()
        self.end_headers()
        self.wfile.write(resp)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, fmt, *args):
        pass  # silence request logs

if __name__ == '__main__':
    addr = ('127.0.0.1', 5001)
    print(f'YOLO detection server on http://{addr[0]}:{addr[1]}  (Ctrl-C to stop)')
    HTTPServer(addr, DetectHandler).serve_forever()
