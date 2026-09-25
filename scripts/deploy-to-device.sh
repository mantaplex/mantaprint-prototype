#!/usr/bin/env bash
# ==============================================================================
# MantaPrint - Safe Deploy to Device
# Deploys code from local workspace to heykprint-ssh with automatic backup
# ==============================================================================

set -euo pipefail

HOST="${MANTAPRINT_HOST:-heykprint-ssh}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

MODULE="${1:-all}"  # options: all, web, agent, core, systemd
DRY_RUN=false
FORCE=false

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -y|--yes)
      FORCE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "======================================================================"
echo "  MANTAPRINT DEPLOYMENT :: Target: $HOST | Module: $MODULE"
echo "======================================================================"

if [ "$DRY_RUN" = true ]; then
  echo "[!] RUNNING IN DRY-RUN MODE (no files will be changed on remote)"
fi

if [ "$FORCE" = false ] && [ "$DRY_RUN" = false ]; then
  read -p "Are you sure you want to deploy '$MODULE' to $HOST? [y/N]: " confirm
  if [[ "$confirm" != [yY] && "$confirm" != [yY][eE][sS] ]]; then
    echo "Deployment cancelled."
    exit 0
  fi
fi

# 1. Create remote backup before overwriting
if [ "$DRY_RUN" = false ]; then
  TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
  BACKUP_DIR="/mnt/data/backups/$TIMESTAMP"
  echo "[1/4] Creating remote backup at $BACKUP_DIR on $HOST..."
  ssh "$HOST" "mkdir -p $BACKUP_DIR && cp -a /opt/mantaprint $BACKUP_DIR/ && cp -a /etc/mantaprint $BACKUP_DIR/ 2>/dev/null || true"
fi

RSYNC_OPTS="-avz"
if [ "$DRY_RUN" = true ]; then
  RSYNC_OPTS="-avzn --dry-run"
fi

# 2. Deploy selected module
echo "[2/4] Syncing files to $HOST..."

deploy_core() {
  echo "Deploying Python core modules..."
  ssh "$HOST" "mkdir -p /opt/mantaprint/core"
  rsync $RSYNC_OPTS "$ROOT_DIR/src/core/" "$HOST:/opt/mantaprint/core/"
  rsync $RSYNC_OPTS "$ROOT_DIR/src/core/" "$HOST:/opt/mantaprint/"
}

deploy_web() {
  echo "Deploying Web server & assets..."
  rsync $RSYNC_OPTS --delete "$ROOT_DIR/src/web/dist/" "$HOST:/opt/mantaprint/web/dist/"
  rsync $RSYNC_OPTS "$ROOT_DIR/src/web/" "$HOST:/opt/mantaprint/web/"
  if [ -f "$ROOT_DIR/version.json" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/version.json" "$HOST:/opt/mantaprint/version.json"
    rsync $RSYNC_OPTS "$ROOT_DIR/version.json" "$HOST:/etc/mantaprint/version.json"
  fi
  if [ -d "$ROOT_DIR/config" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/config/" "$HOST:/opt/mantaprint/config/"
  fi
  if [ "$DRY_RUN" = false ]; then
    ssh "$HOST" "mkdir -p /etc/mantaprint && [ ! -f /etc/mantaprint/config.json ] && cp /opt/mantaprint/config/config.json /etc/mantaprint/config.json || true"
    echo "Restarting mantaprint-web.service..."
    ssh "$HOST" "systemctl restart mantaprint-web.service"
  fi
}

deploy_agent() {
  echo "Deploying Agent module..."
  rsync $RSYNC_OPTS "$ROOT_DIR/src/agent/" "$HOST:/opt/mantaprint/agent/"
  if [ "$DRY_RUN" = false ]; then
    echo "Restarting mantaprint-agent.service..."
    ssh "$HOST" "systemctl restart mantaprint-agent.service"
  fi
}

deploy_systemd() {
  echo "Deploying systemd services & udev rules..."
  rsync $RSYNC_OPTS $ROOT_DIR/systemd/mantaprint*.service "$HOST:/etc/systemd/system/"
  rsync $RSYNC_OPTS "$ROOT_DIR/udev/99-mantaprint-hotplug.rules" "$HOST:/etc/udev/rules.d/"
  if [ -f "$ROOT_DIR/systemd/mantaprint-storage-init.sh" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/systemd/mantaprint-storage-init.sh" "$HOST:/usr/local/sbin/"
    ssh "$HOST" "chmod +x /usr/local/sbin/mantaprint-storage-init.sh 2>/dev/null || true"
  fi
  if [ -d "$ROOT_DIR/system/bin" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/system/bin/" "$HOST:/usr/local/bin/"
    ssh "$HOST" "chmod +x /usr/local/bin/mantaprint-* 2>/dev/null || true"
  fi
  if [ -d "$ROOT_DIR/system/udev" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/system/udev/" "$HOST:/etc/udev/rules.d/"
  fi
  if [ -d "$ROOT_DIR/system/systemd" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/system/systemd/" "$HOST:/etc/systemd/system/"
  fi
  if [ -d "$ROOT_DIR/system/keymaps" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/system/keymaps/" "$HOST:/etc/rc_keymaps/"
  fi
  if [ -d "$ROOT_DIR/system/sysctl" ]; then
    rsync $RSYNC_OPTS "$ROOT_DIR/system/sysctl/" "$HOST:/etc/sysctl.d/"
    if [ "$DRY_RUN" = false ]; then
      ssh "$HOST" "sysctl --system >/dev/null 2>&1 || true"
    fi
  fi
  if [ "$DRY_RUN" = false ]; then
    echo "Reloading systemd daemon and udev rules..."
    ssh "$HOST" "systemctl daemon-reload && udevadm control --reload-rules"
  fi
}

deploy_tui() {
  echo "Deploying TUI console module..."
  rsync $RSYNC_OPTS "$ROOT_DIR/src/tui/" "$HOST:/opt/mantaprint/tui/"
  if [ "$DRY_RUN" = false ]; then
    ssh "$HOST" "chmod +x /opt/mantaprint/tui/app.mjs 2>/dev/null || true"
    echo "Restarting mantaprint-tui.service..."
    ssh "$HOST" "systemctl restart mantaprint-tui.service || true"
  fi
}

deploy_backend() {
  echo "Deploying Smart CUPS backend wrapper..."
  rsync $RSYNC_OPTS "$ROOT_DIR/src/backend/" "$HOST:/opt/mantaprint/src/backend/"
  if [ "$DRY_RUN" = false ]; then
    ssh "$HOST" "make -C /opt/mantaprint/src/backend && cp /opt/mantaprint/src/backend/mantaprint-smart-usb /usr/lib/cups/backend/usb && chmod 0744 /usr/lib/cups/backend/usb && chown root:root /usr/lib/cups/backend/usb"
  fi
}

case "$MODULE" in
  core)
    deploy_core
    ;;
  web)
    deploy_web
    ;;
  tui)
    deploy_tui
    ;;
  agent)
    deploy_agent
    ;;
  backend)
    deploy_backend
    ;;
  systemd|system)
    deploy_systemd
    ;;
  all)
    deploy_core
    deploy_web
    deploy_tui
    deploy_agent
    deploy_backend
    deploy_systemd
    ;;
  *)
    echo "Unknown module: $MODULE (valid options: all, web, tui, agent, core, backend, systemd, system)"
    exit 1
    ;;
esac

echo "[3/4] Verifying remote service status..."
if [ "$DRY_RUN" = false ]; then
  sleep 2
  ssh "$HOST" "systemctl is-active mantaprint-web.service mantaprint-agent.service cups.service mantaprint-tui.service mantaprint-ir.service || true"
fi

echo "======================================================================"
echo "  [OK] Deployment completed."
echo "======================================================================"
