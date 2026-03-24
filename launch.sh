#!/bin/bash
# Nyxia — Launch script for Bazzite/Linux
cd "$(dirname "$0")"

# Source bashrc for any env vars (API keys etc — fallback if not saved in-app)
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

# Use nvm if available (in case electron is installed via nvm node)
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"

# Start Ollama if not already running
OLLAMA_BIN="/usr/local/bin/ollama"
LOG="/tmp/nyxia-launch.log"
echo "[launch] $(date)" >> "$LOG"
if /usr/bin/curl -s http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "[launch] Ollama already running" | tee -a "$LOG"
else
  echo "[launch] Starting Ollama..." | tee -a "$LOG"
  HOME=/var/home/kvoldnes OLLAMA_HOST=127.0.0.1:11434 "$OLLAMA_BIN" serve >>"$LOG" 2>&1 &
  OLLAMA_PID=$!
  echo "[launch] Ollama PID: $OLLAMA_PID" >> "$LOG"
  # Wait up to 10s for it to respond
  for i in $(seq 1 10); do
    sleep 1
    if /usr/bin/curl -s http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
      echo "[launch] Ollama up after ${i}s" | tee -a "$LOG"
      break
    fi
  done
fi

npm start
