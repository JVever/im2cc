#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

echo "[smoke] lint"
npm run lint

echo "[smoke] build"
npm run build

echo "[smoke] cli help"
node dist/bin/im2cc.js >/dev/null

echo "[smoke] ok"
