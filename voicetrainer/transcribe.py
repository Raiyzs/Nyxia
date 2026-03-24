#!/usr/bin/env /usr/bin/python3
"""
Transcribe Nyxia's Chatterbox voice samples with Whisper → build metadata CSV.

Filters out:
  - Kokoro WAVs (nyxia_kk_* prefix)
  - Clips shorter than 2s or longer than 11s (XTTS training limits)
  - Any file Whisper gives an empty transcript for

Output: voicetrainer/metadata.csv  (coqui format: audio_file|text|speaker_name)
"""
import os, glob, csv, soundfile as sf, whisper

SAMPLES_DIR = os.path.expanduser("~/.config/Nyxia/voice_samples")
OUT_CSV     = os.path.join(os.path.dirname(__file__), "metadata.csv")
SPEAKER     = "nyxia"
MIN_DUR     = 2.0
MAX_DUR     = 11.0
MODEL_SIZE  = "small.en"   # fast + accurate for English-only

print(f"✦ Loading Whisper {MODEL_SIZE} on GPU...")
model = whisper.load_model(MODEL_SIZE, device="cuda")
print("  ready\n")

# Only Chatterbox WAVs (no kk_ prefix)
wavs = sorted(glob.glob(os.path.join(SAMPLES_DIR, "nyxia_2*.wav")))
print(f"  Found {len(wavs)} Chatterbox WAVs")

rows   = []
skip   = 0

for i, path in enumerate(wavs, 1):
    info = sf.info(path)
    dur  = info.duration
    if dur < MIN_DUR or dur > MAX_DUR:
        skip += 1
        continue

    result = model.transcribe(path, language="en", fp16=True)
    text   = result["text"].strip().strip('"').strip("'")

    if not text or len(text) < 5:
        skip += 1
        continue

    rows.append({"audio_file": os.path.basename(path), "text": text, "speaker_name": SPEAKER})

    if i % 50 == 0:
        print(f"  [{i}/{len(wavs)}] done — {len(rows)} kept, {skip} skipped")

print(f"\n✦ Transcription complete: {len(rows)} samples kept, {skip} skipped")

with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["audio_file", "text", "speaker_name"], delimiter="|")
    writer.writeheader()
    writer.writerows(rows)

print(f"  Saved → {OUT_CSV}")
