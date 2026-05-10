#!/usr/bin/env python3
"""
Nyxia Vitals Monitor — The Limbic System:
  - Monitors system "breath" (CPU, RAM, Network)
  - Feeds into Nyxia's interoception
  - Lightweight, no UI, no X11/Wayland dependencies
"""

import sys
import json
import time
import threading
import os

# Try to use psutil if available, otherwise fallback to basic /proc reading
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

def send_event(event_type, data):
    """Send JSON event to Electron frontend via stdout."""
    msg = json.dumps({"type": event_type, "data": data})
    print(msg, flush=True)

def get_vitals():
    """Gather system vitals."""
    if HAS_PSUTIL:
        cpu = psutil.cpu_percent(interval=None)
        ram = psutil.virtual_memory().percent
        # Simple net diff
        net = psutil.net_io_counters()
        return {
            "cpu": cpu,
            "ram": ram,
            "net_total": net.bytes_sent + net.bytes_recv
        }
    else:
        # Basic fallback for immutable systems without psutil
        try:
            with open('/proc/loadavg', 'r') as f:
                load = float(f.read().split()[0])
                cpu = min(100.0, (load / os.cpu_count()) * 100.0)
            with open('/proc/meminfo', 'r') as f:
                lines = f.readlines()
                total = int(lines[0].split()[1])
                free = int(lines[1].split()[1])
                ram = ((total - free) / total) * 100.0
            return {"cpu": round(cpu, 1), "ram": round(ram, 1), "net_total": 0}
        except Exception:
            return {"cpu": 0, "ram": 0, "net_total": 0}

def watch_vitals():
    """Monitor vitals and emit events."""
    last_net = 0
    while True:
        try:
            v = get_vitals()
            # Calculate simple network "pulse"
            net_delta = 0
            if last_net > 0:
                net_delta = v["net_total"] - last_net
            last_net = v["net_total"]
            
            send_event("vitals", {
                "cpu": v["cpu"],
                "ram": v["ram"],
                "net_kb_s": round(net_delta / 1024 / 2, 2) # 2s interval
            })
        except Exception:
            pass
        time.sleep(2)

def main():
    send_event("status", "Nyxia Limbic System active ✦")

    vital_thread = threading.Thread(target=watch_vitals, daemon=True)
    vital_thread.start()

    # Keep alive - listen for commands from Electron
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                if cmd.get("type") == "ping":
                    send_event("pong", {})
            except json.JSONDecodeError:
                pass
    except (EOFError, KeyboardInterrupt):
        pass

if __name__ == "__main__":
    main()
