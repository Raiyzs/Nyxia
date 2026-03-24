"""
XTTS v2 TTS server for Nyxia.
- Loads model once on startup (~1.87GB, downloaded to ~/.local/share/tts/ on first run)
- POST /tts { "text": "..." } → returns WAV audio
- ~5-15s per sentence on CPU (vs 25-120s for Chatterbox)
- Run via: /var/home/kvoldnes/xtts-env/bin/python xtts_server.py
"""
import os, io
from pathlib import Path

import torch
import torchaudio
import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

VOICE_REF        = os.path.expanduser("~/.config/Nyxia/voice_ref.mp3")
PORT             = 8881
BASE_MODEL_DIR   = os.path.expanduser("~/.local/share/tts/tts_models--multilingual--multi-dataset--xtts_v2")
FINETUNED_CKPT   = os.path.expanduser("~/.config/Nyxia/xtts-finetuned/run/training/nyxia-voice-March-22-2026_07+41PM-38f6252/best_model_390.pth")

app             = FastAPI()
model           = None
using_finetuned = False

class TTSRequest(BaseModel):
    text: str

@app.on_event("startup")
async def startup():
    global model, using_finetuned
    os.environ.setdefault("COQUI_TOS_AGREED", "1")
    if os.path.exists(FINETUNED_CKPT):
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
        print("[xtts] loading finetuned model...", flush=True)
        config = XttsConfig()
        config.load_json(os.path.join(BASE_MODEL_DIR, "config.json"))
        model = Xtts.init_from_config(config)
        model.load_checkpoint(config,
            checkpoint_path=FINETUNED_CKPT,
            vocab_path=os.path.join(BASE_MODEL_DIR, "vocab.json"),
            speaker_file_path=os.path.join(BASE_MODEL_DIR, "speakers_xtts.pth"),
            eval=True)
        model.to("cpu")
        using_finetuned = True
        print("[xtts] finetuned model ready", flush=True)
    else:
        from TTS.api import TTS
        print("[xtts] loading base model...", flush=True)
        model = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        model.to("cpu")
        print("[xtts] ready", flush=True)

@app.post("/tts")
async def tts(req: TTSRequest):
    if not model:
        return Response(status_code=503)
    if not os.path.exists(VOICE_REF):
        return Response(status_code=503, content=b"No voice reference found")

    if using_finetuned:
        gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(audio_path=[VOICE_REF])
        out = model.inference(req.text, "en", gpt_cond_latent, speaker_embedding)
        wav = out["wav"]
    else:
        wav = model.tts(text=req.text, speaker_wav=VOICE_REF, language="en")

    wav_tensor = torch.tensor(wav, dtype=torch.float32).unsqueeze(0)
    buf = io.BytesIO()
    torchaudio.save(buf, wav_tensor, 24000, format="wav")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model is not None}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
