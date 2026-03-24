#!/usr/bin/env python3
"""
Nyxia Backend — Handles system awareness:
  - Active window detection
  - Clipboard monitoring  
  - Time-based events
  - Webcam (future)
  - Screen capture (future)
"""

import sys
import json
import time
import threading
import subprocess
import os

def send_event(event_type, data):
    """Send JSON event to Electron frontend via stdout."""
    msg = json.dumps({"type": event_type, "data": data})
    print(msg, flush=True)

def get_active_window_linux():
    """Get the name of the currently focused window on Linux."""
    try:
        # Try xdotool first
        result = subprocess.run(
            ['xdotool', 'getactivewindow', 'getwindowname'],
            capture_output=True, text=True, timeout=2
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    try:
        # Fallback: xprop
        result = subprocess.run(
            ['xprop', '-root', '_NET_ACTIVE_WINDOW'],
            capture_output=True, text=True, timeout=2
        )
        if result.returncode == 0:
            win_id = result.stdout.split()[-1]
            name_result = subprocess.run(
                ['xprop', '-id', win_id, 'WM_NAME'],
                capture_output=True, text=True, timeout=2
            )
            if name_result.returncode == 0:
                parts = name_result.stdout.split('"')
                if len(parts) >= 2:
                    return parts[1]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return None

def watch_active_window():
    """Monitor active window and emit events on change."""
    last_window = None
    while True:
        try:
            window = get_active_window_linux()
            if window and window != last_window:
                last_window = window
                send_event("active_window", window)
        except Exception:
            pass
        time.sleep(2)

def watch_time():
    """Emit time-based events."""
    last_hour = -1
    while True:
        try:
            import datetime
            now = datetime.datetime.now()
            if now.hour != last_hour:
                last_hour = now.hour
                send_event("hour_change", {
                    "hour": now.hour,
                    "minute": now.minute,
                    "period": "morning" if now.hour < 12 else "afternoon" if now.hour < 17 else "evening" if now.hour < 21 else "night"
                })
        except Exception:
            pass
        time.sleep(30)

def heartbeat():
    """Send periodic heartbeat so frontend knows backend is alive."""
    while True:
        send_event("heartbeat", {"ts": time.time()})
        time.sleep(30)

def main():
    send_event("status", "Nyxia backend started ✦")

    threads = [
        threading.Thread(target=watch_active_window, daemon=True),
        threading.Thread(target=watch_time, daemon=True),
        threading.Thread(target=heartbeat, daemon=True),
    ]

    for t in threads:
        t.start()

    # Keep alive - read commands from Electron if needed
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                handle_command(cmd)
            except json.JSONDecodeError:
                pass
    except (EOFError, KeyboardInterrupt):
        pass

def handle_command(cmd):
    """Handle commands from Electron."""
    cmd_type = cmd.get("type")
    if cmd_type == "ping":
        send_event("pong", {})

if __name__ == "__main__":
    main()
