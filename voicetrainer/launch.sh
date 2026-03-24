#!/usr/bin/env bash
# ✦ Nyxia Voice Trainer — overnight launcher
# Starts Chatterbox on port 8882 (separate from Nyxia's port 8881), then runs the trainer.
# Log saved to: ~/nyxia/voicetrainer/train.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NYXIA_DIR="$(dirname "$SCRIPT_DIR")"
VENV_PYTHON="/var/home/kvoldnes/tts-env/bin/python"
CB_SERVER="$NYXIA_DIR/chatterbox_server.py"
TRAINER="$SCRIPT_DIR/voice_trainer.py"
LOG="$SCRIPT_DIR/train.log"
CB_PORT=8882
CB_URL="http://127.0.0.1:${CB_PORT}/health"

echo "✦ Nyxia Voice Trainer" | tee -a "$LOG"
echo "  $(date)" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# ── 1. Check Chatterbox is not already running on 8882 ─────────────────────
if curl -sf "$CB_URL" > /dev/null 2>&1; then
    echo "  [cb] already running on port $CB_PORT" | tee -a "$LOG"
else
    echo "  [cb] starting Chatterbox on port $CB_PORT..." | tee -a "$LOG"
    CHATTERBOX_PORT=$CB_PORT "$VENV_PYTHON" "$CB_SERVER" >> "$LOG" 2>&1 &
    CB_PID=$!
    echo "  [cb] PID $CB_PID" | tee -a "$LOG"

    # Wait up to 90s for model to load
    echo -n "  [cb] loading model (up to 90s)..." | tee -a "$LOG"
    for i in $(seq 1 90); do
        sleep 1
        if curl -sf "$CB_URL" > /dev/null 2>&1; then
            echo " ready (${i}s)" | tee -a "$LOG"
            break
        fi
        if [ $i -eq 90 ]; then
            echo " TIMEOUT — Chatterbox did not start" | tee -a "$LOG"
            exit 1
        fi
    done
fi

echo "" | tee -a "$LOG"

# ── 2. Run the trainer ──────────────────────────────────────────────────────
echo "  [trainer] starting..." | tee -a "$LOG"
"$VENV_PYTHON" "$TRAINER" 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "✦ Training session complete — $(date)" | tee -a "$LOG"
