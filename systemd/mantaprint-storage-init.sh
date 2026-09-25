#!/bin/bash
# ==============================================================================
# MantaPrint Hub - Plug-and-Play Storage Tiering Initializer Wrapper
# Delegates to mantaprint-storage-manager.sh
# ==============================================================================

if [ -x /usr/local/bin/mantaprint-storage-manager.sh ]; then
    exec /usr/local/bin/mantaprint-storage-manager.sh init "$@"
elif [ -x /usr/local/sbin/mantaprint-storage-manager.sh ]; then
    exec /usr/local/sbin/mantaprint-storage-manager.sh init "$@"
else
    # Fallback if manager not yet in PATH
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -x "$DIR/mantaprint-storage-manager.sh" ]; then
        exec "$DIR/mantaprint-storage-manager.sh" init "$@"
    fi
fi

echo "[ERROR] mantaprint-storage-manager.sh not found!" >&2
exit 1
