#!/usr/bin/env bash
set -euo pipefail

Xvfb "$DISPLAY" -screen 0 "${MIKAN_SCREEN_SIZE:-1920x1080x24}" -nolisten tcp &
exec uvicorn --app-dir /opt/mikan-runtime server:app --host 0.0.0.0 --port 8888
