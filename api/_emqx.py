import base64
import json
import os
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

CONFIG_KEYS = ("EMQX_API_URL", "EMQX_API_KEY", "EMQX_API_SECRET")
OK_STATUSES = (200, 202)
TIMEOUT_S = 10


def _request(method, path, body=None):
    for key in CONFIG_KEYS:
        if not os.environ.get(key):
            raise RuntimeError(key + " is not set")
    url, key, secret = (os.environ[name] for name in CONFIG_KEYS)
    login = base64.b64encode(f"{key}:{secret}".encode()).decode()
    request = Request(url.rstrip("/") + path, method=method,
                      headers={"Authorization": "Basic " + login, "Content-Type": "application/json"},
                      data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(request, timeout=TIMEOUT_S) as response:
            return response.status, response.read().decode()
    except HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        raise RuntimeError(f"Couldn't reach EMQX: {e}")


def publish(topic, payload, retain=False, qos=0):
    status, text = _request("POST", "/publish", {
        "topic": topic, "payload": json.dumps(payload, separators=(",", ":")), "qos": qos, "retain": retain})
    if status not in OK_STATUSES:
        raise RuntimeError(f"EMQX said {status}: {text}")
    return status == 200


def connected(client_id):
    status, text = _request("GET", "/clients/" + quote(client_id, safe=""))
    if status == 404:
        return False
    if status != 200:
        raise RuntimeError(f"EMQX said {status}: {text}")
    client = json.loads(text)
    if isinstance(client.get("data"), list):
        client = (client["data"] or [{}])[0]
    return bool(client.get("connected"))
