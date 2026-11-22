# Shake Awake commands. Run `make help` to list them.

ifeq ($(OS),Windows_NT)
PYTHON ?= python
PY := .venv/Scripts/python
else
PYTHON ?= python3
PY := .venv/bin/python
endif

PICO_FILES := pico/main.py pico/net.py pico/alarms.py pico/shaker.py pico/env.py
VERCEL := npx --yes vercel@66.6.0   # the Vercel CLI, fetched on first use (also in scripts/upload_secrets.py)

.PHONY: help setup pico-setup run stop logs dev deploy secrets

help: ## List the commands
	@$(PYTHON) -c "import re; [print(f'make {t:12}{d}') for t, d in re.findall(r'^([a-z-]+):.*?## (.*)', open('Makefile').read(), re.M)]"

setup: ## Create .venv, install the Python tools and the web packages
	$(PYTHON) -m venv .venv
	$(PY) -m pip install -r requirements.txt
	npm --prefix web install

pico-setup: ## Install umqtt.simple on the Pico (once per Pico)
	$(PY) -m mpremote mip install umqtt.simple

# `run --no-follow ... + repl` instead of plain `run`: only the REPL passes Ctrl-C
# on to the Pico, so the code's finally block runs and the shaker stops.
run: ## Copy the code to the Pico and run it (Ctrl-C stops it, then Ctrl-] exits)
	$(PY) scripts/gen_pico_env.py
	$(PY) -m mpremote cp $(PICO_FILES) : + run --no-follow pico/main.py + repl

stop: ## Stop whatever is running on the Pico (shaker off)
	$(PY) -m mpremote soft-reset

logs: ## Open the Pico's REPL to see its output (Ctrl-] exits)
	$(PY) -m mpremote repl

dev: ## Run the site and /api locally with Vercel's dev server (no cron; use the Sync button)
	$(VERCEL) dev

deploy: ## Deploy to production from this laptop without pushing to GitHub
	$(VERCEL) deploy --prod

secrets: ## Upload the server's values from .env to Vercel (then redeploy)
	$(PY) scripts/upload_secrets.py
