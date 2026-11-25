# Shake Awake: how it works

The build is done. The refactor that followed is in REFACTOR_PLAN.md.

## MQTT topics (the contract between the Pico and the server)
The website calls the server's `/api`; the server publishes through EMQX's REST API.
`<id>` is `DEVICE_ID` from `.env`. Times are UTC Unix seconds. Payloads are JSON except status.

| Topic | Direction | Retained / QoS | Payload | Sent by |
|---|---|---|---|---|
| `shakeawake/<id>/status` | Pico -> broker | yes (+ last-will) | `online`, last-will `offline` | the Pico |
| `shakeawake/<id>/cmd` | server -> Pico | no / 0 | `{"cmd": "test", "pattern": "waves", "seconds": 10}` (max 90) or `{"cmd": "stop"}` | `POST /api/test`, `POST /api/stop` |
| `shakeawake/<id>/alarms/manual` | server -> Pico | yes / 1 | `[1763290800]`; `[]` clears it | `PUT /api/alarm`, `DELETE /api/alarm` |
| `shakeawake/<id>/alarms/calendar` | server -> Pico | yes / 1 | `[1763290800, 1763377200]`, up to 7 | daily cron (08:00 UTC), `POST /api/sync` |
| `shakeawake/<id>/settings` | server -> Pico | yes / 1 | `{"pattern": "rise", "max_run_s": 90}`: the type every alarm plays and how long it plays before stopping itself (10-600 s) | `PUT /api/settings` |

The Pico subscribes once to `shakeawake/<id>/#` and ignores its own status messages.

## API
Every request needs `Authorization: Bearer <APP_PASSWORD>`; anything else gets a 401.

| Route | Does |
|---|---|
| `GET /api/settings` | the saved settings (`ics_url`, `offset_min`, `max_run_s`, `try_s`, `pattern`) plus `manual`, the custom alarm (0 if none); the page also uses it to log in |
| `PUT /api/settings` | saves them in Upstash Redis and sends the Pico its part |
| `GET /api/status` | `{"online": bool}`: whether EMQX has client `shakeawake-<id>` connected |
| `POST /api/test`, `POST /api/stop` | play a type for a few seconds, or stop |
| `PUT /api/alarm`, `DELETE /api/alarm` | set or clear the one custom alarm (kept in Redis key `manual`) |
| `POST /api/sync`, `GET /api/cron` | read the calendar and send its alarms (the cron runs daily at 08:00 UTC) |

Commands reply `{"delivered": bool}`: whether the Pico was listening.

## Behavior
Calendar alarms: for today and the next 3 days (America/New_York), the first timed event that
starts before 1 PM, minus the lead time. All-day, cancelled and afternoon events are ignored, days
without a morning event get no alarm, and only future alarms are sent. If none are left, one alarm
at the next 10 AM is sent instead. If the calendar can't be read, nothing is published, so the Pico
keeps the last good list.

Alarm types (`pico/shaker.py`, mirrored by `TYPES` in `web/src/main.js`): classic (short, short,
long), waves (slow swell), rise (silent to full over 20 s, or 10 s in a test, then holds), knock
(three quick taps). An unknown type plays classic, so a renamed type can never silence an alarm.

Alarms on the Pico (`pico/alarms.py`): both lists, the last fired time and the settings live in
`state.json` in flash. The Pico fires the latest alarm that is due across both lists, saving its
time first so a reboot never refires it. Alarms more than 5 minutes late are skipped. An alarm
plays until Stop, or for the settings' `max_run_s`.

Settings: the website's faders button opens them. They hold the calendar link, the lead time, how
long an alarm plays and how long Try plays, plus Log out. The alarm type is set with the knob. All
of it is kept in Upstash Redis (one `settings` key), so every device shows the same after it
unlocks. `ICS_URL` and `ALARM_OFFSET_MIN` are fallbacks. The custom alarm is kept in Redis too
(`manual` key), so every device shows it; an open page re-reads it every 30 s while on screen, and when it comes
back into view or gets focus.

Clock: the Pico has no clock battery, so it fires nothing until NTP has worked once since boot.
It syncs on every (re)connect and every 6 hours.

Offline: the Pico boots without the internet and never restarts itself. While offline it retries
every 10 s (not while playing). If Wi-Fi hasn't come back after 30 s it switches the radio off and
on first. It pings the broker every 15 s, so a lost Pico shows offline on the website within about
30 s (1.5 × the 20 s keepalive). Stop from the website can't reach it while it's offline.
