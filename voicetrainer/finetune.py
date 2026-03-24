#!/usr/bin/env python3
"""
Fine-tune XTTS v2 GPT decoder on Nyxia's Chatterbox voice samples.

Requires:
  - voicetrainer/metadata.csv  (run transcribe.py first)
  - GPU with ~8GB VRAM

Output: voicetrainer/xtts_ft/run/training/
  The final checkpoint is at:  .../best_model.pth
  Point xtts_server.py at it to use the fine-tuned voice.

Tuned for RTX 4060 8GB:
  batch_size=2, grad_accum=8 (effective batch=16), epochs=6
"""
import os, sys, math, random, csv

TRAINER_DIR  = os.path.dirname(__file__)
METADATA_CSV = os.path.join(TRAINER_DIR, "metadata.csv")
SAMPLES_DIR  = os.path.expanduser("~/.config/Nyxia/voice_samples")
OUTPUT_DIR   = os.path.join(TRAINER_DIR, "xtts_ft")
EVAL_CSV     = os.path.join(TRAINER_DIR, "metadata_eval.csv")

# ── Sanity check ──────────────────────────────────────────────────────────────

if not os.path.exists(METADATA_CSV):
    print("[!] metadata.csv not found — run transcribe.py first")
    sys.exit(1)

with open(METADATA_CSV, encoding="utf-8") as f:
    rows = list(csv.DictReader(f, delimiter="|"))

if len(rows) < 50:
    print(f"[!] Only {len(rows)} samples — need at least 50. Run transcribe.py.")
    sys.exit(1)

print(f"✦ Loaded {len(rows)} samples from metadata.csv")

# ── Build eval split (5%, max 100 samples) ────────────────────────────────────

random.shuffle(rows)
eval_n    = min(100, max(10, math.ceil(len(rows) * 0.05)))
eval_rows = rows[:eval_n]
train_rows = rows[eval_n:]

# Write full metadata with absolute audio paths (coqui formatter needs them relative to SAMPLES_DIR)
# The gpt_train config_dataset.path = SAMPLES_DIR, and audio_file = filename only
# So we just write filenames as-is (they already are basenames in the CSV)

# Write eval CSV
# Use absolute audio paths so coqui formatter finds files regardless of root_path
def abs_rows(rows):
    return [{"audio_file": os.path.join(SAMPLES_DIR, r["audio_file"]),
             "text": r["text"], "speaker_name": r["speaker_name"]} for r in rows]

with open(EVAL_CSV, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["audio_file", "text", "speaker_name"], delimiter="|")
    writer.writeheader()
    writer.writerows(abs_rows(eval_rows))

TRAIN_CSV = os.path.join(TRAINER_DIR, "metadata_train.csv")
with open(TRAIN_CSV, "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["audio_file", "text", "speaker_name"], delimiter="|")
    writer.writeheader()
    writer.writerows(abs_rows(train_rows))

print(f"  Train: {len(train_rows)} | Eval: {len(eval_rows)}")

# ── Launch fine-tuning ────────────────────────────────────────────────────────

TTS_DEMO_UTILS = "/var/home/kvoldnes/xtts-env/lib/python3.11/site-packages/TTS/demos/xtts_ft_demo/utils"
sys.path.insert(0, TTS_DEMO_UTILS)

from gpt_train import train_gpt

os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"\n✦ Starting XTTS v2 GPT fine-tuning")
print(f"  Output → {OUTPUT_DIR}")
print(f"  Settings: batch_size=2, grad_accum=8, epochs=6\n")

config_path, checkpoint_path, vocab_path, trainer_out, speaker_ref = train_gpt(
    language        = "en",
    num_epochs      = 6,
    batch_size      = 2,
    grad_acumm      = 8,         # effective batch = 16
    train_csv       = TRAIN_CSV,
    eval_csv        = EVAL_CSV,
    output_path     = OUTPUT_DIR,
    max_audio_length= 255995,    # ~11.6s at 22050Hz
)

print("\n✦ Fine-tuning complete!")
print(f"  Checkpoint  : {trainer_out}")
print(f"  Speaker ref : {speaker_ref}")
print(f"  Config      : {config_path}")
print()
print("Next step — update xtts_server.py:")
print(f'  MODEL_PATH = "{trainer_out}/best_model.pth"')
print(f'  CONFIG_PATH = "{config_path}"')
