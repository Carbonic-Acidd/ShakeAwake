# Shake Awake

Silent bed-shaker alarm. Pico WH (MicroPython) -> TPA3116 amp -> bass shaker.
PWA website (Vite, plain JS) -> /api on Vercel (api/, Python + FastAPI, one function; Vercel
also serves the site and deploys every push to main) -> EMQX Serverless REST publish API ->
broker (TLS only) -> Pico over MQTT.
The website never talks to MQTT and holds no secrets. Every /api request needs the shared
password (APP_PASSWORD, typed into the page once per device, sent as "Authorization: Bearer");
api/index.py checks it. Vercel's cron sends CRON_SECRET, set to the same value, so it passes too.
A daily Vercel cron (08:00 UTC, vercel.json; Hobby allows only once a day) turns the calendar
link (saved in Upstash Redis, else ICS_URL) into calendar alarms.
Team final project for Northeastern's Cornerstone of Engineering.
MQTT topics contract, API and behavior: PLAN.md. See DEV_README.md for how the code works and every file's job.

## Style
- Least code that fully works. Flat, readable, one job per file, no classes or frameworks.
- No comments in code: names carry the meaning. A "why" the code can't show goes in DEV_README's
  "Why it's built this way".
- Tunable values as named constants at the top of each file.
- Ask before adding any file, dependency, or feature.
- Build one step at a time; stop after each so the human tests on hardware.
- Never guess wiring. Ask.

## Commands
- make setup / make pico-setup / make run / make stop / make logs
- make dev / make deploy / make secrets (run from the repo root; Vercel CLI via npx)
- make run uses `mpremote ... run --no-follow pico/main.py + repl`: plain
  `mpremote run` doesn't pass Ctrl-C to the Pico, which leaves the shaker running.

## Config and secrets (the repo is public)
- One root .env (gitignored; template .env.example) holds everything.
- Pico: scripts/gen_pico_env.py writes pico/env.py (gitignored) from .env.
- Server: scripts/upload_secrets.py uploads only the server keys to Vercel (`make secrets`),
  plus CRON_SECRET = APP_PASSWORD. Upstash's KV_REST_API_* come from Vercel's Storage tab.
- Website: no config or secrets at all.

## Hardware facts (don't change without asking)
- Power: 24 V adapter -> amp VCC, and buck converter (5 V) -> Pico.
- GP15: PWM to amp IN+; Pico GND to amp IN-. No amp enable pin.
- Shaker: Dayton BST-2, 4 ohm, 10-80 Hz. Strength peaks at 50% duty
  (strength ~ sin(pi * duty)); shaker.py inverts this with asin.
- The amp/supply protection trips at high output; shaker.MAX_STRENGTH caps it.

## Safety
- Any code that drives PWM turns it off in a `finally` block.
