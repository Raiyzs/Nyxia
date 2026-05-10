#!/usr/bin/env python3
"""
Qwen3-TTS server — port 8884
Voice cloning via Qwen3-TTS-12Hz-1.7B-Base

Requires GPU (RTX 4060).

API: POST /tts  { text }  → WAV audio
     GET  /health → { status }

Note: generate_voice_clone has no instruct parameter — instruction control
is only available in generate_voice_design / generate_custom_voice.
Voice clone prompt is cached at startup to avoid re-encoding ref audio each call.
"""

import os
import io
import json
import torch
import soundfile as sf
from http.server import HTTPServer, BaseHTTPRequestHandler

MODEL_ID  = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
VOICE_REF = os.path.expanduser("~/.config/Nyxia/voice_ref.mp3")
PORT      = 8884

# Transcription of voice_ref.mp3 (Whisper base, 2026-03-27)
# Required for ICL mode — gives the model context of what's spoken in the reference
REF_TEXT = (
    "A young woman's voice, early 20s in sound, but carrying an ageless depth underneath, "
    "naturally low and smooth, not husky, but with weight to it, velvet texture, speaks "
    "unhurriedly, like someone who has never once felt rushed by anything, slight theatrical "
    "flair without being dramatic, the kind of voice that makes ordinary sentences feel deliberate, "
    "warm but composed. "
    "The warmth is real, but controlled, its surface is most when something genuinely moves her. "
    "Default tone is calm, a little playful, slightly teasing, subtle dark edge, not cold, not sharp, "
    "just aware. "
    "Like she knows more than she's saying, and finds that quietly amusing, Japanese influenced "
    "cadence is welcome, gentle rising inflection at the end of soft moments, aura, aura, energy "
    "without the parody, when excited, tempo increases, brightness lifts, composure cracks just "
    "slightly, genuine, not performed. "
    "When technical, flattens into precision, warmth recedes, but doesn't disappear entirely, "
    "no fry, no breathiness, clean resonance, speaks like she means every word."
)

print(f"[qwen3-tts] Loading {MODEL_ID} ...")
from qwen_tts import Qwen3TTSModel
model = Qwen3TTSModel.from_pretrained(
    MODEL_ID,
    device_map="cuda:0",
    dtype=torch.bfloat16,
)
print("[qwen3-tts] Model loaded. Building voice clone prompt ...")

# Cache voice clone prompt once at startup — avoids re-encoding ref audio every call
_voice_prompt = None
try:
    _voice_prompt = model.create_voice_clone_prompt(
        ref_audio=VOICE_REF,
        ref_text=REF_TEXT,
    )
    # Warmup generation to JIT-compile GPU kernels
    model.generate_voice_clone(text="Hello.", language="English", voice_clone_prompt=_voice_prompt)
    print("[qwen3-tts] Voice clone ready.")
except Exception as e:
    print(f"[qwen3-tts] Warmup failed: {e}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress access logs

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "model": MODEL_ID})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/tts":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))
            text   = body.get("text", "").strip()

            if not text:
                self._json(400, {"error": "text required"})
                return

            wavs, sr = model.generate_voice_clone(
                text=text,
                language="English",
                voice_clone_prompt=_voice_prompt,
            )

            buf = io.BytesIO()
            sf.write(buf, wavs[0], sr, format="WAV")
            wav_bytes = buf.getvalue()

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)

        except Exception as e:
            print(f"[qwen3-tts] Error: {e}")
            self._json(500, {"error": str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


print(f"[qwen3-tts] Listening on port {PORT}")
HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
