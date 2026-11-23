# Shake Awake refactor plan

Status: in progress. Done steps are marked ✅.

## Goal
The smallest, most readable repo that still does everything it does today, readable top to
bottom with zero comments. Your decisions so far:
- Zero comments.
- Keep Vite.
- Drop `"v"` and `"gen"` from MQTT messages.
- Cut PLAN.md down to the MQTT contract.
- The Pico checks in every 15 s instead of 8 s.

The code is the truth where your brief differs from it:
- The backend is on Vercel, not Cloudflare.
- The calendar job runs at 08:00 UTC, not ~4 am.
- Only the two laptop scripts use python-dotenv.

## What can be simplified

### Dead code
- `.claude/settings.json`: every entry is stale.
- `net.online()`: nothing calls it.
- `UNIX_OFFSET` and the epoch print: the rp2 clock already counts from 1970.
- The `type.json` and `shakeawake-mqtt-password` migrations: leftovers from older code.
- 3 unused CSS tokens.
- `"ok": True` in every reply: nothing reads it.
- `missing_config`: nothing reads it.
- `"gen"`: the Pico ignores it.
- `DEFAULT_TEST_S`: the server always sends `seconds`.

### Things done twice
| What | Where | Simpler |
|---|---|---|
| Every alarm carries its own type, but the Settings type overrides it on the Pico anyway | Pico, server, calendar, web | An alarm is just a time. The type lives only in settings. |
| Two endpoints change the Pico's settings | `/api/type`, `/api/settings` | One: `PUT /api/settings` |
| Login calls `/api/health`, then right away fetches `/api/settings` | web, server | Login *is* `GET /api/settings`. One request, no health endpoint. |
| The web keeps its own copy of settings and the type in localStorage, besides the server's | `main.js` | Use the server's copy, which it always has after unlock. localStorage keeps only the password and the custom alarm. |
| The web renames every setting (`icsUrl` ↔ `ics_url`, `leadMin` ↔ `offset_min`, ...) in both directions | `main.js`, `index.html` ids | Use the server's names everywhere. |
| `settings.get(key, DEFAULT_X)` repeated in 4 places, plus 3 `DEFAULT_*` constants | `index.py` | The `Settings` model holds the defaults; `load_settings()` returns one. |
| `try/except RuntimeError → HTTPException(502)` written 3 times | `index.py` | One `@app.exception_handler(RuntimeError)` |
| `/api/sync` and `/api/cron` are the same function | `index.py` | One function, two routes |
| Middleware + `password_ok` split for one check | `index.py` | One function |
| `device_id()` + `topic()` + `DEFAULT_DEVICE_ID` | `index.py` | One `TOPIC` constant |
| Change optimistically, then roll back on failure, written 3 times | `main.js` (type, set custom, clear custom) | Update after the server says OK |
| `sync()` has its own copy of `run()`'s error handling | `main.js` | Use `run()` |
| The custom alarm is an object `{time, on}` | `main.js` | One number; 0 means none |
| 3 nearly identical 12-line Settings tiles | `index.html` | Built from `STEPPERS` in JS, like the knob labels already are |
| `.tile-key` repeats the raised-key styles; `.trace svg`, `.trace path` and `.top` are each defined twice | `style.css` | Join the shared rule; one rule each |
| Alarms, fired time and settings live in 4 flash files with 4 constants | `alarms.py` | One `state.json` |
| `json.loads` + `try/except → ValueError` in every handler, plus 3 try/excepts in `on_message` | `alarms.py`, `main.py` | `on_message` parses once and catches once |
| Subscribes to 4 topics one by one; net.py knows every topic name | `net.py` | One `shakeawake/<id>/#` subscribe. net hands main the short name (`cmd`, `settings`, `alarms/manual`). Fewer round trips on every connect. |
| `clock_ok()`, `unix_time()` getters around a variable | `net.py` | Read `net.clock_ok`; use `time.time()` |
| `MQTT_PORT` in `.env`, plus `INT_KEYS` conversion in the script | `.env`, `gen_pico_env.py` | `MQTT_PORT = 8883` constant in net.py (EMQX Serverless is TLS-only on 8883) |
| The settings type can be `null` ("each alarm's own") | everywhere | Defaults to `"classic"`, never null |

### Kept on purpose
- Vite.
- net.py's Wi-Fi rejoin logic: proven against the hotspot bugs.
- python-dotenv: it handles quoting, and it's laptop-only.
- The Pico re-checking the server's limits: MQTT is its trust boundary.
- `shaker.DEFAULT`: a renamed type must never silence an alarm.
- wave.js drawing math and the page's look and feel.
- The slide-to-unlock and knob code.

### Behavior changes you should know about (everything else stays the same)
1. Setting the type or the custom alarm shows after the server answers (a fraction of a second) instead of instantly with a roll-back.
2. Logging in also needs the settings storage (Upstash) to answer, not just the password check.
3. After step 9, set your custom alarm once more. Old-format messages are ignored; the calendar refills on the next Sync.
4. The Pico pings every 15 s (you approved). Idle MQTT traffic halves; the website still shows a lost Pico within ~30 s.

### Still open
Wi-Fi power saving stays forced off (the hotspot join failed with it on; the Pico is on mains power). Say if you want it tried on.

## Rules for every step
- ponytail full mode is on. Run the code-simplifier agent on the files a step touched, keeping only edits inside the step's scope.
- Run the check harness, show a short diff summary and the line change, then make one commit. Don't push. Pushing to main deploys, so it waits for you.
- If a step turns out riskier than planned, stop and report.
- Zero comments. A name that loses its comment gets a clearer name. Hardware "why" facts move to README (step 10).
- The web and `/api` deploy together in one push, so web+server steps need no compatibility code.

## Steps (lowest risk first)

### ✅ Step 0: Baseline (no code change)
Build a check harness in the scratchpad; it is never committed.
- Compile and build: `py_compile` on every .py file, `node --check` on each JS file, `npm run build --prefix web`.
- API test: a scratch venv with `api/requirements.txt` + httpx. TestClient runs against fake `emqx.publish`/`connected` and `redis`, which record what they receive. It covers each route: 401 without the password, validation errors, and the exact topics and payloads published.
- Calendar test: `compute()` on a sample ICS (timed, all-day, cancelled, recurring and floating-time events).
- Pico test under CPython: `alarms.py` in a temp folder (update/due/mark_fired/settings/load round trip), and `main.on_message` plus `shaker` with a fake `machine`, fake ticks and a fake `net`.

Save the outputs as the baseline. A step that changes an output on purpose updates the harness in the same commit and says what changed.

### Step 1: Delete `.claude/settings.json`
- Lines: −14.
- Check: harness unchanged.

### Step 2: Delete dead web and server code
- `api.js`: the legacy `removeItem`.
- `tokens.css`: the 3 unused tokens.
- `index.py`: every `"ok": True`.
- Lines: ~−5.
- Check: harness unchanged, except that replies lose `ok`.

### Step 3: CSS duplicates
- `style.css`: one `.trace svg`, one `.trace path` and one `.top` rule each. `.tile-key` joins the shared raised-key rule.
- Lines: ~−12.
- Check: build. **Visual:** in `make dev`, compare lock, main, Settings, a short phone and a wide desktop against step 0 screenshots. They should look identical.

### Step 4: Remove the web comments
- Files: `main.js`, `wave.js`, `api.js`, `sw.js`, `style.css`, `tokens.css`, `index.html`. Rename the wave.js constants that become unclear.
- Lines: ~−170.
- Check: `node --check`, build, and the visual check.

### Step 5: Remove the server and script comments
- Files: `api/*.py` (docstrings too), `scripts/*.py`, the `env.py` header line, Makefile comments (the `##` help text stays because `make help` reads it), and `.env.example`. The "where to find this key" notes move to README setup.
- Lines: ~−75 code, ~+10 README.
- Check: harness unchanged. `make help` works. `gen_pico_env.py` output is the same minus its header.

### Step 6: Simplify the server internals (same API from outside)
- One `RuntimeError` → 502 handler.
- The `Settings` model holds the defaults, and `load_settings()` returns a `Settings`.
- One password function.
- A `TOPIC` constant.
- `/api/sync` and `/api/cron` merged.
- Lines: ~−40.
- Check: harness unchanged.

### Step 7: Login, settings and type use one endpoint (web + server)
- Login calls `GET /api/settings` and the page uses that reply, so `/api/health` goes.
- The type is saved through `PUT /api/settings`, so `/api/type`, `AlarmType` and `api.setType` go.
- The web uses `settings.pattern` instead of its own `alarmType`, and the server's key names everywhere. The local settings and type caches go.
- Lines: ~−45.
- Check: harness updated (health and type routes removed). **Manual, `make dev`:**
  1. Unlock with the typed password, reload, and it unlocks by itself.
  2. A wrong password gets a shake.
  3. Set the type on the knob, reload, and it's still set.
  4. Change each Settings stepper and Save; open on a second device and see the same values.
  5. Log out, and it asks for the password again.

### Step 8: Simplify the web actions
- The type, set custom and clear custom actions wait for the server; there is no roll-back.
- `sync()` uses `run()`.
- The custom alarm is one number.
- The Settings tiles are built from `STEPPERS`.
- Lines: ~−40.
- Check: build. **Manual, `make dev`:**
  1. Set, clear and reset a custom alarm.
  2. An alarm time in the past gets a shake.
  3. With Wi-Fi off, Set shows "Not sent" and nothing changes.
  4. Sync shows its checkmark.
  5. The Settings tiles look and step exactly as before, including keyboard Tab and Enter.
  6. Let a custom alarm pass, and the chip goes back to "Set custom alarm".

### Step 9: Pico cleanup ⚠ HARDWARE TEST
- Before editing: run `make logs`, reboot, and confirm it prints `Clock epoch: 1970`. If it prints 2000, `UNIX_OFFSET` stays.
- Changes:
  - Remove the comments and the dead code (`online()`, `UNIX_OFFSET`, `DEFAULT_TEST_S`, `type.json`).
  - Replace the getters with `net.clock_ok` and `time.time()`.
  - One `#` subscribe, with net handing main the short topic names.
  - One try/except in `on_message`.
  - `PING_MS = 15_000`.
  - `MQTT_PORT` becomes a constant, and leaves `.env.example` and `gen_pico_env.py`.
- Lines: ~−110.
- Check: Pico harness unchanged. **On the device, with `make run`** (the log shows "MQTT: online"):
  1. Try each of the 4 types and feel it; Stop cuts it off.
  2. Set a custom alarm 2 min ahead. It fires, and stops by itself after "Alarm stops after".
  3. Set one 3 min ahead, then turn the hotspot off. The website shows offline within ~30 s, and the alarm still fires.
  4. Turn the hotspot back on. The log shows "MQTT: online", and the website shows online.
  5. Ctrl-C while it plays. The shaker stops and the log prints "Shaker off".
  6. Leave it idle for 5 min. The website stays "online" the whole time; this checks the 15 s ping.

### Step 10: New message format (Pico + server + web) ⚠ HARDWARE TEST
- The new format:
  - Alarms: a bare list of times, `[1763290800, 1763377200]`.
  - Settings: `{"pattern": "rise", "max_run_s": 90}`, where `pattern` is never null and defaults to `"classic"`.
  - No `v`, no `gen`, no per-alarm type.
- On the Pico, `alarms.py` keeps one `state.json`.
- The server drops `Alarm.pattern`, the calendar's `PATTERN` and `PAYLOAD_VERSION`; the web's `setAlarm` drops its type argument.
- The PLAN.md contract table is updated.
- Lines: ~−45, plus fewer bytes per message.
- Check: harness updated to the new payloads. **On the device:**
  1. Flash with `make run`, then push or `make deploy`.
  2. Once, delete the old files: `.venv/Scripts/python -m mpremote rm :calendar.json :manual.json :fired.json :settings.json`.
  3. Press Sync; the log prints `Alarms: new calendar ...`.
  4. Change the type; the log prints `Settings: ...`.
  5. Set a custom alarm 2 min ahead; it fires with the chosen type.
  6. Unplug the Pico, turn the hotspot off and replug. `Alarms: loaded ...` shows the saved alarms (the clock waits for NTP, as before). Turn the hotspot back on.

### Step 11: Docs
- PLAN.md: only the MQTT contract and how the system behaves, with stale facts fixed.
- README: a short "Why it's built this way" list:
  - Wi-Fi power saving is off.
  - A rejoin switches the radio off and on.
  - The broker connect is skipped while the shaker plays.
  - Duty follows asin.
  - Flash writes go to a temp file, then a rename.
  - A cleared alarm is an empty list, never an empty retained message.
  - SNI needs an SSLContext.
  - Plain `mpremote run` doesn't pass Ctrl-C.
- CLAUDE.md: "PLAN.md step" → "REFACTOR_PLAN.md step"; the MQTT_PORT line is removed.
- Lines: ~−70.
- Check: every README fact matches the code. Nothing mentions Cloudflare, mqtt.js, the old topics or `/api/type`.

## Before / after (estimated, text files; PNGs, package-lock and this plan excluded)
| | Before | After |
|---|---|---|
| Tracked files | 31 | 30 |
| pico/ | 474 | ~300 |
| api/ | 363 | ~200 |
| web/ (without lock) | 1,714 | ~1,400 |
| scripts/ | 76 | ~55 |
| root files and docs | 371 | ~290 |
| **Total** | **~3,000** | **~2,250** |
| API endpoints | 10 | 8 |
| Flash files on the Pico | 4 | 1 |
| Dependencies | 7 | 7 (you kept Vite) |

## End-to-end check after everything is pushed
On the phone:
1. Unlock, Try, then set an alarm on mobile data and feel it fire.
2. Settings and the type saved on one device show on another.
3. Vercel **Settings > Cron Jobs > Run** logs "Calendar sync: N alarms".
