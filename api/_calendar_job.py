from datetime import datetime, time, timedelta
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

ZONE = ZoneInfo("America/New_York")
DAYS = 7
TIMEOUT_S = 15


def alarms(url, offset_min, now):
    if not url:
        raise RuntimeError("No calendar link yet: add one in Settings")
    request = Request(url.replace("webcal://", "https://", 1), headers={"User-Agent": "ShakeAwake"})
    try:
        with urlopen(request, timeout=TIMEOUT_S) as response:
            text = response.read().decode("utf-8", errors="replace")
    except HTTPError as e:
        raise RuntimeError(f"Calendar fetch said {e.code}")
    except Exception as e:
        raise RuntimeError(f"Couldn't fetch the calendar: {e}")
    try:
        return first_event_alarms(text, now, timedelta(minutes=offset_min))
    except Exception as e:
        raise RuntimeError(f"Couldn't read the calendar: {e!r}")


def first_event_alarms(ics_text, now, offset):
    days = [now.astimezone(ZONE).date() + timedelta(days=n) for n in range(DAYS)]
    window_start = datetime.combine(days[0], time(0), ZONE)
    window_end = datetime.combine(days[-1] + timedelta(days=1), time(0), ZONE)
    events = recurring_ical_events.of(icalendar.Calendar.from_ical(ics_text)).between(window_start, window_end)
    first = {}
    for event in events:
        start = event["DTSTART"].dt
        if not isinstance(start, datetime) or event.get("STATUS") == "CANCELLED":
            continue
        start = (start if start.tzinfo else start.replace(tzinfo=ZONE)).astimezone(ZONE)
        if start.date() in days:
            first[start.date()] = min(first.get(start.date(), start), start)
    alarms = [int((first[day] - offset).timestamp()) for day in sorted(first)]
    return [alarm for alarm in alarms if alarm > now.timestamp()]
