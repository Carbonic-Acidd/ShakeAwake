# Shake Awake plan

Each step is small and ends with a check you can do with a `make` command and your
eyes or ears. Do one step at a time.

## 1. Restructure (done when the shaker works as before)
New layout, one `.env`, and `make run` plays the shaker patterns. No network yet.
Check: `make run` and feel the classic alarm type; Ctrl-C stops it.

## 2. Pico joins Wi-Fi and the broker
`net.py` joins Wi-Fi and connects to EMQX Serverless over TLS (port 8883). It publishes a
retained `shakeawake/status` with a last-will of `{"online": false}`.
`gen_pico_env.py` now **requires** the Pico keys and stops if any are blank.
Check: `make run` prints "connected". In MQTTX Web (mqttx.app/web-client), `shakeawake/status`
shows online, and unplugging the Pico shows offline within about 90 seconds.

## 3. Pico obeys commands
The Pico handles `shakeawake/alarm/test` (play a pattern by name for N seconds) and
`shakeawake/alarm/stop`.
Check: publish them from MQTTX Web and feel the shaker start and stop.

Why this is its own step: it tests the Pico side before the website exists, so a
later bug is clearly in either the Pico or the website, not both.

## 4. Website: status and test buttons
`mqtt.js` connects over wss and shows the Pico as online or offline. The page shows one
"Test" button per pattern (from `status.patterns`), plus a Stop button.
Check: `make dev`, open the page, tap a pattern, and feel it.

## 5. Alarm
The website publishes `shakeawake/alarm/set`. The Pico gets the time from NTP, starts the
chosen pattern at the set time, and auto-stops after a maximum run time. Stop works
from the website.
Check: set an alarm 2 minutes ahead in `make dev` and feel it fire on time.

## 6. PWA polish
Real manifest, icons, and a working service worker, so the site installs on a phone.
Check: in Chrome on the laptop (`make dev`), the install icon appears in the address
bar and the installed app opens in its own window. Phones only run service workers over
HTTPS, so the phone "Add to Home Screen" check happens in Step 7.

## 7. Cloudflare Worker backend (replaced by step 8)
A Cloudflare Worker served the site, published the website's commands through EMQX's REST API,
and synced the calendar nightly, replacing the website's own MQTT. The Pico keeps its alarms in
flash and works offline.

## 8. Vercel (replaced the Cloudflare Worker)
One Vercel project serves the site (`web/dist`) and `/api` (`api/index.py`, Python + FastAPI),
deploys every push to `main`, keeps Settings in Upstash Redis, and runs a daily cron (08:00 UTC)
that syncs the calendar. Setup: README.md.
Check: on the phone, enter the password, "Add to Home Screen" opens Shake Awake full screen
with its icon; then, on mobile data, set an alarm and feel it fire. Settings saved on one device
show on another. Settings > Cron Jobs > Run logs "Calendar sync: N alarms".

Security: the website holds no secrets. Every `/api` request needs the shared password
(`APP_PASSWORD`), which the server checks; the EMQX API key, the calendar link and the
password live only in Vercel environment variables (`make secrets`).

Steps 1-6 describe the original build; the website's MQTT and the old topics they mention
are gone (see the contract below).

## MQTT topics (the contract between the Pico and the server)
The website calls the server's `/api`; the server publishes through EMQX's REST API.
`<id>` is `DEVICE_ID` from `.env`. Times are UTC Unix seconds. Payloads are JSON except status.

| Topic | Direction | Retained / QoS | Payload | Sent by |
|---|---|---|---|---|
| `shakeawake/<id>/status` | Pico -> broker | yes (+ last-will) | `online`, last-will `offline` | the Pico |
| `shakeawake/<id>/cmd` | server -> Pico | no / 0 | `{"cmd": "test", "pattern": "waves", "seconds": 10}` (max 90) or `{"cmd": "stop"}` | `POST /api/test`, `POST /api/stop` |
| `shakeawake/<id>/alarms/manual` | server -> Pico | yes / 1 | `{"v": 1, "gen": 1763290000, "alarms": [[1763290800, "classic"]]}`; `"alarms": []` clears it | `PUT /api/alarm`, `DELETE /api/alarm` |
| `shakeawake/<id>/alarms/calendar` | server -> Pico | yes / 1 | same shape, up to 7 alarms | daily cron (08:00 UTC), `POST /api/sync` |
| `shakeawake/<id>/settings` | server -> Pico | yes / 1 | `{"v": 1, "pattern": "rise", "max_run_s": 90}`: the alarm type every alarm plays (calendar and custom; `null` = each alarm's own) and how long an alarm plays before stopping itself (10-600 s) | `PUT /api/type`, `PUT /api/settings` |

Calendar alarms: for each of the next 7 days (America/New_York), the first timed event's
start minus `ALARM_OFFSET_MIN`. All-day and cancelled events are ignored, days without events
get no alarm, and only future alarms are sent. If the calendar can't be read, nothing is
published, so the Pico keeps the last good list.

The website can't read the Pico's messages (EMQX Serverless's API can't read retained ones), so
it only shows whether each command reached the broker. It does show whether the Pico is online:
`GET /api/status` asks EMQX's Clients API whether client `shakeawake-<id>` (the Pico's MQTT
client id) is connected; the site asks every 5 s. A Pico that lost power or Wi-Fi shows offline
once its keepalive runs out (about 30 s); one stopped on purpose says so at once. Commands also
report whether the Pico was listening (`delivered`), which updates the indicator straight away. Its alarm types must match `pico/shaker.py`.

Alarm types (`pico/shaker.py`): classic (short, short, long), waves (slow swell), rise (silent to
full strength over 20 s, or 10 s in a test, then holds), knock (three quick taps). The type
chosen on the website (the settings topic, saved to `settings.json`) overrides each alarm's own; an
alarm naming an unknown type plays classic, so a renamed type can never silence an alarm.

Alarms on the Pico (`pico/alarms.py`): each list is checked, then saved to its own file in
flash (`calendar.json`, `manual.json`; written to a temp file and renamed, so a power cut
can't corrupt it) and loaded on boot. The Pico fires the latest alarm that is due, merging
both lists, and saves its time in `fired.json` first so a reboot never refires it. Alarms
more than 5 minutes late are skipped. An alarm plays until Stop, or for the time set in the
website's Settings (90 s unless changed).

Settings (the website's faders button opens a small window): the calendar link, how long before
the first event to wake, how long an alarm plays, how long Try plays, and Log out (this device
forgets the password and its copy of everything; the shared copy stays). All are saved on the
device and on the server (`PUT /api/settings`), which keeps them, with the alarm type, in Upstash
Redis (one `settings` key), so the calendar check uses them and every device shows the same after
it unlocks; `ICS_URL` and `ALARM_OFFSET_MIN` are fallbacks. The calendar check runs at a fixed
time (Vercel Hobby crons run once a day, and changing the time needs a deploy), so there's no
setting for it; the page also syncs when opened and after Save.

Clock: the Pico has no clock battery, so it fires nothing until NTP has worked once since
boot. It syncs on every (re)connect and every 6 hours.

Offline: the Pico boots without the internet and never restarts itself. Its loop keeps
running; every 30 s (not while playing) it retries, and if Wi-Fi hasn't come back it switches
the radio off and on first (a plain rejoin can get stuck). Connecting to the broker blocks for
a few seconds, so it's skipped while the shaker plays. Stop from the website can't reach it
while it's offline.
