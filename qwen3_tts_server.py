#!/usr/bin/env python3
"""
Qwen3-TTS server — port 8884
Voice cloning via Qwen3-TTS-12Hz-1.7B-CustomVoice

Requires GPU (RTX 4060). Do not start until GPU is installed.
Install: /var/home/kvoldnes/qwen3-tts-env/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128

API: POST /tts  { text, instruction? }  → WAV audio
     GET  /health → { status }
"""

import os
import io
import json
import torch
import soundfile as sf
from http.server import HTTPServer, BaseHTTPRequestHandler

MODEL_ID  = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
VOICE_REF = os.path.expanduser("~/.config/Nyxia/voice_ref.mp3")
PORT      = 8884

# Ref text — what is spoken in voice_ref.mp3 (~30s ElevenLabs sample)
# Update this if voice_ref.mp3 changes
REF_TEXT = ""  # leave empty — model will auto-transcribe if not provided

print(f"[qwen3-tts] Loading {MODEL_ID} ...")
from qwen_tts import Qwen3TTSModel
model = Qwen3TTSModel.from_pretrained(
    MODEL_ID,
    device_map="cuda:0",
    dtype=torch.bfloat16,
)
print("[qwen3-tts] Model loaded. Warming up voice clone ...")

# Warm up — cache the voice reference prompt once at startup
_warmup_done = False
def ensure_warmup():
    global _warmup_done
    if _warmup_done:
        return
    try:
        wavs, sr = model.generate_voice_clone(
            text="Hello.",
            language="English",
            ref_audio=VOICE_REF,
            ref_text=REF_TEXT or None,
        )
        _warmup_done = True
        print("[qwen3-tts] Voice clone ready.")
    except Exception as e:
        print(f"[qwen3-tts] Warmup failed: {e}")

ensure_warmup()


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
            instr  = body.get("instruction", "")  # e.g. "speak with quiet curiosity"

            if not text:
                self._json(400, {"error": "text required"})
                return

            # Prepend instruction if provided (Qwen3-TTS supports inline instruction tags)
            if instr:
                text = f"<|{instr}|>{text}"

            wavs, sr = model.generate_voice_clone(
                text=text,
                language="English",
                ref_audio=VOICE_REF,
                ref_text=REF_TEXT or None,
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
