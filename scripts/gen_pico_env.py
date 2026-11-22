"""Reads the root .env and writes pico/env.py, since MicroPython can't read .env files.

Run by `make run`. Only the Pico keys are copied; the server's keys never reach the Pico.
"""
import sys
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
OUT_FILE = ROOT / "pico" / "env.py"
PICO_KEYS = ["WIFI_SSID", "WIFI_PASSWORD", "PICO_MQTT_USER", "PICO_MQTT_PASS", "MQTT_HOST", "MQTT_PORT",
             "DEVICE_ID"]
INT_KEYS = ["MQTT_PORT"]

if not ENV_FILE.exists():
    sys.exit("No .env file. Run: cp .env.example .env  (then fill it in)")

env = dotenv_values(ENV_FILE)
lines = ["# Auto-generated from .env by scripts/gen_pico_env.py. Don't edit; edit .env instead.\n"]
missing = []
for key in PICO_KEYS:
    value = (env.get(key) or "").strip()
    if not value or "your-id" in value:   # blank, or still the .env.example placeholder
        missing.append(key)
        value = None
    elif key in INT_KEYS:
        value = int(value)
    lines.append(f"{key} = {value!r}\n")

if missing:
    sys.exit("Fill these in .env first: " + ", ".join(missing))
OUT_FILE.write_text("".join(lines), encoding="utf-8")
print("Wrote pico/env.py")
