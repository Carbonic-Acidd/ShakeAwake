import os
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
SERVER_KEYS = ["ICS_URL", "EMQX_API_URL", "EMQX_API_KEY", "EMQX_API_SECRET",
               "ALARM_OFFSET_MIN", "DEVICE_ID", "APP_PASSWORD"]
ENVIRONMENTS = "production,preview"
VERCEL = ["npx.cmd" if os.name == "nt" else "npx", "--yes", "vercel@66.6.0"]

if not ENV_FILE.exists():
    sys.exit("No .env file. Run: cp .env.example .env  (then fill it in)")

env = dotenv_values(ENV_FILE)
values = {key: (env.get(key) or "").strip() for key in SERVER_KEYS}
values["CRON_SECRET"] = values["APP_PASSWORD"]
skipped = [key for key, value in values.items() if not value]
if skipped:
    print("Blank in .env, skipped:", ", ".join(skipped))

for key, value in values.items():
    if not value:
        continue
    result = subprocess.run(VERCEL + ["env", "add", key, "-e", ENVIRONMENTS, "--sensitive", "--force", "--yes"],
                            input=value, text=True, cwd=ROOT)
    if result.returncode:
        sys.exit(f"Couldn't upload {key}")
print("Uploaded. Redeploy for them to take effect.")
