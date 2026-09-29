#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke-sandbox-image.sh <image>}"
home_volume="mikan-smoke-home-$$"

cleanup() {
  docker volume rm -f "$home_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

run_tools() {
  docker run --rm --tmpfs /root "$@" "$image" sh -c '
    set -e
    for tool in node npm npx corepack bun bunx uv uvx gh gws gcloud gsutil bq sentry-cli keyring yt-dlp agent-browser chromium git rg fd ffmpeg jq; do
      command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
    done
    node --version
    bun --version
    uv --version
    gcloud --version | head -1
    yt-dlp --version
    keyring --list-backends >/dev/null
    agent-browser --version
    chromium --version
  '
}

echo "== tools with an empty /root"
run_tools

echo "== user installs land in /root/.local and stay on PATH"
docker run --rm -v "$home_volume:/root" "$image" sh -c '
  set -e
  npm install -g --silent cowsay >/dev/null
  test "$(command -v cowsay)" = /root/.local/bin/cowsay
  uv tool install --quiet ruff >/dev/null
  test "$(command -v ruff)" = /root/.local/bin/ruff
'
docker run --rm -v "$home_volume:/root" "$image" sh -c 'cowsay ok >/dev/null && ruff --version >/dev/null'

echo "== apt installs work under the provisioner's hardening"
docker run --rm --tmpfs /root --cap-drop ALL --security-opt no-new-privileges "$image" sh -c '
  set -e
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends sqlite3 >/dev/null
  command -v sqlite3 >/dev/null
'

echo "== CJK text renders and Python packages install through uv"
docker run --rm "$image" sh -c '
  set -e
  test -n "$(fc-list :lang=zh-tw)"
  test -n "$(fc-list :lang=ja)"
  cd /tmp && echo "import six" > probe.py && uv run -q --with six probe.py
  pip install six 2>&1 | grep -q "uv run --with"
'

echo "== agent-browser drives chromium"
docker run --rm --tmpfs /root "$image" sh -c '
  set -e
  agent-browser open "data:text/html,<title>smoke</title>" >/dev/null
  test "$(agent-browser get title)" = smoke
  agent-browser close >/dev/null
'

echo "smoke ok: $image"
