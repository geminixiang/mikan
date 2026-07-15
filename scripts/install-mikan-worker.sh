#!/bin/sh
#
# Install the mikan-worker binary. Downloads the matching static binary from a
# GitHub release and verifies its checksum; falls back to building from source
# when run inside a mikan checkout (or when a release carries no binary yet).
#
#   curl -fsSL https://raw.githubusercontent.com/geminixiang/mikan/main/scripts/install-mikan-worker.sh | sh
#
# Environment:
#   MIKAN_WORKER_VERSION   release tag to install (default: latest)
#   MIKAN_WORKER_PREFIX    install directory (default: /usr/local/bin)
#   MIKAN_REPO             owner/repo (default: geminixiang/mikan)
set -eu

repo="${MIKAN_REPO:-geminixiang/mikan}"
prefix="${MIKAN_WORKER_PREFIX:-/usr/local/bin}"
version="${MIKAN_WORKER_VERSION:-latest}"

say() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

detect_platform() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux | darwin) ;;
    *) die "unsupported OS: $os (mikan-worker runs on Linux or macOS)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch="amd64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac
  printf '%s_%s' "$os" "$arch"
}

resolve_tag() {
  if [ "$version" != "latest" ]; then
    printf '%s' "$version"
    return
  fi
  # follow the redirect from /releases/latest to read the tag
  curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$repo/releases/latest" 2>/dev/null | sed 's#.*/tag/##'
}

install_binary() {
  platform="$1"
  tag="$2"
  base="https://github.com/$repo/releases/download/$tag"
  asset="mikan-worker_${tag}_${platform}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "› downloading $asset ($tag)"
  if ! curl -fsSL -o "$tmp/mikan-worker" "$base/$asset"; then
    return 1
  fi
  if curl -fsSL -o "$tmp/sums" "$base/mikan-worker_${tag}_SHA256SUMS.txt" 2>/dev/null; then
    say "› verifying checksum"
    ( cd "$tmp" && grep " $asset\$" sums | sha256sum -c - >/dev/null 2>&1 ) \
      || die "checksum verification failed for $asset"
  else
    say "› warning: no SHA256SUMS.txt in the release; skipping checksum"
  fi
  install_to "$tmp/mikan-worker"
}

build_from_source() {
  root="$1"
  command -v go >/dev/null 2>&1 || return 1
  say "› building mikan-worker from source in $root/worker"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  ( cd "$root/worker" && CGO_ENABLED=0 go build -o "$tmp/mikan-worker" ./cmd/mikan-worker )
  install_to "$tmp/mikan-worker"
}

install_to() {
  src="$1"
  chmod +x "$src"
  if [ -w "$prefix" ] || [ "$(id -u)" = "0" ]; then
    install -m 0755 "$src" "$prefix/mikan-worker"
  else
    say "› $prefix is not writable; installing with sudo"
    sudo install -m 0755 "$src" "$prefix/mikan-worker"
  fi
  say "✓ installed $("$prefix/mikan-worker" version 2>/dev/null || echo mikan-worker) to $prefix/mikan-worker"
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || say "› note: sha256sum missing, checksums cannot be verified"

platform="$(detect_platform)"

# Inside a checkout, prefer building from source (works before a release carries
# binaries and always matches the tree).
script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo '')"
if [ -n "$script_dir" ] && [ -f "$script_dir/../worker/go.mod" ]; then
  repo_root="$(cd "$script_dir/.." && pwd)"
  build_from_source "$repo_root" && exit 0
  say "› source build unavailable, trying the release binary"
fi

tag="$(resolve_tag)"
[ -n "$tag" ] || die "could not resolve a release tag"
if install_binary "$platform" "$tag"; then
  exit 0
fi
die "no mikan-worker binary for $platform in release $tag (cut a release with the worker CD, or run this from a checkout with Go installed)"
