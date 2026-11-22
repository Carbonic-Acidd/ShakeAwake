# Turns a calendar link into alarms: for each of the next DAYS days, the first timed event's
# start minus the lead time. All-day events are ignored; empty days get no alarm.
# index.py decides which link and lead time (the website's saved settings, else the env vars).
from datetime import datetime, time, timedelta
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

ZONE = ZoneInfo("America/New_York")   # whose "days" count, and the zone for floating times
DAYS = 7
PATTERN = "classic"                   # calendar alarms' type (the website's alarm type overrides it on the Pico)
TIMEOUT_S = 15


def alarms(url, offset_min, now):
    """Returns [[UTC Unix seconds, pattern], ...] in time order, only alarms after now."""
    if not url:
        raise RuntimeError("No calendar link yet: add one in Settings")
    url = url.replace("webcal://", "https://", 1)   # calendar apps often hand out webcal:// links
    try:
        with urlopen(Request(url, headers={"User-Agent": "ShakeAwake"}), timeout=TIMEOUT_S) as response:
            text = response.read().decode("utf-8", errors="replace")
    except HTTPError as e:
        raise RuntimeError(f"Calendar fetch said {e.code}")
    except Exception as e:
        raise RuntimeError(f"Couldn't fetch the calendar: {e}")
    offset = timedelta(minutes=offset_min)
    try:
        return compute(text, now, offset)
    except Exception as e:
        raise RuntimeError(f"Couldn't read the calendar: {e!r}")


def compute(ics_text, now, offset):
    today = now.astimezone(ZONE).date()
    days = [today + timedelta(days=n) for n in range(DAYS)]
    window_start = datetime.combine(days[0], time(0), ZONE)
    window_end = datetime.combine(days[-1] + timedelta(days=1), time(0), ZONE)

    first = {}   # local date -> earliest timed event start that day
    calendar = icalendar.Calendar.from_ical(ics_text)
    for event in recurring_ical_events.of(calendar).between(window_start, window_end):
        start = event["DTSTART"].dt
        if not isinstance(start, datetime) or event.get("STATUS") == "CANCELLED":
            continue   # all-day events are dates, not datetimes
        if start.tzinfo is None:
            start = start.replace(tzinfo=ZONE)   # "floating" time: means local time
        start = start.astimezone(ZONE)
        day = start.date()
        if day in days and (day not in first or start < first[day]):
            first[day] = start

    result = []
    for day in sorted(first):
        alarm = int((first[day] - offset).timestamp())
        if alarm > now.timestamp():
            result.append([alarm, PATTERN])
    return result
