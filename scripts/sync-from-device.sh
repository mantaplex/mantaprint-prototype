#!/usr/bin/env bash
# ==============================================================================
# MantaPrint - Pull from Device (Read-Only on SBC)
# Synchronizes live code, systemd services, udev rules, and configs to local workspace
# ==============================================================================

set -euo pipefail

HOST="${MANTAPRINT_HOST:-${MANTAPRINT_HUB_HOST:-mantaprint-hub}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "======================================================================"
echo "  Pulling from MantaPrint SBC ($HOST) -> $ROOT_DIR"
echo "  Note: This operation is 100% read-only on the target device."
echo "======================================================================"

mkdir -p "$ROOT_DIR/src/core" \
         "$ROOT_DIR/src/web" \
         "$ROOT_DIR/src/agent" \
         "$ROOT_DIR/src/legacy" \
         "$ROOT_DIR/systemd" \
         "$ROOT_DIR/udev" \
         "$ROOT_DIR/config/avahi"

# 1. Core Python modules
echo "[1/6] Syncing Python core modules..."
rsync -avz "$HOST:/opt/mantaprint/printer_manager.py" "$ROOT_DIR/src/core/"
rsync -avz "$HOST:/opt/mantaprint/image_processor.py" "$ROOT_DIR/src/core/"
rsync -avz "$HOST:/opt/mantaprint/test_image_processor.py" "$ROOT_DIR/src/core/"
rsync -avz "$HOST:/opt/mantaprint/test_page_generator.py" "$ROOT_DIR/src/core/" 2>/dev/null || true

# 2. Web module (Node server & dist)
echo "[2/6] Syncing Web application..."
rsync -avz "$HOST:/opt/mantaprint/web/" "$ROOT_DIR/src/web/"

# 3. Agent module
echo "[3/6] Syncing Agent application..."
rsync -avz "$HOST:/opt/mantaprint/agent/" "$ROOT_DIR/src/agent/"

# 4. Smart Backend module
mkdir -p "$ROOT_DIR/src/backend"
rsync -avz "$HOST:/opt/mantaprint/src/backend/" "$ROOT_DIR/src/backend/" 2>/dev/null || true

# 5. Legacy/auxiliary
echo "[4/6] Syncing legacy templates & server..."
rsync -avz "$HOST:/opt/mantaprint/server.py" "$ROOT_DIR/src/legacy/"
rsync -avz "$HOST:/opt/mantaprint/templates" "$ROOT_DIR/src/legacy/"
rsync -avz "$HOST:/opt/mantaprint/static" "$ROOT_DIR/src/legacy/"

# 5. Systemd, Udev & System
echo "[5/6] Syncing systemd services, udev rules & system components..."
rsync -avz "$HOST:/etc/systemd/system/mantaprint*" "$ROOT_DIR/systemd/"
rsync -avz "$HOST:/etc/udev/rules.d/99-mantaprint-hotplug.rules" "$ROOT_DIR/udev/"
rsync -avz "$HOST:/usr/local/sbin/mantaprint-storage-init.sh" "$ROOT_DIR/systemd/"
mkdir -p "$ROOT_DIR/system/bin" "$ROOT_DIR/system/udev" "$ROOT_DIR/system/keymaps"
rsync -avz "$HOST:/usr/local/bin/mantaprint-hdmi-runner" "$ROOT_DIR/system/bin/" 2>/dev/null || true
rsync -avz "$HOST:/usr/local/bin/mantaprint-hdmi-trigger" "$ROOT_DIR/system/bin/" 2>/dev/null || true
rsync -avz "$HOST:/etc/udev/rules.d/99-hdmi-hotplug.rules" "$ROOT_DIR/system/udev/" 2>/dev/null || true
rsync -avz "$HOST:/etc/rc_keymaps/mantaprint_remote.toml" "$ROOT_DIR/system/keymaps/" 2>/dev/null || true

# 6. Configurations
echo "[6/6] Syncing configuration files..."
rsync -avz "$HOST:/etc/mantaprint/console.json" "$ROOT_DIR/config/"
rsync -avz "$HOST:/etc/avahi/services/mantaprint_web.service" "$ROOT_DIR/config/avahi/"

echo "======================================================================"
echo "  [OK] Successfully synchronized all files to local repository."
echo "======================================================================"
