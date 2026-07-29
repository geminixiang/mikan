#!/bin/sh
set -eu

case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 ;;
  x86_64 | amd64) arch=x86_64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

exec gondolin build \
  --config deploy/docker/gondolin-mikan-sandbox.json \
  --arch "$arch" \
  --tag mikan-sandbox:latest
