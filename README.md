# Shake Awake

A silent alarm that wakes you by shaking your bed instead of making noise.

## Why
Sound alarms wake everyone in the room, and some people sleep right through them. Shake Awake
puts a small vibration motor under your mattress that shakes only you awake, quietly, at the
right time.

## What it does
- **Wakes you from your calendar.** Every day it looks at the next week of your calendar and sets
  an alarm a chosen time before your first event each day.
- **Custom alarms.** Pick any date and time from your phone.
- **Four vibration styles.** Classic, Waves, Rise and Knock. Try each one from your phone.
- **Works without internet.** Alarms are saved on the device itself, so they still go off if the
  Wi-Fi drops.
- **One phone app, password-protected.** Add it to your home screen like any app.

## The parts
- A small computer (Raspberry Pi Pico) under the bed that drives the shaker through an amplifier.
- A website you open on your phone to set alarms.
- A small online server that passes your phone's commands to the device.

Team final project for Northeastern's Cornerstone of Engineering.

## How to run it

### Using it day to day
1. Plug in the shaker's power.
2. Open the Shake Awake website on your phone, type the password and slide to unlock. Your phone
   remembers it after that.
3. Turn the knob to choose a vibration style and press its center to set it. Set a custom alarm,
   press Try to feel it, or Stop to stop it. The faders button opens Settings: calendar link, how
   early to wake, and how long an alarm lasts.

### For the team (on the laptop)
You need Python 3, Node and Make. Run every command from this folder.

First time only:
```
cp .env.example .env     # then fill in the passwords and links
make setup               # installs the tools
make pico-setup          # with the Pico plugged in
```

Then:

| Command | Does |
|---|---|
| `make run` | copies the code to the Pico and starts it (Ctrl-C stops it, Ctrl-] exits) |
| `make stop` | stops the Pico |
| `make logs` | shows what the Pico is printing |
| `make dev` | runs the website on this laptop |
| `make secrets` | sends the server's passwords to Vercel |
| `make help` | lists every command |

Pushing to the `main` branch on GitHub updates the website by itself.

How the code works, and the full first-time setup (accounts, keys, deploys): [DEV_README.md](DEV_README.md).
