# Shake Awake

A silent bed-shaker alarm. A Raspberry Pi Pico WH drives a bass shaker through an
amp. A phone web app, hosted on Vercel, sends commands to the server's `/api` (a Python
function on the same Vercel project), which publishes them to an EMQX Serverless broker; the
Pico gets them over MQTT. Each day a Vercel cron also turns the next 7 days of a calendar into alarms.

```
phone --HTTPS + password--> Vercel (/api) --REST--> EMQX --MQTT/TLS--> Pico
```

## Prerequisites
Python 3, Node LTS, and Make. On Windows: `winget install GnuWin32.Make`, or use Git Bash.
Accounts: EMQX Cloud (a Serverless deployment) and Vercel (free Hobby plan, signed in with GitHub).
The Vercel CLI isn't installed: the Makefile runs it through `npx`.
Run every `make` command from the repo root.

## First-time setup
```
cp .env.example .env     # then fill it in (see the table below)
make setup               # Python tools + web packages
make pico-setup          # once per Pico, with the Pico plugged in
npx vercel login         # once: lets this laptop run `make secrets`, `make dev`, `make deploy`
npx vercel link          # once: ties this folder to the Vercel project
```

### The `.env` keys
| Key | Where it comes from |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | the Wi-Fi the Pico joins |
| `PICO_MQTT_USER`, `PICO_MQTT_PASS`, `MQTT_HOST` | EMQX, see below |
| `DEVICE_ID` | any short name; it names the topics `shakeawake/<DEVICE_ID>/...` (Pico and server) |
| `EMQX_API_URL`, `EMQX_API_KEY`, `EMQX_API_SECRET` | EMQX, see below |
| `APP_PASSWORD` | the website's shared password, see below |
| `ICS_URL` | optional fallback calendar link (the Settings panel saves its own). Google Calendar: Settings > your calendar > "Secret address in iCal format"; `webcal://` links work too |
| `ALARM_OFFSET_MIN` | optional fallback: minutes before the day's first event to wake (60) |

The Pico keys go to `pico/env.py` (`make run`); the server keys go to Vercel (`make secrets`).
Upstash's `KV_REST_API_URL` and `KV_REST_API_TOKEN` are added by Vercel itself, not from `.env`.

### Vercel
1. vercel.com > **Add New > Project** > import this GitHub repo. Root Directory `./`,
   Application Preset **Other**; build settings come from `vercel.json`.
2. **Storage** > **Upstash for Redis** (free, US East) > connect to the project for all
   environments. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (the saved settings).
3. `make secrets` (or paste the server keys from `.env` into **Settings > Environment Variables**,
   plus `CRON_SECRET` with the same value as `APP_PASSWORD`), then **Redeploy**.
4. The site's address is under the project's **Settings > Domains**.

### EMQX
1. In the EMQX Cloud console, open the deployment's **Overview**.
2. Copy the **REST API** address into `EMQX_API_URL`, e.g. `https://your-id.ala.us-east-1.emqxsl.com:8443/api/v5`.
3. Under **API Key**, select **+ New API Key**; put the App ID in `EMQX_API_KEY` and the
   App Secret in `EMQX_API_SECRET` (the secret is only shown once).
4. Under **Access Control > Authentication**, add a username and password for the Pico
   (`PICO_MQTT_USER`, `PICO_MQTT_PASS`); `MQTT_HOST` is the deployment's address (TLS, port 8883).

### The website's password
The page is public, but it holds no secrets and can do nothing on its own. Every `/api`
call must carry the shared password, which the server compares with its `APP_PASSWORD`
environment variable; anything else gets a 401 and nothing is sent to the Pico.
1. Put a long passphrase in `APP_PASSWORD` (four or five random words; plain letters,
   numbers and spaces).
2. `make secrets`, then **Redeploy** in Vercel (or `make deploy`).
3. Open the site on each phone, type the password and slide to unlock; that device remembers
   it and unlocks by itself next time.

To change it: edit `.env`, run `make secrets`, redeploy, and type the new one on each device (the
page asks again by itself).
With no `APP_PASSWORD` set, nobody can use `/api`.

### Deploy
Vercel deploys every push to `main` by itself (it's linked to the GitHub repo); other branches
get a preview address. Watch builds in the project's **Deployments** tab.

Still by hand:
```
make secrets   # after changing any server value in .env, then redeploy
make deploy    # deploy from the laptop without pushing (e.g. to try something)
make run       # after changing pico/ (with the Pico plugged in)
```
Logs: the project's **Logs** tab. The calendar sync runs once a day at 08:00 UTC (3 am New York
time in winter, 4 am in summer; Hobby cron fires sometime within that hour). **Settings > Cron
Jobs > Run** runs it now, and so does `POST /api/sync` (the page's Sync button, and opening the page).

## Daily commands
- `make run`: copy the code to the Pico and run it. Ctrl-C stops it, then Ctrl-] exits.
- `make stop`: stop whatever is running on the Pico.
- `make logs`: open the Pico's REPL.
- `make dev`: run the site and `/api` locally with Vercel's dev server (no cron).
- `make deploy`: deploy to production without pushing.
- `make secrets`: upload the server's values from `.env` to Vercel.
- `make help`: list all commands.

## Why it's built this way
- Wi-Fi power saving is off (`WIFI_POWER_SAVE_OFF`): with it on, joining the laptop hotspot failed.
- A Wi-Fi rejoin switches the radio off and on first: after the network vanishes, a plain
  `connect()` can stay stuck "joining" forever.
- Connecting to the broker blocks for a few seconds (TLS), so the Pico skips it while the shaker
  plays. Pings still go out every 15 s, inside the 20 s keepalive.
- The Pico passes an `SSLContext` to umqtt: that makes it send the host name (SNI), which EMQX
  Serverless requires. The broker's certificate isn't checked yet.
- `gc.collect()` runs before each TLS connect: TLS needs one big block of memory.
- PWM keeps running after a script stops, so `main.py` switches it off in a `finally` block.
- Felt strength follows sin(pi × duty), peaking at 50% duty, so `shaker.py` turns strength into
  duty with asin. `MAX_STRENGTH` caps it below where the amp's protection trips.
- `state.json` is written to a temp file and renamed over the old one; on littlefs the rename is
  atomic, so a power cut never leaves half a file.
- An alarm is saved as fired before it plays, so a reboot mid-alarm doesn't play it again.
- A cleared custom alarm is sent as `[]`, never as an empty message: an empty retained message
  deletes it from the broker, and a Pico that was offline would never hear it was cleared.
- The password check uses `hmac.compare_digest`, which takes the same time however much matches.
- `make run` uses `mpremote ... run --no-follow ... + repl`: plain `mpremote run` doesn't pass
  Ctrl-C to the Pico, which would leave the shaker running.
- The cron runs at 08:00 UTC (3 am New York in winter, 4 am in summer): Vercel Hobby allows one
  run a day, and changing the time needs a deploy.

## Files
- `Makefile`: every command above.
- `.env.example`: the config keys; copy it to `.env` (never committed) for real values.
- `requirements.txt`: laptop Python tools (mpremote, python-dotenv).
- `PLAN.md`: the MQTT topics contract, the API and how the system behaves.
- `REFACTOR_PLAN.md`: the simplification refactor, step by step.
- `vercel.json`: Vercel's config: builds `web/` into `web/dist`, sends `/api/*` to `api/index.py`, and the daily cron.
- `scripts/gen_pico_env.py`: turns `.env` into `pico/env.py`, because the Pico can't read `.env`.
- `scripts/upload_secrets.py`: uploads the server's keys from `.env` to Vercel (plus `CRON_SECRET`, the same as `APP_PASSWORD`).
- `api/index.py`: the server: the password check, the `/api` endpoints, the daily cron, and the settings in Upstash Redis.
- `api/_emqx.py`: EMQX's REST API: publishes MQTT messages, and asks whether the Pico is connected.
- `api/_calendar_job.py`: reads the calendar link (from Settings, else `ICS_URL`) and works out the next 7 days' alarms.
- `api/requirements.txt`: the server's Python packages: FastAPI, icalendar, recurring-ical-events, tzdata.
- `pico/main.py`: runs on boot and wires the shaker, alarms and network together.
- `pico/shaker.py`: drives the shaker; the alarm types (classic, waves, rise, knock) are defined at the top (keep `TYPES` in `web/src/main.js` in sync, names and steps).
- `pico/net.py`: Wi-Fi, clock (NTP) and MQTT; never blocks waiting for Wi-Fi.
- `pico/alarms.py`: the calendar and manual alarm lists, the last fired time and the settings, saved in `state.json`; decides when one is due.
- `pico/env.py`: generated from `.env`, never edited or committed.
- `web/package.json`: web dependencies (Vite).
- `web/index.html`: the page: a lock screen, then one screen of controls.
- `web/src/main.js`: the page's behavior: password + slide to unlock, the next alarm, the alarm type knob (turn to choose, press to set), Try, the custom alarm, Sync, Stop, and the Settings panel (its tiles are built from `STEPPERS`).
- `web/src/api.js`: the only code that calls the server's `/api`; remembers the password on this device.
- `web/src/wave.js`: draws the live trace on the screen for the alarm type the knob points at.
- `web/src/tokens.css`: the design tokens (colors, type, spacing, radii, depth, motion), all from the logo.
- `web/src/style.css`: layout and components, built only from the tokens.
- `web/public/manifest.webmanifest`: lets the phone install the site as an app.
- `web/public/sw.js`: service worker; opens the last loaded page when offline (never caches `/api`).
- `web/public/*.png`: the logo (page header) and app icons (home screen and install).
