#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Memulai HeykPrint Enterprise Console Server ==="
node "$DIR/server/server.mjs"
