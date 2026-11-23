import sys
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
OUT_FILE = ROOT / "pico" / "env.py"
PICO_KEYS = ["WIFI_SSID", "WIFI_PASSWORD", "PICO_MQTT_USER", "PICO_MQTT_PASS", "MQTT_HOST", "DEVICE_ID"]
PLACEHOLDER = "your-id"

if not ENV_FILE.exists():
    sys.exit("No .env file. Run: cp .env.example .env  (then fill it in)")

env = dotenv_values(ENV_FILE)
values = {key: (env.get(key) or "").strip() for key in PICO_KEYS}
missing = [key for key, value in values.items() if not value or PLACEHOLDER in value]
if missing:
    sys.exit("Fill these in .env first: " + ", ".join(missing))
OUT_FILE.write_text("".join(f"{key} = {value!r}\n" for key, value in values.items()), encoding="utf-8")
print("Wrote pico/env.py")
