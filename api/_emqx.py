# Talks to EMQX Cloud's REST API ({EMQX_API_URL}/...) with the deployment's API key:
# publishes MQTT messages, and asks whether a client (the Pico) is connected.
# No MQTT library: one HTTPS request each. The underscore keeps Vercel from making this a function.
import base64
import json
import os
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

OK_STATUSES = (200, 202)   # 202 = "no matching subscribers", e.g. the Pico is offline. Still published.
TIMEOUT_S = 10


def _request(method, path, body=None):
    """Returns (status, text). Raises RuntimeError if EMQX can't be reached at all."""
    config = {key: os.environ.get(key) for key in ("EMQX_API_URL", "EMQX_API_KEY", "EMQX_API_SECRET")}
    for key, value in config.items():
        if not value:
            raise RuntimeError(key + " is not set")
    login = base64.b64encode(f"{config['EMQX_API_KEY']}:{config['EMQX_API_SECRET']}".encode()).decode()
    headers = {"Authorization": "Basic " + login}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(config["EMQX_API_URL"].rstrip("/") + path, method=method, headers=headers,
                      data=json.dumps(body).encode() if body is not None else None)
    try:
        with urlopen(request, timeout=TIMEOUT_S) as response:
            return response.status, response.read().decode()
    except HTTPError as e:   # EMQX answered, with an error status
        return e.code, e.read().decode(errors="replace")
    except Exception as e:   # network failure: no response at all
        raise RuntimeError(f"Couldn't reach EMQX: {e}")


def publish(topic, payload, retain=False, qos=0):
    """Publishes payload (a dict, sent as JSON) to topic. Returns True if a subscriber (the Pico)
    got it, False if nobody is subscribed right now. Raises RuntimeError if EMQX refuses."""
    status, text = _request("POST", "/publish", {
        "topic": topic, "payload": json.dumps(payload, separators=(",", ":")), "qos": qos, "retain": retain})
    if status not in OK_STATUSES:
        raise RuntimeError(f"EMQX said {status}: {text}")
    return status == 200


def connected(client_id):
    """True if the MQTT client with this id is connected right now (EMQX's Clients API).
    Raises RuntimeError if EMQX can't be asked."""
    status, text = _request("GET", "/clients/" + quote(client_id, safe=""))
    if status == 404:   # EMQX has never seen it, or has forgotten it: not connected
        return False
    if status != 200:
        raise RuntimeError(f"EMQX said {status}: {text}")
    data = json.loads(text)
    if isinstance(data.get("data"), list):   # the docs show both a bare object and {"data": [...]}
        data = data["data"][0] if data["data"] else {}
    return bool(data.get("connected"))
