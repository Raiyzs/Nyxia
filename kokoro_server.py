"""
Kokoro TTS server for Nyxia.
- Loads the model once on startup (~82M params, fast on CPU)
- POST /tts { "text": "...", "voice": "af_heart" } → returns WAV audio
- GET  /voices → list available voices
- GET  /health → status
- Auto-saves every generated WAV to SAMPLES_DIR for fine-tuning data
- Run via: /var/home/kvoldnes/xtts-env/bin/python kokoro_server.py
"""
import os, io
from datetime import datetime
from pathlib import Path

import torch
import soundfile as sf
import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

SAMPLES_DIR = os.path.expanduser("~/.config/Nyxia/voice_samples")
PORT        = int(os.environ.get("KOKORO_PORT", 8883))

# Female voices that suit Nyxia's character (dark, warm, precise)
VOICES = {
    "af_heart":   "Heart — warm, expressive (default)",
    "af_bella":   "Bella — smooth, clear",
    "af_sky":     "Sky — airy, lighter",
    "af_nicole":  "Nicole — calm, measured",
    "af_aoede":   "Aoede — rich, textured",
    "af_sarah":   "Sarah — natural",
    "bf_emma":    "Emma — British, composed",
    "bf_isabella":"Isabella — British, warm",
}
DEFAULT_VOICE = "af_heart"

app      = FastAPI()
pipeline = None

class TTSRequest(BaseModel):
    text:  str
    voice: str = DEFAULT_VOICE

@app.on_event("startup")
async def startup():
    global pipeline
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    from kokoro import KPipeline
    print("[kokoro] loading model...", flush=True)
    pipeline = KPipeline(lang_code='a')
    print("[kokoro] ready", flush=True)

@app.post("/tts")
async def tts(req: TTSRequest):
    if not pipeline:
        return Response(status_code=503)

    voice = req.voice if req.voice in VOICES else DEFAULT_VOICE

    # Generate all chunks and concatenate
    chunks = []
    for _, _, audio in pipeline(req.text, voice=voice):
        chunks.append(audio)

    if not chunks:
        return Response(status_code=500)

    combined = torch.cat(chunks).numpy()

    # Save sample for fine-tuning data
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = os.path.join(SAMPLES_DIR, f"nyxia_kk_{ts}.wav")
    sf.write(path, combined, 24000)

    # Return WAV bytes
    buf = io.BytesIO()
    sf.write(buf, combined, 24000, format='WAV')
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")

@app.get("/voices")
async def voices():
    return {"voices": VOICES, "default": DEFAULT_VOICE}

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": pipeline is not None, "port": PORT}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
