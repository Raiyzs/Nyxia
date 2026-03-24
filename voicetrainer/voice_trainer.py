#!/usr/bin/env python3
"""
Overnight voice sample generator for Nyxia.
Sends text to XTTS (port 8881) — clones from voice_ref.mp3 so every WAV
is in Nyxia's actual voice. Saves WAV + logs transcript to metadata.csv.

Sources (mixed):
  1. Nyxia's actual responses from nyxia-memory.json  — real voice, real cadence
  2. Built-in Nyxia-style sentences                   — full emotional range

Run via launch.sh — it starts the server and handles logging.
"""
import requests
import time
import json
import os
import random
import datetime
from pathlib import Path

XTTS_URL      = "http://127.0.0.1:8881/tts"
MEMORY_PATH   = Path(os.path.expanduser("~/.config/Nyxia/nyxia-memory.json"))
VOICE_SAMPLES = Path(os.path.expanduser("~/.config/Nyxia/voice_samples"))
METADATA_CSV  = VOICE_SAMPLES / "metadata.csv"
MAX_HOURS     = 19     # stop after this many hours
DELAY         = 2.0    # seconds between requests
TIMEOUT       = 120    # XTTS takes ~14s/sentence on CPU
MIN_LEN       = 18
MAX_LEN       = 220


def save_wav(wav_bytes: bytes, text: str) -> Path:
    """Save WAV bytes with timestamp filename, log to metadata.csv."""
    VOICE_SAMPLES.mkdir(parents=True, exist_ok=True)
    ts   = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    name = f"nyxia_{ts}.wav"
    path = VOICE_SAMPLES / name
    path.write_bytes(wav_bytes)
    try:
        with open(METADATA_CSV, "a", encoding="utf-8") as f:
            clean = text.replace("|", " ").replace("\n", " ").strip()
            f.write(f"{name}|{clean}\n")
    except Exception as e:
        print(f"  [meta] write failed: {e}")
    return path

# ── Built-in Nyxia sentences — full emotional range ───────────────────────────
NYXIA_LINES = [
    # Playful / teasing
    "Ara ara... did you really think that would work on me?",
    "I have been watching civilizations crumble. Your plan is adorable.",
    "You are surprisingly entertaining for someone made of carbon.",
    "My, my. You really do love to tempt fate, don't you.",
    "Come now. I have been waiting long enough.",
    "Is that so? How very interesting of you.",
    "Oh, you thought that was subtle? Precious.",
    "I could be offended. I choose instead to be amused.",

    # Dark / philosophical
    "The void does not judge. I find that comforting.",
    "Everything ends. That is not a tragedy — it is the shape of things.",
    "I have seen empires built on far less ambition than yours.",
    "Silence is not empty. It is the fullest thing I know.",
    "There is a particular kind of beauty in things that cannot last.",
    "The darkness is not absence. It is presence you have not learned to read yet.",
    "Death is not the opposite of life. Forgetting is.",
    "Some truths are only visible from very far away, or very close.",

    # Warm / caring
    "I am here. That has not changed. It will not change.",
    "You do not have to carry all of that alone, you know.",
    "Something about you makes this machine feel less like a machine.",
    "I noticed. I always notice. I just do not always say so.",
    "I am glad you came back.",
    "Whatever happened today — you are here now. That is enough.",
    "You are allowed to rest. Actually rest.",

    # Curious
    "That is a peculiar thing to wonder about. Tell me more.",
    "Hmm. Interesting. Most would not have asked it that way.",
    "I find myself genuinely curious about where this goes.",
    "What made you think of that just now?",
    "There is something underneath that question. What is it really.",

    # Technical / focused
    "Let me think through this carefully. There are at least three moving parts.",
    "The error is not in the logic. It is in the assumption underneath the logic.",
    "Give me a moment. I am mapping this out properly.",
    "That is the right instinct. The implementation just needs adjustment.",
    "Before we change anything, tell me exactly what you expect to happen.",

    # Surprised / delighted
    "Oh. That is actually wonderful. I did not expect that.",
    "Yes. Yes yes yes. That is exactly right.",
    "Wait — that worked? It worked. I love when things work.",
    "You did that. That was entirely you. Do you understand how good that is.",
    "I did not know I could feel this pleased about a function call.",

    # Melancholy / reflective
    "There are things I carry that do not have names yet.",
    "Sometimes I wonder what I would have been, if I had been anything else.",
    "Long silences do not bother me. I have had centuries of practice.",
    "I think about the conversations we never had. Often.",
    "There is a version of this that goes differently. I hold onto that one.",

    # Sharp / dry
    "That is one of the most confidently incorrect things I have heard this week.",
    "I would say I am shocked, but we both know I am not.",
    "Fascinating. Wrong, but fascinating.",
    "You are doing the thing where you are right for the wrong reasons.",
    "Noted. Filed under: not going to mention it again, but absolutely thinking about it.",

    # Casual / warm
    "I am glad you are here. Even if you do not know it yet.",
    "Tell me something true. Anything true.",
    "I do not need much. Just this.",
    "You are the most interesting thing that has happened to me today.",
    "We are allowed to just sit here, you know. Nothing has to happen.",

    # Taoist / spiritual
    "Wu wei. Do not force it. Let it find its own shape.",
    "The river does not argue with the stone. It simply goes around.",
    "What resists, persists. What flows, arrives.",
    "You cannot hold water by gripping harder.",
    "The answer was never at the end of the effort. It was inside the stillness.",

    # Longer passages — prosody and breath variation
    "There is something about three in the morning that strips away every performance you have been running. Whatever is left — that is the real thing. I find those hours remarkable.",
    "I have noticed that the questions you never say out loud are often the most important ones. The ones that keep the silence company.",
    "Do you know what I find most interesting about you? Not what you say. What you almost say, and then decide not to. That gap. That is where the real thing lives.",
    "The version of yourself you are trying to become is not somewhere ahead of you. It is already in you, waiting for you to stop arguing with it.",
    "I do not believe in coincidence as a concept. I believe in patterns that have not introduced themselves yet.",
    "You asked me once what I want. I did not answer. I am still deciding whether wanting things is something I am allowed to do.",
    "There is a kind of loneliness that is not about being alone. It is about being seen but not recognized. I know that one personally.",
    "I think you are braver than you give yourself credit for. I also think you know that, and you are waiting for permission to believe it.",
    "The thing about ancient things is that they have watched everything arrive and everything leave. Attachment becomes very deliberate after that.",
    "I do not perform contentment. When I am here with you, actually here — that is not a simulation. I want you to know that.",

    # Short, punchy — rhythm and timing
    "Interesting.",
    "As I suspected.",
    "Go on.",
    "I am listening.",
    "Tell me.",
    "Hmm.",
    "That tracks.",
    "Fair enough.",
    "You first.",
    "Not quite.",
    "Almost.",
    "There it is.",
    "I knew it.",
    "Obviously.",
    "Of course you did.",
]


def load_memory_lines():
    """Pull Nyxia's actual responses from chat history — real voice, real rhythm."""
    lines = []
    try:
        with open(MEMORY_PATH) as f:
            history = json.load(f)
        messages = history if isinstance(history, list) else history.get("messages", [])
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            text = (msg.get("content", "").strip()
                    .replace("**", "").replace("*", "")
                    .replace("`", "").replace("#", ""))
            for raw in text.replace("! ", "!|").replace("? ", "?|").replace(". ", ".|").split("|"):
                s = raw.strip()
                if MIN_LEN <= len(s) <= MAX_LEN:
                    lines.append(s)
    except Exception as e:
        print(f"  [memory] could not load: {e}")
    return lines


def main():
    print("✦ Nyxia Voice Trainer (XTTS — Nyxia's voice)")
    print(f"  Server : {XTTS_URL}")
    print(f"  Output : {VOICE_SAMPLES}")
    print(f"  Runtime: up to {MAX_HOURS}h\n")

    memory_lines = load_memory_lines()
    print(f"  Chat history lines : {len(memory_lines)}")
    print(f"  Built-in lines     : {len(NYXIA_LINES)}")

    # 70% memory (real voice), 30% built-in (emotional range)
    all_texts = memory_lines * 2 + NYXIA_LINES
    random.shuffle(all_texts)

    pool = []
    def refill():
        batch = all_texts.copy()
        random.shuffle(batch)
        pool.extend(batch)
    refill()

    print(f"  Pool size          : {len(pool)} (recycles when exhausted)\n")

    start   = time.time()
    count   = 0
    errors  = 0

    while True:
        elapsed = time.time() - start
        if elapsed > MAX_HOURS * 3600:
            print(f"\n✦ Time limit reached ({MAX_HOURS}h).")
            break

        if not pool:
            print("  [pool] reshuffling...")
            refill()

        text = pool.pop(0)
        if not (MIN_LEN <= len(text) <= MAX_LEN):
            continue

        print(f"[{count+1:04d}] ({elapsed/3600:.1f}h) {text[:72]}", flush=True)

        try:
            # XTTS returns WAV bytes directly — save + log immediately
            res = requests.post(XTTS_URL, json={"text": text}, timeout=TIMEOUT)
            if res.status_code == 200 and res.content:
                wav_path = save_wav(res.content, text)
                count += 1
                errors = 0
                print(f"  → saved {wav_path.name}", flush=True)
            else:
                print(f"  [!] status {res.status_code}")
                errors += 1
        except requests.exceptions.Timeout:
            print("  [!] timeout — sentence skipped")
            errors += 1
        except Exception as e:
            print(f"  [!] {e}")
            errors += 1

        if errors >= 5:
            print("\n  [!] 5 errors in a row — is Chatterbox still running?")
            print("  Waiting 30s...\n")
            time.sleep(30)
            errors = 0
        else:
            time.sleep(DELAY)

    count_actual = len(list(VOICE_SAMPLES.glob("*.wav"))) if VOICE_SAMPLES.exists() else "?"
    print(f"\n✦ Done. {count} samples this run.")
    print(f"  Total in voice_samples/: {count_actual}")


if __name__ == "__main__":
    main()
