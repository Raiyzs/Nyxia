#!/usr/bin/env python3
"""
webcam_presence.py — Passive webcam presence detector for Nyxia
Detects whether someone is in frame using OpenCV Haar cascade.
Prints "PRESENT" or "ABSENT" to stdout on state change.
main.js spawns this process and reads stdout.

No face recognition — only presence/absence detection.

Usage: python3 webcam_presence.py [--camera 0] [--interval 2.0] [--scale 1.3] [--neighbors 5]
"""

import sys
import time
import cv2

def _arg(flag, default):
    try:
        return type(default)(sys.argv[sys.argv.index(flag) + 1])
    except (ValueError, IndexError):
        return default

CAMERA_INDEX = _arg('--camera', 0)
INTERVAL     = _arg('--interval', 2.0)   # seconds between checks
SCALE        = _arg('--scale', 1.3)      # detectMultiScale scaleFactor
NEIGHBORS    = _arg('--neighbors', 5)    # detectMultiScale minNeighbors

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

cap = cv2.VideoCapture(CAMERA_INDEX)
if not cap.isOpened():
    sys.stderr.write('[webcam-presence] cannot open camera\n')
    sys.stderr.flush()
    sys.exit(1)

sys.stderr.write(f'[webcam-presence] watching camera {CAMERA_INDEX}, interval={INTERVAL}s\n')
sys.stderr.flush()

state = None  # None / 'PRESENT' / 'ABSENT'

try:
    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(INTERVAL)
            continue

        gray   = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces  = face_cascade.detectMultiScale(gray, scaleFactor=SCALE, minNeighbors=NEIGHBORS)
        present = len(faces) > 0
        new_state = 'PRESENT' if present else 'ABSENT'

        if new_state != state:
            state = new_state
            sys.stdout.write(state + '\n')
            sys.stdout.flush()

        time.sleep(INTERVAL)
except KeyboardInterrupt:
    pass
finally:
    cap.release()
