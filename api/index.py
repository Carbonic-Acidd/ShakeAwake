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

DEVICE_ID = os.environ.get("DEVICE_ID") or "bed1"
TOPIC = f"shakeawake/{DEVICE_ID}/"
PICO_CLIENT_ID = "shakeawake-" + DEVICE_ID
MAX_TEST_S = 90
REDIS_TIMEOUT_S = 10
LINK_STARTS = ("https://", "http://", "webcal://")

app = FastAPI()


class Test(BaseModel):
    pattern: str = Field(min_length=1, max_length=20)
    seconds: int = Field(default=10, ge=1, le=MAX_TEST_S)


class Alarm(BaseModel):
    time: int


class Settings(BaseModel):
    ics_url: str = Field(default="", max_length=2000)
    offset_min: int = Field(default=int(os.environ.get("ALARM_OFFSET_MIN") or 60), ge=0, le=720)
    max_run_s: int = Field(default=90, ge=10, le=600)
    try_s: int = Field(default=10, ge=1, le=MAX_TEST_S)
    pattern: str = Field(default="classic", min_length=1, max_length=20)


def redis(command, body=None):
    url, token = os.environ.get("KV_REST_API_URL"), os.environ.get("KV_REST_API_TOKEN")
    if not url or not token:
        raise RuntimeError("Settings storage isn't set up (Upstash for Redis in Vercel's Storage tab)")
    request = HttpRequest(url.rstrip("/") + "/" + command, headers={"Authorization": "Bearer " + token},
                          data=None if body is None else body.encode())
    try:
        with urlopen(request, timeout=REDIS_TIMEOUT_S) as response:
            return json.loads(response.read())["result"]
    except Exception as e:
        raise RuntimeError(f"Couldn't reach settings storage: {e}")


def load_settings():
    saved = redis("get/settings")
    return Settings.model_validate_json(saved) if saved else Settings()


def send(subtopic, payload, retain=False):
    return {"delivered": emqx.publish(TOPIC + subtopic, payload, retain=retain, qos=1 if retain else 0)}


@app.exception_handler(RuntimeError)
async def service_unreachable(request, error):
    return JSONResponse({"detail": str(error)}, status_code=502)


@app.middleware("http")
async def check_password(request: Request, call_next):
    expected = os.environ.get("APP_PASSWORD") or ""
    given = (request.headers.get("Authorization") or "").removeprefix("Bearer ")
    if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
        return JSONResponse({"detail": "Wrong password"}, status_code=401)
    return await call_next(request)


@app.get("/api/status")
def status():
    return {"online": emqx.connected(PICO_CLIENT_ID)}


@app.post("/api/test")
def test(body: Test):
    return send("cmd", {"cmd": "test", "pattern": body.pattern, "seconds": body.seconds})


@app.post("/api/stop")
def stop():
    return send("cmd", {"cmd": "stop"})


@app.put("/api/alarm")
def set_alarm(body: Alarm):
    if body.time <= time.time():
        raise HTTPException(400, "Pick a time in the future")
    return send("alarms/manual", [body.time], retain=True)


@app.delete("/api/alarm")
def clear_alarm():
    return send("alarms/manual", [], retain=True)


@app.get("/api/settings")
def get_settings():
    return load_settings()


@app.put("/api/settings")
def put_settings(body: Settings):
    body.ics_url = body.ics_url.strip()
    if body.ics_url and not body.ics_url.lower().startswith(LINK_STARTS):
        raise HTTPException(400, "The calendar link should start with https:// or webcal://")
    redis("set/settings", body.model_dump_json())
    return send("settings", body.model_dump(include={"pattern", "max_run_s"}), retain=True)


@app.get("/api/cron")
@app.post("/api/sync")
def sync():
    settings = load_settings()
    url = settings.ics_url or os.environ.get("ICS_URL")
    alarms = calendar_job.alarms(url, settings.offset_min, datetime.now(timezone.utc))
    send("alarms/calendar", alarms, retain=True)
    print("Calendar sync:", len(alarms), "alarms")
    return {"alarms": alarms}
