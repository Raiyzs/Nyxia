#!/usr/bin/env python3
"""
wake_word.py — Passive wake-word listener for Nyxia
Listens on the default microphone. Prints "WAKE" to stdout on detection.
main.js spawns this process and reads stdout.

Model: hey_jarvis (closest phonetic match to "Hey Nyxia" in the open catalog)
Custom model training: see docs/PHASES.md Phase 4 (wake word)

Usage: python3 wake_word.py [--threshold 0.5] [--model hey_jarvis]
"""

import sys
import time
import struct
import pyaudio
import numpy as np
from openwakeword.model import Model

CHUNK      = 1280    # ~80ms at 16kHz — required by openwakeword
RATE       = 16000
FORMAT     = pyaudio.paInt16
CHANNELS   = 1
THRESHOLD  = float(sys.argv[sys.argv.index('--threshold') + 1]) if '--threshold' in sys.argv else 0.5
MODEL_NAME = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'hey_jarvis'
COOLDOWN   = 3.0     # seconds between detections — prevents double-fires

model = Model(wakeword_models=[MODEL_NAME])

pa = pyaudio.PyAudio()
stream = pa.open(
    rate=RATE, channels=CHANNELS, format=FORMAT,
    input=True, frames_per_buffer=CHUNK,
)

sys.stderr.write(f"[wake-word] listening for '{MODEL_NAME}' (threshold={THRESHOLD})\n")
sys.stderr.flush()

last_fire = 0.0

try:
    while True:
        raw = stream.read(CHUNK, exception_on_overflow=False)
        samples = np.frombuffer(raw, dtype=np.int16)
        preds = model.predict(samples)
        score = preds.get(MODEL_NAME, 0.0)
        if score >= THRESHOLD:
            now = time.time()
            if now - last_fire >= COOLDOWN:
                last_fire = now
                sys.stdout.write("WAKE\n")
                sys.stdout.flush()
except KeyboardInterrupt:
    pass
finally:
    stream.stop_stream()
    stream.close()
    pa.terminate()
