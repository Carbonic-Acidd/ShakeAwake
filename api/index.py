# The server: one Vercel Python function. Vercel serves the built site (web/dist) itself; only
# /api/* reaches this code (the rewrite in vercel.json). Endpoints publish to the Pico through
# EMQX, and the website's settings are kept in Upstash Redis (added from Vercel's Storage tab).
# Every request must carry the shared password (APP_PASSWORD) in its Authorization header.
import hmac
import json
import os
import time
from datetime import datetime, timezone
from urllib.request import Request as HttpRequest, urlopen

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api import _calendar_job as calendar_job
from api import _emqx as emqx

# The server's settings, Vercel environment variables (uploaded from .env by `make secrets`).
# ICS_URL and ALARM_OFFSET_MIN are only fallbacks: the website's Settings panel saves its own.
REDIS_URL_KEY = "KV_REST_API_URL"       # set by Vercel's Upstash for Redis integration
REDIS_TOKEN_KEY = "KV_REST_API_TOKEN"
REDIS_TIMEOUT_S = 10
CONFIG_KEYS = ["EMQX_API_URL", "EMQX_API_KEY", "EMQX_API_SECRET", "DEVICE_ID", "APP_PASSWORD",
               REDIS_URL_KEY, REDIS_TOKEN_KEY]
DEFAULT_DEVICE_ID = "bed1"
PICO_CLIENT_PREFIX = "shakeawake-"   # the Pico's MQTT client id is this + DEVICE_ID (pico/net.py)
MAX_TEST_S = 90           # the Pico won't play a test longer than this either
PAYLOAD_VERSION = 1       # the "v" field in alarm messages, bumped if their shape changes
SETTINGS_KEY = "settings" # the one Redis key: {"ics_url", "offset_min", "max_run_s", "try_s", "pattern"}
DEFAULT_OFFSET_MIN = 60   # wake this long before the first event, unless set
DEFAULT_MAX_RUN_S = 90    # an alarm stops itself after this long, unless set
DEFAULT_TRY_S = 10        # Try plays this long, unless set (the website uses it; the Pico caps it)
MAX_RUN_RANGE = (10, 600) # the Pico enforces the same limits
LINK_STARTS = ("https://", "http://", "webcal://")

app = FastAPI()


class Test(BaseModel):
    pattern: str = Field(min_length=1, max_length=20)
    seconds: int = Field(default=10, ge=1, le=MAX_TEST_S)


class Alarm(BaseModel):
    time: int             # UTC Unix seconds
    pattern: str = Field(min_length=1, max_length=20)


class AlarmType(BaseModel):
    pattern: str = Field(min_length=1, max_length=20)


class Settings(BaseModel):
    ics_url: str = Field(default="", max_length=2000)   # "" = use ICS_URL, if any
    offset_min: int = Field(default=DEFAULT_OFFSET_MIN, ge=0, le=720)
    max_run_s: int = Field(default=DEFAULT_MAX_RUN_S, ge=MAX_RUN_RANGE[0], le=MAX_RUN_RANGE[1])
    try_s: int = Field(default=DEFAULT_TRY_S, ge=1, le=MAX_TEST_S)
    pattern: str | None = Field(default=None, max_length=20)   # the device's alarm type, if not saved yet


def config(key):
    return os.environ.get(key) or None


def redis(command, body=None):
    """One Upstash Redis REST command, e.g. "get/settings". Returns its "result"."""
    url, token = config(REDIS_URL_KEY), config(REDIS_TOKEN_KEY)
    if not url or not token:
        raise HTTPException(500, "Settings storage isn't set up (Upstash for Redis in Vercel's Storage tab)")
    request = HttpRequest(url.rstrip("/") + "/" + command, headers={"Authorization": "Bearer " + token},
                          data=body.encode() if body is not None else None)
    try:
        with urlopen(request, timeout=REDIS_TIMEOUT_S) as response:
            return json.loads(response.read())["result"]
    except Exception as e:
        raise HTTPException(502, f"Couldn't reach settings storage: {e}")


def load_settings():
    """The saved settings (a dict, maybe empty)."""
    raw = redis("get/" + SETTINGS_KEY)
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def save_settings(settings):
    redis("set/" + SETTINGS_KEY, json.dumps(settings))   # POST: the body is the value


def send_pico_settings(settings):
    # The Pico's own settings, retained so it gets them whenever it connects: the alarm type
    # every alarm plays (null = each alarm's own) and how long an alarm plays before stopping.
    return send("settings", {"v": PAYLOAD_VERSION, "pattern": settings.get("pattern"),
                             "max_run_s": settings.get("max_run_s", DEFAULT_MAX_RUN_S)}, retain=True)


def device_id():
    return config("DEVICE_ID") or DEFAULT_DEVICE_ID


def topic(name):
    return f"shakeawake/{device_id()}/{name}"


def send(name, payload, retain=False):
    # Retained alarm messages use QoS 1 so the broker confirms it stored them.
    # "delivered" says whether the Pico was listening (if not, it's offline; retained ones wait).
    try:
        delivered = emqx.publish(topic(name), payload, retain=retain, qos=1 if retain else 0)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "delivered": delivered}


def alarms_message(alarms):
    return {"v": PAYLOAD_VERSION, "gen": int(time.time()), "alarms": alarms}


def sync_calendar():
    """Reads the calendar and publishes its alarms (retained). Run by the daily cron and /api/sync.
    Uses the saved link and lead time, else ICS_URL and ALARM_OFFSET_MIN.
    On any error nothing is published, so the Pico keeps the last good list."""
    settings = load_settings()
    url = settings.get("ics_url") or config("ICS_URL")
    offset = settings.get("offset_min", config("ALARM_OFFSET_MIN") or DEFAULT_OFFSET_MIN)
    try:
        alarms = calendar_job.alarms(url, int(offset), datetime.now(timezone.utc))
        emqx.publish(topic("alarms/calendar"), alarms_message(alarms), retain=True, qos=1)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return alarms


# Checked before every endpoint. "Authorization: Bearer <password>" must match APP_PASSWORD.
# Vercel's cron sends "Bearer <CRON_SECRET>", which is set to the same value, so it gets in too.
@app.middleware("http")
async def check_password(request: Request, call_next):
    if not password_ok(request):
        return JSONResponse({"detail": "Wrong password"}, status_code=401)
    return await call_next(request)


def password_ok(request):
    """No APP_PASSWORD set means nobody gets in, rather than everybody."""
    expected = config("APP_PASSWORD")
    given = (request.headers.get("Authorization") or "").removeprefix("Bearer ")
    # compare_digest takes the same time however much matches, so timing gives no hints.
    return bool(expected) and hmac.compare_digest(given.encode(), expected.encode())


@app.get("/api/health")
def health():
    # Names only, never values, so a missing setting is easy to spot.
    return {"ok": True, "missing_config": [key for key in CONFIG_KEYS if not config(key)]}


# Whether the Pico is connected to the broker right now. EMQX notices a Pico that lost power
# or Wi-Fi only after its keepalive runs out (about 30 s, see pico/net.py).
@app.get("/api/status")
def status():
    try:
        online = emqx.connected(PICO_CLIENT_PREFIX + device_id())
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "online": online}


@app.post("/api/test")
def test(body: Test):
    return send("cmd", {"cmd": "test", "pattern": body.pattern, "seconds": body.seconds})


@app.post("/api/stop")
def stop():
    return send("cmd", {"cmd": "stop"})


# One manual alarm at a time: setting one replaces the last. Retained, so the Pico gets it
# whenever it next connects.
@app.put("/api/alarm")
def set_alarm(body: Alarm):
    if body.time <= time.time():
        raise HTTPException(400, "Pick a time in the future")
    return send("alarms/manual", alarms_message([[body.time, body.pattern]]), retain=True)


# An empty list, not an empty message: an empty retained message would delete it from the
# broker, and a Pico that was offline would never hear the alarm was cleared.
@app.delete("/api/alarm")
def clear_alarm():
    return send("alarms/manual", alarms_message([]), retain=True)


# The alarm type every alarm plays, calendar and custom (the Pico checks the name). Saved, and
# sent to the Pico with its other settings.
@app.put("/api/type")
def set_type(body: AlarmType):
    settings = load_settings()
    settings["pattern"] = body.pattern
    save_settings(settings)
    return send_pico_settings(settings)


# The Settings panel. Read on unlock (so every device shows the same), saved from Save.
@app.get("/api/settings")
def get_settings():
    settings = load_settings()
    return {"ok": True, "ics_url": settings.get("ics_url", ""),
            "offset_min": settings.get("offset_min", int(config("ALARM_OFFSET_MIN") or DEFAULT_OFFSET_MIN)),
            "max_run_s": settings.get("max_run_s", DEFAULT_MAX_RUN_S), "try_s": settings.get("try_s", DEFAULT_TRY_S),
            "pattern": settings.get("pattern")}


@app.put("/api/settings")
def put_settings(body: Settings):
    link = body.ics_url.strip()
    if link and not link.lower().startswith(LINK_STARTS):
        raise HTTPException(400, "The calendar link should start with https:// or webcal://")
    settings = load_settings()
    settings.update(ics_url=link, offset_min=body.offset_min, max_run_s=body.max_run_s, try_s=body.try_s)
    if body.pattern and not settings.get("pattern"):   # so saving never clears the Pico's alarm type
        settings["pattern"] = body.pattern
    save_settings(settings)
    return send_pico_settings(settings)


@app.post("/api/sync")
def sync():
    return {"ok": True, "alarms": sync_calendar()}


# The daily Vercel cron (vercel.json, 08:00 UTC = 3 am New York in winter, 4 am in summer).
# Vercel sends a GET. Errors and the count show in the project's Logs.
@app.get("/api/cron")
def cron():
    alarms = sync_calendar()
    print("Calendar sync:", len(alarms), "alarms")
    return {"ok": True, "alarms": alarms}
