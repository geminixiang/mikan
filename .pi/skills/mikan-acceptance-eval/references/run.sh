#!/bin/bash
# usage: run.sh <checkout-to-evaluate> <out.json> [<checkout-that-creates-upgrade-state>]
# Lives in .workspace/<topic>-eval/; the upgrade case is the test whose name contains "upgrade".
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
MIKAN=$(cd "$HERE/../.." && pwd)
TARGET=$(cd "$1" && pwd); OUT=$2; CREATOR=$(cd "${3:-$1}" && pwd)
UP=$(mktemp -d)/upgrade
cd "$MIKAN"
MIKAN_REPO=$CREATOR EVAL_UPGRADE_DIR=$UP EVAL_UPGRADE_PHASE=create npx vitest --run --config "$HERE/vitest.config.ts" -t upgrade >/dev/null 2>&1
MIKAN_REPO=$TARGET EVAL_UPGRADE_DIR=$UP EVAL_UPGRADE_PHASE=read EVAL_OUT=$OUT npx vitest --run --config "$HERE/vitest.config.ts" 2>&1 | grep -E "Tests |×|Error" || true
rm -rf "$(dirname "$UP")"
