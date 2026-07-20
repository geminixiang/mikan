#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="https://github.com/kubernetes-sigs/agent-sandbox"
readonly COMMIT="44382bf3134db8a7b44bf6a04cc7026b69dba17c"
readonly SDK_PATH="clients/typescript/agentic-sandbox-client"
readonly OUTPUT_DIR="vendor/agent-sandbox-sdk"
readonly OUTPUT_FILE="agentic-sandbox-client-0.1.0.tgz"
readonly UPSTREAM_SHA256="5434919e2a8c373e8d807ec612bff8b8c558e920285f1be28e2f446316f6ca43"
readonly EXPECTED_SHA256="ad95868b85192ded441390a8e781c13ec0d06bc71729648acc1514912759291b"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

curl --fail --location --silent --show-error \
  "$REPOSITORY/archive/$COMMIT.tar.gz" \
  --output "$work_dir/source.tar.gz"
tar -xzf "$work_dir/source.tar.gz" -C "$work_dir"

sdk_dir="$work_dir/agent-sandbox-$COMMIT/$SDK_PATH"
(
  cd "$sdk_dir"
  npm ci --ignore-scripts
  npm run build
  # PR #976 declares optional OpenTelemetry 1.x peers that conflict with
  # mikan's Sentry-provided OpenTelemetry 2.x packages. Mikan disables the
  # SDK's tracing, so omit those optional SDK-only peers from this package.
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
for (const name of [
  "@opentelemetry/exporter-trace-otlp-grpc",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-trace-node",
]) {
  delete packageJson.peerDependencies[name];
  delete packageJson.peerDependenciesMeta[name];
}
writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
  npm pack --ignore-scripts --pack-destination "$work_dir"
)

actual_sha256="$(shasum -a 256 "$work_dir/$OUTPUT_FILE" | awk '{print $1}')"
if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then
  echo "Unexpected SDK package SHA-256: $actual_sha256" >&2
  echo "Expected: $EXPECTED_SHA256" >&2
  exit 1
fi

mkdir -p "$project_root/$OUTPUT_DIR"
cp "$work_dir/$OUTPUT_FILE" "$project_root/$OUTPUT_DIR/$OUTPUT_FILE"
printf '%s\n' \
  "repository=$REPOSITORY" \
  "commit=$COMMIT" \
  "source_path=$SDK_PATH" \
  "upstream_sha256=$UPSTREAM_SHA256" \
  "packaging_patch=omit optional OpenTelemetry SDK peers; mikan sets enableTracing=false" \
  "sha256=$EXPECTED_SHA256" \
  > "$project_root/$OUTPUT_DIR/SOURCE"

echo "Vendored $OUTPUT_DIR/$OUTPUT_FILE"
