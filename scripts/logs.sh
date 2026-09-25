#!/usr/bin/env bash
# ==============================================================================
# MantaPrint - Remote Log Viewer / Streamer
# Stream live logs from mantaprint-ssh systemd units
# ==============================================================================

set -euo pipefail

HOST="${MANTAPRINT_HOST:-${MANTAPRINT_HUB_HOST:-mantaprint-hub}}"
SERVICE="${1:-web}"
LINES="${2:-100}"

case "$SERVICE" in
  web)
    UNIT="mantaprint-web.service"
    ;;
  agent)
    UNIT="mantaprint-agent.service"
    ;;
  hotplug)
    UNIT="mantaprint-hotplug.service"
    ;;
  storage)
    UNIT="mantaprint-storage-init.service"
    ;;
  cups)
    UNIT="cups.service"
    ;;
  hdmi)
    UNIT="mantaprint-hdmi.service"
    ;;
  ir)
    UNIT="mantaprint-ir.service"
    ;;
  tui)
    UNIT="mantaprint-tui.service"
    ;;
  all)
    UNIT="mantaprint-web.service mantaprint-agent.service mantaprint-hotplug.service mantaprint-hdmi.service"
    ;;
  *)
    UNIT="$SERVICE"
    ;;
esac

echo "Streaming logs for unit(s): $UNIT from $HOST (last $LINES lines)..."
echo "Press Ctrl+C to stop."
echo "----------------------------------------------------------------------"

UNIT_ARGS=""
for u in $UNIT; do
  UNIT_ARGS="$UNIT_ARGS -u $u"
done

ssh -t "$HOST" "journalctl $UNIT_ARGS -n $LINES -f --output=cat"
