#!/usr/bin/env bash
# Builds Kiln's Linux bundles (.deb and AppImage) inside Docker and copies them to dist-linux/.
#
#   bash scripts/build-linux-docker.sh                           # the host's architecture (arm64 on Apple silicon)
#   PLATFORM=linux/amd64 bash scripts/build-linux-docker.sh      # x86_64, emulated on Apple silicon: much slower
#   BUNDLES=deb bash scripts/build-linux-docker.sh               # skip the AppImage
#
# The repo is mounted read-only and copied inside the container, so the Mac's node_modules,
# dist and src-tauri/target are never touched. Cargo's registry, the Rust build and npm's cache
# live in Docker volumes (kiln-cargo-registry, kiln-linux-bundle-target[-<arch>], kiln-npm-cache)
# so a second run is quick; `docker volume rm` them to start clean.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/dist-linux"
IMAGE="${IMAGE:-kiln-linux-build}"
BUNDLES="${BUNDLES:-deb,appimage}"
PLATFORM="${PLATFORM:-}"
PLATFORM_ARGS=()
ARCH_SUFFIX=""
if [ -n "$PLATFORM" ]; then
  PLATFORM_ARGS=(--platform "$PLATFORM")
  ARCH_SUFFIX="-${PLATFORM##*/}"
fi

command -v docker >/dev/null || { echo "Docker is not installed" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }

echo "==> Building the build image ($IMAGE$ARCH_SUFFIX)"
# rust:1-bookworm, Node 22 from the official image, and what Tauri needs on Debian:
# https://v2.tauri.app/start/prerequisites/#linux (plus `file` and xdg-utils for the AppImage)
docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -t "$IMAGE$ARCH_SUFFIX" - <<'DOCKERFILE'
FROM node:22-bookworm AS node
FROM rust:1-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
      libxdo-dev libssl-dev build-essential curl wget file xdg-utils \
 && rm -rf /var/lib/apt/lists/* \
 && node --version && npm --version
DOCKERFILE

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> Building Kiln ($BUNDLES)"
docker run --rm ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} \
  -v "$ROOT":/src:ro \
  -v "$OUT":/out \
  -v kiln-cargo-registry:/usr/local/cargo/registry \
  -v "kiln-linux-bundle-target$ARCH_SUFFIX":/target \
  -v kiln-npm-cache:/root/.npm \
  -e CARGO_TARGET_DIR=/target \
  -e APPIMAGE_EXTRACT_AND_RUN=1 \
  -e BUNDLES="$BUNDLES" \
  "$IMAGE$ARCH_SUFFIX" bash -c '
    set -euo pipefail
    mkdir -p /work
    # a copy without the host build output; nothing is written back to /src
    tar -C /src \
      --exclude=./node_modules --exclude=./src-tauri/target --exclude=./.git \
      --exclude=./dist --exclude=./dist-linux --exclude=./release \
      -cf - . | tar -C /work -xf -
    cd /work
    npm ci --no-audit --no-fund
    # old bundles in the cached target dir must not be mistaken for this build
    rm -rf /target/release/bundle
    npx tauri build --bundles "$BUNDLES"
    find /target/release/bundle \( -name "*.deb" -o -name "*.AppImage" \) -type f -exec cp {} /out/ \;
  '

echo "==> Bundles in dist-linux/"
ls -lh "$OUT"
ls "$OUT"/*.deb >/dev/null 2>&1 || { echo "No .deb was produced" >&2; exit 1; }
