from machine import Pin, PWM
import math
import time

PIN = 15
MAX_STRENGTH = 1.0
PATTERNS = {
    "classic": {"freq": 45, "steps": [(1, 1, 300), (0, 0, 300), (1, 1, 300), (0, 0, 300), (1, 1, 1500), (0, 0, 1000)]},
    "waves":   {"freq": 60, "steps": [(0, 1, 2000), (1, 0, 2000)]},
    "rise":    {"freq": 45, "steps": [(0, 1, 20000), (1, 1, 580000)],
                "test_steps": [(0, 1, 10000), (1, 1, 590000)]},
    "knock":   {"freq": 45, "steps": [(1, 1, 120), (0, 0, 120), (1, 1, 120), (0, 0, 120), (1, 1, 120), (0, 0, 900)]},
}
DEFAULT = "classic"

_pwm = PWM(Pin(PIN))
_pwm.duty_u16(0)
_steps = None
_length = 0
_start = 0


def start(name, test=False):
    global _steps, _length, _start
    pattern = PATTERNS.get(name) or PATTERNS[DEFAULT]
    _pwm.freq(pattern["freq"])
    _steps = pattern.get("test_steps", pattern["steps"]) if test else pattern["steps"]
    _length = sum(step[2] for step in _steps)
    _start = time.ticks_ms()
    update()


def stop():
    global _steps
    _steps = None
    _pwm.duty_u16(0)


def update():
    if _steps is None:
        return
    t = time.ticks_diff(time.ticks_ms(), _start) % _length
    for begin, end, ms in _steps:
        if t < ms:
            break
        t -= ms
    eased = (1 - math.cos(math.pi * t / ms)) / 2
    _pwm.duty_u16(_strength_to_duty(begin + (end - begin) * eased))


def _strength_to_duty(strength):
    strength = max(0.0, min(MAX_STRENGTH, strength))
    return int(math.asin(strength) / math.pi * 65535)
