# The alarm lists, kept in flash so a reboot or power cut doesn't lose them.
# Knows nothing about Wi-Fi, MQTT or the shaker.
#
# Two lists, each from its own retained MQTT topic and saved to its own file:
# "calendar" (from the server's daily sync) and "manual" (set on the website).
# Each alarm is [UTC Unix seconds, alarm type]. due(now) merges both lists.
# The website's settings (their own retained topic, saved to SETTINGS_FILE): the alarm type,
# which overrides every alarm's own so changing it changes calendar alarms too, and how long
# an alarm plays before it stops by itself.
import json
import os

PAYLOAD_VERSION = 1     # the "v" field the server sends
MAX_ALARMS = 20         # per list; a longer list is rejected (the server sends at most 7)
LATE_OK_S = 300         # still fire an alarm this late (e.g. power came back just after it)
FILES = {"calendar": "calendar.json", "manual": "manual.json"}
FIRED_FILE = "fired.json"   # time of the last alarm that fired, so a reboot can't refire it
SETTINGS_FILE = "settings.json"   # {"pattern": alarm type or null, "max_run_s": seconds}
DEFAULT_MAX_RUN_S = 90      # an alarm plays this long unless stopped, until the website says
MAX_RUN_RANGE = (10, 600)   # the shortest and longest the website may ask for

_lists = {"calendar": [], "manual": []}
_last_fired = 0
_settings = {"pattern": None, "max_run_s": DEFAULT_MAX_RUN_S}


def load():
    global _last_fired
    for name, path in FILES.items():
        _lists[name] = _read(path, [])
    _last_fired = _read(FIRED_FILE, 0)
    _settings.update(_read(SETTINGS_FILE, {"pattern": _read("type.json", None)}))   # type.json: older code
    print("Alarms: loaded", _lists, "last fired", _last_fired, "settings", _settings)


def set_settings(payload, patterns):
    """Checks a settings message ({"v": 1, "pattern": name or null, "max_run_s": seconds}) and
    saves it. Raises ValueError if it's bad, keeping the old one. Returns True if it changed."""
    try:
        data = json.loads(payload)
        if data["v"] != PAYLOAD_VERSION:
            raise ValueError
        name = data.get("pattern")
        run = int(data.get("max_run_s", DEFAULT_MAX_RUN_S))
    except Exception:
        raise ValueError("bad settings message")
    if name is not None and name not in patterns:
        raise ValueError("unknown alarm type " + str(name))
    new = {"pattern": name, "max_run_s": max(MAX_RUN_RANGE[0], min(MAX_RUN_RANGE[1], run))}
    if new == _settings:
        return False
    _settings.update(new)
    _write(SETTINGS_FILE, _settings)
    return True


def max_run_s():
    """How long an alarm plays before it stops by itself."""
    return _settings["max_run_s"]


def update(name, payload, patterns):
    """Checks a message's payload and saves its alarms. Raises ValueError if it's bad,
    keeping the old list. Returns True if the list changed."""
    try:
        data = json.loads(payload)
        if data["v"] != PAYLOAD_VERSION or len(data["alarms"]) > MAX_ALARMS:
            raise ValueError
        alarms = sorted([int(t), str(pattern)] for t, pattern in data["alarms"])
    except Exception:
        raise ValueError("bad alarm message")
    for t, pattern in alarms:
        if pattern not in patterns:
            raise ValueError("unknown alarm type " + pattern)
    if alarms == _lists[name]:
        return False   # retained messages arrive on every reconnect; don't rewrite flash
    _lists[name] = alarms
    _write(FILES[name], alarms)
    return True


def due(now):
    """Returns [time, alarm type] of the alarm to fire at UTC time now, or None.
    Alarms more than LATE_OK_S in the past, or not after the last fired one, are skipped."""
    found = None
    for alarm in _lists["calendar"] + _lists["manual"]:
        if _last_fired < alarm[0] <= now and now - alarm[0] <= LATE_OK_S:
            if found is None or alarm[0] > found[0]:
                found = alarm   # the latest; marking it fired also covers any earlier one
    return found and [found[0], _settings["pattern"] or found[1]]


def mark_fired(t):
    global _last_fired
    _last_fired = t
    _write(FIRED_FILE, t)


def _read(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:   # missing (first boot) or unreadable: start empty
        return default


def _write(path, value):
    # Write a temp file, then rename it over the real one. On the Pico's filesystem (littlefs)
    # rename is atomic, so a power cut leaves either the old file or the new one, never half.
    with open(path + ".tmp", "w") as f:
        json.dump(value, f)
    os.rename(path + ".tmp", path)
