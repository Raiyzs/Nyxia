"""
Chatterbox TTS server for Nyxia.
- Loads the model once on startup
- POST /tts { "text": "..." } → returns WAV audio
- Auto-saves every generated WAV to SAMPLES_DIR for future fine-tuning
- Run via: /var/home/kvoldnes/tts-env/bin/python chatterbox_server.py
"""
import os, io, sys
from datetime import datetime
from pathlib import Path

import torchaudio
import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

VOICE_REF   = os.path.expanduser("~/.config/Nyxia/voice_ref.mp3")
SAMPLES_DIR = os.path.expanduser("~/.config/Nyxia/voice_samples")
PORT        = int(os.environ.get("CHATTERBOX_PORT", 8881))

app   = FastAPI()
model = None

class TTSRequest(BaseModel):
    text: str

@app.on_event("startup")
async def startup():
    global model
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    from chatterbox.tts import ChatterboxTTS
    print("[chatterbox] loading model...", flush=True)
    model = ChatterboxTTS.from_pretrained(device="cpu")
    print("[chatterbox] ready", flush=True)

@app.post("/tts")
async def tts(req: TTSRequest):
    if not model:
        return Response(status_code=503)

    ref = VOICE_REF if os.path.exists(VOICE_REF) else None
    wav = model.generate(req.text, audio_prompt_path=ref)

    # Save sample for future fine-tuning
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = os.path.join(SAMPLES_DIR, f"nyxia_{ts}.wav")
    torchaudio.save(path, wav, model.sr)

    # Return WAV bytes
    buf = io.BytesIO()
    torchaudio.save(buf, wav, model.sr, format="wav")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
