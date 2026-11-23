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
MQTT_PORT = 8883
KEEPALIVE_S = 20
PING_MS = 15_000
RECONNECT_MS = 10_000
CONNECT_TIMEOUT_S = 10
JOIN_TIMEOUT_MS = 30_000
POLL_MS = 1_000
RADIO_OFF_MS = 2_000
NTP_EVERY_MS = 6 * 3600 * 1000
WIFI_COUNTRY = "US"
WIFI_POWER_SAVE_OFF = 0xA11140

clock_ok = False
_wlan = None
_client = None
_on_message = None
_radio_off = False
_next_try = 0
_joined_at = 0
_last_ping = 0
_last_ntp = 0


def start(on_message):
    global _wlan, _on_message
    _on_message = on_message
    rp2.country(WIFI_COUNTRY)
    _wlan = network.WLAN(network.STA_IF)
    _join()


def service(busy):
    if _client:
        _check(busy)
    elif not busy and time.ticks_diff(time.ticks_ms(), _next_try) >= 0:
        _reconnect_step()


def stop():
    global _client
    if _client:
        try:
            _client.publish(STATUS_TOPIC, "offline", retain=True)
            _client.disconnect()
        except Exception:
            pass
        _client = None


def _check(busy):
    global _last_ping
    try:
        if not _wlan.isconnected():
            raise OSError("Wi-Fi lost")
        _client.check_msg()
        if time.ticks_diff(time.ticks_ms(), _last_ping) >= PING_MS:
            _client.ping()
            _last_ping = time.ticks_ms()
    except (OSError, MQTTException) as e:
        _go_offline(e)
        return
    if not busy and time.ticks_diff(time.ticks_ms(), _last_ntp) >= NTP_EVERY_MS:
        _sync_clock()


def _reconnect_step():
    global _radio_off
    if _radio_off:
        _radio_off = False
        _join()
    elif _wlan.isconnected():
        _go_online()
    elif time.ticks_diff(time.ticks_ms(), _joined_at) >= JOIN_TIMEOUT_MS:
        print("Wi-Fi: not joined, switching the radio off and on")
        _wlan.active(False)
        _radio_off = True
        _wait(RADIO_OFF_MS)
    else:
        _wait(POLL_MS)


def _join():
    global _joined_at
    print("Wi-Fi: joining", env.WIFI_SSID)
    _wlan.active(True)
    _wlan.config(pm=WIFI_POWER_SAVE_OFF)
    _wlan.connect(env.WIFI_SSID, env.WIFI_PASSWORD)
    _joined_at = time.ticks_ms()
    _wait(POLL_MS)


def _go_online():
    global _client, _last_ping
    print("Wi-Fi: connected,", _wlan.ifconfig()[0])
    _sync_clock()
    gc.collect()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_NONE
    client = MQTTClient("shakeawake-" + env.DEVICE_ID, env.MQTT_HOST, port=MQTT_PORT, user=env.PICO_MQTT_USER,
                        password=env.PICO_MQTT_PASS, keepalive=KEEPALIVE_S, ssl=context)
    client.set_last_will(STATUS_TOPIC, "offline", retain=True)
    client.set_callback(lambda topic, msg: _on_message(topic.decode()[len(BASE_TOPIC):], msg.decode()))
    print("MQTT: connecting to", env.MQTT_HOST)
    try:
        client.connect(timeout=CONNECT_TIMEOUT_S)
        client.publish(STATUS_TOPIC, "online", retain=True)
        client.subscribe(BASE_TOPIC + "#", qos=1)
    except Exception as e:
        _close(client)
        print("MQTT: couldn't connect,", repr(e), "- retrying in", RECONNECT_MS // 1000, "s")
        _wait(RECONNECT_MS)
        return
    print("MQTT: online, listening on", BASE_TOPIC + "#")
    _client = client
    _last_ping = time.ticks_ms()


def _sync_clock():
    global clock_ok, _last_ntp
    _last_ntp = time.ticks_ms()
    try:
        ntptime.settime()
        clock_ok = True
        print("Time: set,", time.time(), "UTC")
    except Exception as e:
        print("Time: NTP failed,", repr(e), "- keeping the old time" if clock_ok else "- alarms wait for it")


def _go_offline(error):
    global _client, _joined_at
    print("Offline:", repr(error), "- alarms still work; retrying every", RECONNECT_MS // 1000, "s")
    _close(_client)
    _client = None
    _joined_at = time.ticks_ms()
    _wait(RECONNECT_MS)


def _wait(ms):
    global _next_try
    _next_try = time.ticks_add(time.ticks_ms(), ms)


def _close(client):
    try:
        client.sock.close()
    except Exception:
        pass
