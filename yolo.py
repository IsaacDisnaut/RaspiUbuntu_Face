import sys
sys.path.insert(0, r"D:\python_packages")

import cv2
import numpy as np
from ultralytics import YOLO

model = YOLO("yolov8n.pt")
NAMES = model.names  # {0: 'person', 1: 'bicycle', ...}

# A distinct color per class (HSV hue spread)
COLORS = {}
for cid in NAMES:
    hue = int(cid * 180 / max(len(NAMES), 1)) % 180
    rgb = cv2.cvtColor(np.uint8([[[hue, 220, 230]]]), cv2.COLOR_HSV2BGR)[0][0]
    COLORS[cid] = (int(rgb[0]), int(rgb[1]), int(rgb[2]))

PANEL_W   = 220   # right-side panel width
FONT      = cv2.FONT_HERSHEY_SIMPLEX

cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
if not cap.isOpened():
    raise RuntimeError("Cannot open webcam")

print("YOLO can detect 80 object types:")
for cid, name in NAMES.items():
    print(f"  {cid:2d}. {name}")
print("\nCamera window open — press Q to quit.\n")

while True:
    ret, frame = cap.read()
    if not ret:
        break

    results = model(frame, verbose=False, conf=0.60)[0]
    h, w = frame.shape[:2]

    # ── draw boxes on camera frame ──
    detected = []   # list of (cls_name, conf, cx, cy)
    for box in results.boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        cx = (x1 + x2) // 2
        cy = (y1 + y2) // 2
        conf  = float(box.conf[0])
        cid   = int(box.cls[0])
        name  = NAMES[cid]
        color = COLORS[cid]

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

        label = f"{name}  {conf*100:.0f}%"
        (tw, th), _ = cv2.getTextSize(label, FONT, 0.55, 1)
        cv2.rectangle(frame, (x1, max(0, y1 - th - 6)), (x1 + tw + 6, y1), color, -1)
        cv2.putText(frame, label, (x1 + 3, y1 - 4), FONT, 0.55, (0, 0, 0), 1)

        # center dot
        cv2.circle(frame, (cx, cy), 4, (255, 255, 255), -1)

        # small xy label near center
        xy_txt = f"({cx},{cy})"
        cv2.putText(frame, xy_txt, (cx + 6, cy + 5), FONT, 0.4, (255, 255, 255), 1)

        detected.append((name, conf, cx, cy))

    # ── right-side panel: "What YOLO sees now" ──
    panel = np.zeros((h, PANEL_W, 3), dtype=np.uint8)
    panel[:] = (30, 30, 30)

    cv2.putText(panel, "YOLO sees:", (8, 22), FONT, 0.6, (200, 200, 200), 1)
    cv2.line(panel, (0, 30), (PANEL_W, 30), (80, 80, 80), 1)

    if detected:
        # deduplicate: show each class once with highest confidence
        best = {}
        for name, conf, cx, cy in detected:
            if name not in best or conf > best[name][0]:
                best[name] = (conf, cx, cy)

        y_pos = 52
        for name, (conf, cx, cy) in sorted(best.items(), key=lambda x: -x[1][0]):
            cid_match = next(k for k, v in NAMES.items() if v == name)
            color = COLORS[cid_match]
            # color swatch
            cv2.rectangle(panel, (8, y_pos - 12), (22, y_pos + 2), color, -1)
            line = f"{name}"
            cv2.putText(panel, line, (28, y_pos), FONT, 0.52, (230, 230, 230), 1)
            conf_txt = f"{conf*100:.0f}%  ({cx},{cy})"
            cv2.putText(panel, conf_txt, (28, y_pos + 15), FONT, 0.38, (160, 160, 160), 1)
            y_pos += 38
            if y_pos > h - 20:
                break
    else:
        cv2.putText(panel, "nothing yet...", (8, 56), FONT, 0.48, (120, 120, 120), 1)
        cv2.putText(panel, "point camera at", (8, 78), FONT, 0.42, (100, 100, 100), 1)
        cv2.putText(panel, "objects to detect", (8, 96), FONT, 0.42, (100, 100, 100), 1)

    # ── stitch camera + panel side by side ──
    combined = np.hstack([frame, panel])
    cv2.imshow("YOLO Detection  |  Q to quit", combined)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
