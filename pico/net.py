"""Wi-Fi + clock (NTP) + MQTT for the Pico. Knows nothing about the shaker or alarms.

start(on_message) begins joining Wi-Fi and returns at once; it never needs the internet.
Then call service(busy) every loop. It keeps the connection going and hands each incoming
message to on_message(topic, payload). Nothing here raises on network trouble: the Pico
just stays offline and service() keeps retrying, so alarms keep working.

Each time it gets online it sets the clock from NTP, connects to the broker (last-will
"offline", retained), publishes "online" (retained) and subscribes to the command, alarm and
settings topics; the retained alarm lists and alarm type arrive right away. clock_ok() is False until NTP has worked
once since boot: the Pico has no clock battery, so until then its time is meaningless.

Connecting to the broker blocks for a few seconds (TLS), so service(busy=True) skips it
while the shaker plays.
"""
import gc
import network
import ntptime
import rp2
import ssl
import time

from umqtt.simple import MQTTClient, MQTTException

import env

BASE_TOPIC = "shakeawake/" + env.DEVICE_ID + "/"
STATUS_TOPIC = BASE_TOPIC + "status"
CMD_TOPIC = BASE_TOPIC + "cmd"
ALARM_TOPICS = {BASE_TOPIC + "alarms/calendar": "calendar", BASE_TOPIC + "alarms/manual": "manual"}
SETTINGS_TOPIC = BASE_TOPIC + "settings"   # the alarm type every alarm plays
KEEPALIVE_S = 20          # if we go silent this long (x1.5), the broker marks us offline (last-will),
                          # so the website shows a lost Pico as offline within about 30 s
PING_MS = 8_000           # ping well inside the keepalive (pings still go out while the shaker plays)
RECONNECT_MS = 10_000     # while offline, how often to retry
JOIN_TIMEOUT_MS = 30_000  # if Wi-Fi hasn't joined after this long, switch the radio off and on
POLL_MS = 1_000           # while Wi-Fi is joining, how often to check it
RADIO_OFF_MS = 2_000      # how long the radio stays off when rejoining
NTP_EVERY_MS = 6 * 3600 * 1000   # re-sync the clock this often (it drifts)
WIFI_COUNTRY = "US"
WIFI_POWER_SAVE_OFF = 0xA11140   # Pico W value that turns Wi-Fi power saving off
CONNECT_TIMEOUT_S = 10
NETWORK_ERRORS = (OSError, MQTTException)

# The server sends UTC Unix seconds (from 1970). The rp2 port's time.time() already counts
# from 1970; some other ports count from 2000, so check instead of assuming.
UNIX_OFFSET = 946684800 if time.gmtime(0)[0] == 2000 else 0

_wlan = None
_client = None            # None while offline
_on_message = None
_clock_ok = False
_radio_off = False        # the radio is switched off, partway through a rejoin
_next_try = 0             # ticks_ms of the next reconnect step
_joined_at = 0            # ticks_ms when the last Wi-Fi join started
_last_ping = 0
_last_ntp = 0


def start(on_message):
    global _wlan, _on_message
    _on_message = on_message
    print("Clock epoch:", time.gmtime(0)[0], "- unix offset", UNIX_OFFSET)
    rp2.country(WIFI_COUNTRY)
    _wlan = network.WLAN(network.STA_IF)
    _join()


def online():
    return _client is not None


def clock_ok():
    return _clock_ok


def unix_time():
    return time.time() + UNIX_OFFSET


def service(busy):
    if _client:
        _check(busy)
    elif not busy and time.ticks_diff(time.ticks_ms(), _next_try) >= 0:
        _reconnect_step()


def _check(busy):
    global _last_ping
    try:
        if not _wlan.isconnected():
            raise OSError("Wi-Fi lost")
        _client.check_msg()   # may call on_message
        if time.ticks_diff(time.ticks_ms(), _last_ping) >= PING_MS:
            _client.ping()
            _last_ping = time.ticks_ms()
    except NETWORK_ERRORS as e:
        _go_offline(e)
        return
    if not busy and time.ticks_diff(time.ticks_ms(), _last_ntp) >= NTP_EVERY_MS:
        _sync_clock()


def _reconnect_step():
    global _radio_off
    if _radio_off:                  # rejoin, part 2: radio back on, start joining
        _radio_off = False
        _join()
    elif _wlan.isconnected():       # Wi-Fi is up: clock, then broker
        _go_online()
    elif time.ticks_diff(time.ticks_ms(), _joined_at) >= JOIN_TIMEOUT_MS:
        # Rejoin, part 1. After the network vanishes, a plain connect() can stay stuck
        # "joining" forever; switching the radio off and on first unsticks it.
        print("Wi-Fi: not joined, switching the radio off and on")
        _wlan.active(False)
        _radio_off = True
        _wait(RADIO_OFF_MS)
    else:
        _wait(POLL_MS)              # still joining


def _join():
    global _joined_at
    print("Wi-Fi: joining", env.WIFI_SSID)
    _wlan.active(True)
    _wlan.config(pm=WIFI_POWER_SAVE_OFF)   # with power saving on, joining the laptop hotspot failed
    _wlan.connect(env.WIFI_SSID, env.WIFI_PASSWORD)   # returns at once; isconnected() says when joined
    _joined_at = time.ticks_ms()
    _wait(POLL_MS)


def _go_online():
    global _client, _last_ping
    print("Wi-Fi: connected,", _wlan.ifconfig()[0])
    _sync_clock()
    gc.collect()   # TLS needs a big block of memory, and reconnecting can leave it fragmented
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_NONE   # encrypted, but the broker's certificate isn't checked yet
    client_id = "shakeawake-" + env.DEVICE_ID   # the server asks EMQX about this id (online or not)
    # Passing an SSLContext makes umqtt send the host name (SNI), which EMQX Serverless requires.
    client = MQTTClient(client_id, env.MQTT_HOST, port=env.MQTT_PORT, user=env.PICO_MQTT_USER,
                        password=env.PICO_MQTT_PASS, keepalive=KEEPALIVE_S, ssl=context)
    client.set_last_will(STATUS_TOPIC, "offline", retain=True)
    client.set_callback(lambda topic, msg: _on_message(topic.decode(), msg.decode()))
    print("MQTT: connecting to", env.MQTT_HOST)
    try:
        client.connect(timeout=CONNECT_TIMEOUT_S)
        client.publish(STATUS_TOPIC, "online", retain=True)
        client.subscribe(CMD_TOPIC)
        for topic in list(ALARM_TOPICS) + [SETTINGS_TOPIC]:
            client.subscribe(topic, qos=1)   # retained, so the saved lists and type arrive right away
    except Exception as e:   # any failure here just means still offline
        _close(client)
        print("MQTT: couldn't connect,", repr(e), "- retrying in", RECONNECT_MS // 1000, "s")
        _wait(RECONNECT_MS)
        return
    print("MQTT: online, listening on", BASE_TOPIC + "#")
    _client = client
    _last_ping = time.ticks_ms()


def _sync_clock():
    global _clock_ok, _last_ntp
    _last_ntp = time.ticks_ms()
    try:
        ntptime.settime()   # sets the clock to UTC; it keeps running while offline
        _clock_ok = True
        print("Time: set,", unix_time(), "UTC")
    except Exception as e:
        print("Time: NTP failed,", repr(e), "- alarms wait for it" if not _clock_ok else "- keeping the old time")


def stop():
    """Says goodbye on purpose (the program is stopping): publishes "offline" and disconnects,
    so the website shows offline at once instead of after the keepalive."""
    global _client
    if _client:
        try:
            _client.publish(STATUS_TOPIC, "offline", retain=True)
            _client.disconnect()
        except Exception:
            pass   # already gone
        _client = None


def _go_offline(error):
    global _client, _joined_at
    print("Offline:", repr(error), "- alarms still work; retrying every", RECONNECT_MS // 1000, "s")
    _close(_client)
    _client = None
    _joined_at = time.ticks_ms()   # give Wi-Fi a chance to come back by itself before a rejoin
    _wait(RECONNECT_MS)


def _wait(ms):
    global _next_try
    _next_try = time.ticks_add(time.ticks_ms(), ms)


def _close(client):
    try:
        client.sock.close()
    except Exception:
        pass   # already closed or never opened
