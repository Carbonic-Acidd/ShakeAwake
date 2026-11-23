import json
import os

STATE_FILE = "state.json"
MAX_ALARMS = 20
LATE_OK_S = 300
MAX_RUN_RANGE = (10, 600)

state = {"calendar": [], "manual": [], "fired": 0, "pattern": "classic", "max_run_s": 90}


def load():
    try:
        with open(STATE_FILE) as f:
            state.update(json.load(f))
    except Exception:
        pass
    print("Alarms: loaded", state)


def save():
    with open(STATE_FILE + ".tmp", "w") as f:
        json.dump(state, f)
    os.rename(STATE_FILE + ".tmp", STATE_FILE)


def set_list(name, times):
    if not isinstance(times, list) or len(times) > MAX_ALARMS:
        raise ValueError("bad alarm list")
    times = sorted(int(t) for t in times)
    if times == state[name]:
        return False
    state[name] = times
    save()
    return True


def set_settings(pattern, max_run_s):
    max_run_s = max(MAX_RUN_RANGE[0], min(MAX_RUN_RANGE[1], int(max_run_s)))
    if pattern == state["pattern"] and max_run_s == state["max_run_s"]:
        return False
    state["pattern"] = pattern
    state["max_run_s"] = max_run_s
    save()
    return True


def due(now):
    late = [t for t in state["calendar"] + state["manual"] if state["fired"] < t <= now and now - t <= LATE_OK_S]
    return max(late) if late else None


def mark_fired(t):
    state["fired"] = t
    save()
