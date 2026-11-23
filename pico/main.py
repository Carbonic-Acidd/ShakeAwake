import json
import time

import alarms
import net
import shaker

LOOP_MS = 10
ERROR_PAUSE_S = 5
MAX_TEST_S = 90

stop_at = None


def play(name, seconds, test=False):
    global stop_at
    shaker.start(name, test)
    stop_at = time.ticks_add(time.ticks_ms(), int(seconds * 1000))
    print("Playing", name, "for", seconds, "s")


def silence():
    global stop_at
    shaker.stop()
    if stop_at is not None:
        print("Stopped")
    stop_at = None


def check_pattern(name):
    if name not in shaker.PATTERNS:
        raise ValueError("unknown alarm type " + str(name))


def on_message(topic, payload):
    if topic == "status":
        return
    try:
        data = json.loads(payload)
        if topic == "cmd" and data["cmd"] == "stop":
            silence()
        elif topic == "cmd" and data["cmd"] == "test":
            check_pattern(data["pattern"])
            play(data["pattern"], max(0, min(float(data["seconds"]), MAX_TEST_S)), test=True)
        elif topic == "settings":
            check_pattern(data["pattern"])
            if alarms.set_settings(data["pattern"], data["max_run_s"]):
                print("Settings:", payload)
        elif topic in ("alarms/calendar", "alarms/manual"):
            if alarms.set_list(topic.split("/")[1], data):
                print("Alarms: new", topic, payload)
        else:
            raise ValueError("unknown message")
    except Exception as e:
        print("Ignored", topic, payload, repr(e))


def step():
    shaker.update()
    net.service(busy=stop_at is not None)
    if stop_at is not None and time.ticks_diff(time.ticks_ms(), stop_at) >= 0:
        silence()
    alarm = net.clock_ok and alarms.due(time.time())
    if alarm:
        alarms.mark_fired(alarm)
        print("Alarm!", alarm)
        play(alarms.state["pattern"], alarms.state["max_run_s"])


try:
    alarms.load()
    net.start(on_message)
    print("Ready. Ctrl-C to stop.")
    while True:
        try:
            step()
        except Exception as e:
            silence()
            print("Error:", repr(e), "- carrying on in", ERROR_PAUSE_S, "s")
            time.sleep(ERROR_PAUSE_S)
        time.sleep_ms(LOOP_MS)
finally:
    shaker.stop()
    print("Shaker off")
    net.stop()
