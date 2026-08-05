#!/usr/bin/env python3
"""
webcam_haptics.py — Webcam hand tracking + presence for Nyxia (MediaPipe 0.10+)
Single camera owner. Replaces webcam_presence.py.

Outputs JSON lines to stdout:
  {"type":"presence","state":"PRESENT"}
  {"type":"presence","state":"ABSENT"}
  {"type":"hand","x":0.42,"y":0.67,"pinch":false}

x,y are 0-1 normalized (x flipped for mirror). Pinch = thumb+index < 0.06.

Usage: python3 webcam_haptics.py [--camera 0] [--fps 20]
"""

import sys, time, json, math, os
import cv2
import mediapipe as mp

def _arg(flag, default):
    try:
        return type(default)(sys.argv[sys.argv.index(flag) + 1])
    except (ValueError, IndexError):
        return default

CAMERA   = _arg('--camera', 0)
FPS      = _arg('--fps', 20)
FRAME_MS = 1.0 / FPS

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hand_landmarker.task')

if not os.path.exists(MODEL_PATH):
    sys.stderr.write(f'[webcam-haptics] model not found at {MODEL_PATH}\n')
    sys.stderr.flush()
    sys.exit(1)

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

cap = cv2.VideoCapture(CAMERA)
if not cap.isOpened():
    sys.stderr.write('[webcam-haptics] cannot open camera\n')
    sys.stderr.flush()
    sys.exit(1)

cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

sys.stderr.write(f'[webcam-haptics] camera {CAMERA} open, {FPS}fps, model={MODEL_PATH}\n')
sys.stderr.flush()

def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()

def dist2d(a, b):
    return math.hypot(a.x - b.x, a.y - b.y)

BaseOptions            = mp.tasks.BaseOptions
HandLandmarker         = mp.tasks.vision.HandLandmarker
HandLandmarkerOptions  = mp.tasks.vision.HandLandmarkerOptions
VisionRunningMode      = mp.tasks.vision.RunningMode

options = HandLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=MODEL_PATH),
    running_mode=VisionRunningMode.VIDEO,
    num_hands=1,
    min_hand_detection_confidence=0.5,
    min_hand_presence_confidence=0.5,
    min_tracking_confidence=0.5
)

presence_state = None
last_frame_t   = 0

with HandLandmarker.create_from_options(options) as landmarker:
    try:
        while True:
            now = time.time()
            if now - last_frame_t < FRAME_MS:
                time.sleep(0.005)
                continue
            last_frame_t = now

            ret, frame = cap.read()
            if not ret:
                time.sleep(0.1)
                continue

            rgb      = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            ts_ms    = int(now * 1000)
            result   = landmarker.detect_for_video(mp_image, ts_ms)

            hand_present = False
            if result.hand_landmarks:
                lm    = result.hand_landmarks[0]
                tip   = lm[8]   # index finger tip
                thumb = lm[4]   # thumb tip

                x     = 1.0 - tip.x   # flip for mirror
                y     = tip.y
                pinch = dist2d(thumb, lm[8]) < 0.06

                emit({"type": "hand", "x": round(x, 3), "y": round(y, 3), "pinch": pinch})
                hand_present = True

            # Presence: hand → PRESENT, else fall back to face detection
            if not hand_present:
                gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = face_cascade.detectMultiScale(gray, scaleFactor=1.3, minNeighbors=5)
                new_state = 'PRESENT' if len(faces) > 0 else 'ABSENT'
            else:
                new_state = 'PRESENT'

            if new_state != presence_state:
                presence_state = new_state
                emit({"type": "presence", "state": new_state})

    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
