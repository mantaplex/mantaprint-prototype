#!/usr/bin/env bash
# ==============================================================================
# MantaPrint - Remote SBC Live Status Dashboard
# Queries target host for system telemetry and service health
# ==============================================================================

set -euo pipefail

HOST="${1:-${MANTAPRINT_HOST:-heykprint-ssh}}"

echo "======================================================================"
echo "  MANTAPRINT SBC STATUS DASHBOARD :: Target: $HOST"
echo "======================================================================"

ssh -o ConnectTimeout=5 "$HOST" bash << 'EOF'
set -euo pipefail

echo "--- [1] SYSTEM & KERNEL ---"
cat /proc/device-tree/model 2>/dev/null && echo "" || true
uname -sr
uptime -p

echo ""
echo "--- [2] MEMORY & DISK ---"
free -h
echo ""
df -h / /mnt/data /var/log 2>/dev/null || df -h /

echo ""
echo "--- [3] MANTAPRINT SYSTEMD SERVICES ---"
  for svc in mantaprint-web mantaprint-agent mantaprint-storage-init mantaprint-ir mantaprint-tui mantaprint-hdmi mantaprint-hotplug cups avahi-daemon; do
    printf "%-30s : %s\n" "$svc" "$(systemctl is-active $svc 2>/dev/null || echo 'inactive')"
  done

echo ""
echo "--- [4] ACTIVE NODE PROCESSES (MEMORY USAGE) ---"
ps -o pid,user,%cpu,%mem,vsz,rss,cmd -C node 2>/dev/null || echo "No Node processes running"

echo ""
echo "--- [5] CUPS PRINTER STATUS ---"
lpstat -p -d 2>/dev/null || echo "CUPS not reporting printers"

echo ""
echo "--- [6] CONNECTED USB DEVICES ---"
lsusb 2>/dev/null || echo "lsusb unavailable"

echo ""
echo "--- [7] NETWORK INTERFACES ---"
ip -br addr show scope global
EOF

echo "======================================================================"
