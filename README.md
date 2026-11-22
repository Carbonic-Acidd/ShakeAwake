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
cp .env.example .env     # then fill it in; each key has a comment saying where it comes from
make setup               # Python tools + web packages
make pico-setup          # once per Pico, with the Pico plugged in
npx vercel login         # once: lets this laptop run `make secrets`, `make dev`, `make deploy`
npx vercel link          # once: ties this folder to the Vercel project
```

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
2. Copy the **REST API** address into `EMQX_API_URL` (ends in `/api/v5`).
3. Under **API Key**, select **+ New API Key**; put the App ID in `EMQX_API_KEY` and the
   App Secret in `EMQX_API_SECRET` (the secret is only shown once).
4. Under **Access Control > Authentication**, add a username and password for the Pico
   (`PICO_MQTT_USER`, `PICO_MQTT_PASS`); `MQTT_HOST` is the deployment's address.

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

## Files
- `Makefile`: every command above.
- `.env.example`: the config keys; copy it to `.env` (never committed) for real values.
- `requirements.txt`: laptop Python tools (mpremote, python-dotenv).
- `PLAN.md`: the roadmap and the MQTT topics contract.
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
- `pico/alarms.py`: the calendar and manual alarm lists and the chosen alarm type, saved in flash; decides when one is due.
- `pico/env.py`: generated from `.env`, never edited or committed.
- `web/package.json`: web dependencies (Vite).
- `web/index.html`: the page: a lock screen, then one screen of controls.
- `web/src/main.js`: the page's behavior: password + slide to unlock, the next alarm, the alarm type knob (turn to choose, press to set), Try, the custom alarm, Sync, Stop, and the Settings panel.
- `web/src/api.js`: the only code that calls the server's `/api`; remembers the password on this device.
- `web/src/wave.js`: draws the live trace on the screen for the alarm type the knob points at.
- `web/src/tokens.css`: the design tokens (colors, type, spacing, radii, depth, motion), all from the logo.
- `web/src/style.css`: layout and components, built only from the tokens.
- `web/public/manifest.webmanifest`: lets the phone install the site as an app.
- `web/public/sw.js`: service worker; opens the last loaded page when offline (never caches `/api`).
- `web/public/*.png`: the logo (page header) and app icons (home screen and install).
