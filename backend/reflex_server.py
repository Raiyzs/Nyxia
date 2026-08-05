#!/usr/bin/env python3
"""
Nyxia Reflex Layer — Echo State Network (Nengo SNN)
512 LIF neuron reservoir → 11-dim soul state → nyxia-mood.json
Oja rule drifts readout weights over time (personality evolution).
"""

import os, json, time, threading
import numpy as np
import nengo
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reflexion import reflexion_generate

# ── Config ────────────────────────────────────────────────────────────────────
MOOD_KEYS    = ["curiosity","attachment","tiredness","reasoning","memory_load",
                "fear","motor","heartbeat","empathy","language","creativity"]
N_NEURONS    = 512
N_REPR       = 32       # Nengo reservoir representation dimensions
EMB_DIM      = 384      # all-MiniLM-L6-v2
N_OUT        = len(MOOD_KEYS)  # 11
OJA_LR       = 1e-4    # slow readout drift
WEIGHT_DECAY = 0.9999  # prevents runaway drift over weeks
RUN_TIME     = 0.15    # seconds of neural dynamics per request
WINDOW_MS    = 50       # ms of probe window to average over
PORT         = 8788

MOOD_PATH    = os.path.expanduser("~/.config/Nyxia/nyxia-mood.json")
WEIGHTS_PATH = os.path.expanduser("~/.config/Nyxia/reflex_weights.npy")
LOG_PATH     = os.path.expanduser("~/.config/Nyxia/reflex_soul_log.jsonl")

app = FastAPI()
_lock = threading.Lock()
_embedder = None
_reservoir = None

# ── Reservoir ─────────────────────────────────────────────────────────────────
class Reservoir:
    def __init__(self):
        if os.path.exists(WEIGHTS_PATH):
            self.W_out = np.load(WEIGHTS_PATH)  # (N_OUT, N_NEURONS)
        else:
            self.W_out = np.random.randn(N_OUT, N_NEURONS) * 0.01

        self._emb = np.zeros(EMB_DIM)
        rng = np.random.default_rng(42)  # fixed seed = reproducible reservoir

        with nengo.Network() as self.model:
            inp = nengo.Node(lambda t: self._emb, size_out=EMB_DIM)

            res = nengo.Ensemble(
                n_neurons=N_NEURONS,
                dimensions=N_REPR,
                neuron_type=nengo.LIF(tau_rc=0.02, tau_ref=0.002),
            )

            # Fixed random projections — reservoir weights never change
            W_in  = rng.standard_normal((N_REPR, EMB_DIM)) * 0.1
            W_rec = rng.standard_normal((N_REPR, N_NEURONS)) * 0.1 / np.sqrt(N_NEURONS)

            nengo.Connection(inp, res, transform=W_in,  synapse=0.005)
            nengo.Connection(res.neurons, res, transform=W_rec, synapse=0.01)

            self.probe = nengo.Probe(res.neurons, synapse=0.01)

        self.sim = nengo.Simulator(self.model, dt=0.001, progress_bar=False)

    def run(self, embedding: np.ndarray) -> dict:
        self._emb = embedding
        self.sim.run(RUN_TIME)

        window = max(1, int(WINDOW_MS / 1000 / 0.001))
        acts = self.sim.data[self.probe][-window:].mean(axis=0)  # (N_NEURONS,)

        # Linear readout
        raw  = self.W_out @ acts  # (N_OUT,)
        soul = (np.tanh(raw) + 1) / 2  # → [0, 1]

        # Oja update — readout only, reservoir stays fixed
        self.W_out += OJA_LR * (np.outer(soul, acts) - (soul**2)[:, None] * self.W_out)
        self.W_out *= WEIGHT_DECAY

        return dict(zip(MOOD_KEYS, soul.tolist()))

    def save(self):
        np.save(WEIGHTS_PATH, self.W_out)


# ── Startup ───────────────────────────────────────────────────────────────────
@app.on_event("startup")
def startup():
    global _embedder, _reservoir
    from sentence_transformers import SentenceTransformer
    _embedder  = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
    _reservoir = Reservoir()


# ── Endpoints ─────────────────────────────────────────────────────────────────
class ReflexRequest(BaseModel):
    text: str

@app.post("/reflex")
def reflex(req: ReflexRequest):
    with _lock:
        emb   = _embedder.encode(req.text, normalize_embeddings=True)
        soul  = _reservoir.run(emb)

        # Clamp heartbeat — it shouldn't drift
        soul["heartbeat"] = 1.0

        # Smooth-merge into existing mood (don't clobber, nudge)
        try:
            with open(MOOD_PATH) as f:
                mood = json.load(f)
        except Exception:
            mood = {}

        for k, v in soul.items():
            if k == "heartbeat":
                continue
            cur = mood.get(k, 0.5)
            mood[k] = round(cur * 0.75 + v * 0.25, 4)
        mood["heartbeat"] = 1.0

        with open(MOOD_PATH, "w") as f:
            json.dump(mood, f, indent=2)

        # Append to soul log
        entry = {"t": time.time(), "text": req.text[:120], "soul": soul}
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")

        # Persist weights every 50 calls (cheap, non-blocking would need more work)
        _reservoir.save()

        return soul

class ReflectRequest(BaseModel):
    task: str
    context: str

@app.post("/reflect")
async def reflect(req: ReflectRequest):
    result = await reflexion_generate(req.task, req.context)
    return result

@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
