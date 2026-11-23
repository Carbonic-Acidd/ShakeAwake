# Shake Awake: developer guide

How the code is set up, what every part does, and how to set it up and deploy it from scratch.
For the short, non-technical overview, see [README.md](README.md). The exact message formats and
API routes are in [PLAN.md](PLAN.md).

## How it fits together
```
phone --HTTPS + password--> Vercel (/api) --REST--> EMQX --MQTT/TLS--> Pico --PWM--> amp --> shaker
```

There are three programs:
- **Pico firmware** (`pico/`, MicroPython). Runs on boot, joins Wi-Fi, keeps an MQTT connection
  to the broker, saves alarms to flash, and drives the shaker. It fires alarms on its own, even
  offline.
- **Server** (`api/`, Python + FastAPI). One Vercel function. It checks the password, saves the
  settings in Upstash Redis, reads the calendar, and publishes messages to the Pico through EMQX's
  REST API. It never holds an MQTT connection.
- **Website** (`web/`, plain JS built with Vite). A phone web app that installs to the home
  screen. It talks only to `/api`, never to MQTT, and holds no secrets.

Vercel serves the website and `/api` from one project and deploys every push to `main`. A daily
Vercel cron (08:00 UTC) calls `/api/cron` to turn the calendar into alarms.

### What happens when you...
- **Set a custom alarm:** the page calls `PUT /api/alarm` with a UTC time. The server publishes
  `[time]` as a retained message on `shakeawake/<id>/alarms/manual`. The Pico gets it (now, or
  whenever it next connects), saves it in `state.json`, and fires it when the time comes.
- **Set the alarm type or Settings:** the page calls `PUT /api/settings`. The server saves
  everything in Redis and publishes the Pico's part, `{"pattern", "max_run_s"}`, as retained.
- **Sync (or the daily cron):** the server reads the calendar link, works out the first timed
  event of each of the next 7 days minus the lead time, and publishes the list as retained.
- **Press Try or Stop:** the server publishes a non-retained command on `shakeawake/<id>/cmd`. The
  reply says whether the Pico was listening (`delivered`), which updates the online dot.
- **Open the page:** it logs in with `GET /api/settings`, syncs the calendar, and asks
  `GET /api/status` every 5 s whether the Pico is connected.

Retained messages are the reason an offline Pico catches up: the broker keeps the last alarm
lists and settings and hands them over on every reconnect.

## The code, file by file

### `pico/` (MicroPython on the Pico WH)
- `main.py`: the entry point and main loop (every 10 ms):
  - `on_message(topic, payload)` handles every MQTT message in one place: `cmd` (test or stop),
    `settings`, and `alarms/calendar` / `alarms/manual`. Bad messages are printed and ignored.
  - `step()` updates the shaker, services the network, stops a pattern when its time is up, and
    fires a due alarm once the clock is set.
  - A `finally` block switches PWM off whenever the program stops.
- `shaker.py`: drives the amp on GP15 with PWM:
  - `PATTERNS` defines the four alarm types as a frequency plus looping steps
    `(start strength, end strength, ms)`.
  - `start(name)`, `update()` (every loop) and `stop()`. Strength turns into duty with asin
    (see "Why it's built this way"). An unknown type plays `classic`.
- `alarms.py`: everything the Pico remembers, in one dict saved to `state.json`: both alarm
  lists, the last fired time, the alarm type and how long an alarm plays.
  - `set_list` and `set_settings` validate and save, but only when something changed.
  - `due(now)` returns the latest alarm that is due and not already fired (up to 5 minutes late).
- `net.py`: Wi-Fi, the clock (NTP) and MQTT:
  - `start(on_message)` begins joining Wi-Fi and returns at once.
  - `service(busy)` runs every loop. It keeps the connection alive (pings every 15 s), retries
    every 10 s when offline, and switches the radio off and on if a join hangs.
  - On connect it sets the clock, publishes `online` with a last-will `offline`, and subscribes
    to `shakeawake/<id>/#`.
  - `clock_ok` stays false until NTP has worked once since boot; until then no alarm fires.
- `env.py`: generated from `.env` by `make run` (Wi-Fi, broker login, `DEVICE_ID`). Never
  committed.

### `api/` (the server, one Vercel function)
- `index.py`: the FastAPI app:
  - A middleware checks `Authorization: Bearer <APP_PASSWORD>` on every request.
  - A `RuntimeError` from EMQX, Redis or the calendar becomes a 502 with its message.
  - The `Settings` model holds the settings and their defaults, and `redis()` is one Upstash REST
    call.
  - The routes are listed in PLAN.md.
- `_emqx.py`: EMQX's REST API with the deployment's API key: `publish(topic, payload, retain, qos)`
  and `connected(client_id)`. The leading underscore stops Vercel from making it a function of its own.
- `_calendar_job.py`: `alarms(url, offset_min, now)` fetches the `.ics` file and
  `first_event_alarms` turns it into UTC times. Days count in America/New_York. All-day and
  cancelled events are skipped. Recurring events are expanded.
- `requirements.txt`: FastAPI, icalendar, recurring-ical-events, tzdata.

### `web/` (the phone web app)
- `index.html`: the lock screen (logo plus the password-and-slide control), then one screen:
  - the "device" with its screen (next alarm, live trace, current type, Pico online dot)
  - the knob
  - the custom alarm chip
  - Try and Stop
  - the Settings dialog
  - the custom alarm popup (month calendar, then hour and minute boxes with AM/PM)
- `src/main.js`: all page behavior:
  - slide to unlock
  - drawing the screen (`render()`)
  - turning the knob (drag, arrow keys, or tapping a type name; press the cap to set it)
  - Try, Stop and the custom alarm
  - Sync
  - Settings, whose tiles are built from `STEPPERS`
  - checking whether the Pico is online

  `TYPES` mirrors `PATTERNS` in `shaker.py`. Keep the names and steps in sync.
- `src/api.js`: the only code that calls `/api`. It remembers the password in localStorage and
  turns failures into short messages ("wrong password", "no connection").
- `src/calendar.js`: the custom alarm popup. Pick a day on the month grid, then the time: type
  it, use the small arrows (hold to repeat; minutes move in steps of 5), swipe a box up or down,
  or scroll over it. Set hands the time back to `main.js`, which sends it.
- `src/calendar.css`: the popup's styles, built only from the tokens.
- `src/wave.js`: draws the animated zigzag trace for an alarm type's strength over time.
- `src/tokens.css`: the design tokens (colors, type, spacing, radii, shadows, motion), all from
  the logo.
- `src/style.css`: layout and components, built only from the tokens.
- `public/`: `manifest.webmanifest` (installable app), `sw.js` (service worker that shows the
  last loaded page when offline and never caches `/api`), the logo and icons.
- `package.json`: Vite, the only web dependency.

### Root
- `Makefile`: every command (`make help`).
- `.env.example`: the config keys; copy it to `.env`, which is never committed.
- `requirements.txt`: laptop tools (mpremote, python-dotenv).
- `vercel.json`: builds `web/` into `web/dist`, sends `/api/*` to `api/index.py`, and schedules the cron.
- `scripts/gen_pico_env.py`: writes `pico/env.py` from `.env`, because the Pico can't read `.env`.
- `scripts/upload_secrets.py`: uploads the server keys from `.env` to Vercel, plus `CRON_SECRET`
  (the same value as `APP_PASSWORD`, so the cron passes the password check).
- `PLAN.md`: the MQTT topics, the API routes and the system's behavior in detail.
- `REFACTOR_PLAN.md`: the record of the simplification refactor.
- `CLAUDE.md`: rules for AI coding assistants working in this repo.

### House style
- The least code that fully works.
- One job per file. No classes or frameworks.
- Tunable values as named constants at the top of each file.
- No comments in code. A "why" the code can't show goes in the list below.

## First-time setup
You need Python 3, Node LTS and Make (Windows: `winget install GnuWin32.Make`, or use Git Bash),
plus an EMQX Cloud Serverless deployment and a Vercel account (free Hobby plan, signed in with
GitHub). The Vercel CLI runs through `npx`, so there's nothing to install. Run every command from
the repo root.

```
cp .env.example .env     # then fill it in (see the table below)
make setup               # Python tools + web packages
make pico-setup          # once per Pico, with the Pico plugged in
npx vercel login         # once: lets this laptop run make secrets, make dev, make deploy
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
   environments. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
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
The page is public, but it holds no secrets and can do nothing on its own. Every `/api` call must
carry the shared password, which the server compares with `APP_PASSWORD`; anything else gets a 401
and nothing reaches the Pico. With no `APP_PASSWORD` set, nobody can use `/api`.
1. Put a long passphrase in `APP_PASSWORD` (four or five random words).
2. `make secrets`, then **Redeploy** in Vercel (or `make deploy`).
3. On each phone, type the password and slide to unlock; the device remembers it.

To change it: edit `.env`, run `make secrets`, redeploy, and type the new one on each device.

## Deploying and debugging
- **Website and server:** every push to `main` deploys; other branches get a preview address.
  `make deploy` deploys from the laptop without pushing. After changing a server key in `.env`,
  run `make secrets` and redeploy.
- **Pico:** `make run` after any change in `pico/`, with the Pico plugged in.
- **Logs:** the Vercel project's **Logs** tab for the server; `make logs` for the Pico.
- **Cron:** **Settings > Cron Jobs > Run** runs the calendar sync now; so does the page's Sync button.
- **Locally:** `make dev` runs the site and `/api` with Vercel's dev server (no cron).

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
- Felt strength follows sin(pi x duty), peaking at 50% duty, so `shaker.py` turns strength into
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
