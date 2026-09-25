#!/usr/bin/env bash
# ==============================================================================
# MantaPool / MantaMan Fleet Controller Installer (PROTOTYPE)
#
# PROTOTYPE - NOT FOR PRODUCTION OR SENSITIVE DATA. See docs/PROTOTYPE-NOTICE.txt.
# Non-interactive installs: sudo ./install-mantaman.sh --accept-prototype-risk
# Automated Setup for Debian / Ubuntu / Armbian Server Environments
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}==================================================================${NC}"
echo -e "${BLUE}🌊 MantaPool Fleet Controller Installer :: ${YELLOW}PROTOTYPE${BLUE} (not for production)${NC}"
echo -e "${BLUE}==================================================================${NC}"

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERROR] This installer must be executed as root (use sudo).${NC}"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="/opt/mantaman"
DATA_DIR="/var/lib/mantaman"

# Prototype risk acknowledgement (nothing has been changed on the system before this point)
# shellcheck source=../../scripts/lib/prototype-gate.sh
. "$REPO_ROOT/scripts/lib/prototype-gate.sh"
MANTAPOOL_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$SCRIPT_DIR/version.json" 2>/dev/null | head -1)"
prototype_gate "MantaPool" "v${MANTAPOOL_VERSION:-unknown}" \
    "$REPO_ROOT/docs/PROTOTYPE-NOTICE.txt" /etc/mantapool/prototype-ack.json "$@"

# 1. Check Node.js
echo -e "${BLUE}[1/5] Verifying Node.js Runtime...${NC}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
    echo "  Installing Node.js 20 LTS from official NodeSource repository..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "  Using Node.js $(node -v)"

# 2. Create System User
echo -e "${BLUE}[2/5] Configuring Service Identity...${NC}"
if ! id -u mantaman >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" -m mantaman
    echo "  Created system user 'mantaman'"
fi

# 3. Deploy Artifacts
echo -e "${BLUE}[3/5] Deploying Application Files to ${INSTALL_DIR}...${NC}"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
cp -r "$SCRIPT_DIR"/server "$INSTALL_DIR"/
cp -r "$SCRIPT_DIR"/package*.json "$INSTALL_DIR"/
if [ -f "$SCRIPT_DIR"/version.json ]; then
    cp "$SCRIPT_DIR"/version.json "$INSTALL_DIR"/
fi
if [ -f "$SCRIPT_DIR"/mantaprint.png ]; then
    cp "$SCRIPT_DIR"/mantaprint.png "$INSTALL_DIR"/
fi
mkdir -p "$DATA_DIR"/backups

# If frontend dist exists in repo, copy it
if [ -d "$SCRIPT_DIR"/server/dist ]; then
    cp -r "$SCRIPT_DIR"/server/dist "$INSTALL_DIR"/server/
elif [ -d "$SCRIPT_DIR"/frontend/dist ]; then
    mkdir -p "$INSTALL_DIR"/server/dist
    cp -r "$SCRIPT_DIR"/frontend/dist/* "$INSTALL_DIR"/server/dist/
fi

cd "$INSTALL_DIR"
npm ci --only=production 2>/dev/null || npm install --production

chown -R mantaman:mantaman "$INSTALL_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# 4. Install Systemd Service
echo -e "${BLUE}[4/5] Installing & Enabling Systemd Unit...${NC}"
if [ -f "$SCRIPT_DIR"/systemd/mantaman.service ]; then
    cp "$SCRIPT_DIR"/systemd/mantaman.service /etc/systemd/system/mantapool.service
    ln -sf /etc/systemd/system/mantapool.service /etc/systemd/system/mantaman.service
    systemctl daemon-reload
    systemctl enable --now mantapool.service
fi

# 5. Summary
IP_ADDR="$(hostname -I | awk '{print $1}')"
echo -e "${GREEN}==================================================================${NC}"
echo -e "${GREEN}✔ MantaPool Fleet Controller installed and active!${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "Web Console:       ${BLUE}http://${IP_ADDR}:8443${NC}"
echo -e "Agent WebSocket:   ${BLUE}ws://${IP_ADDR}:8443/ws/agent${NC}"
echo -e "Default Admin:     ${YELLOW}admin${NC} / ${YELLOW}mantaprint2026!${NC}"
echo -e "Service Control:   ${BLUE}systemctl status mantapool${NC}"
echo -e "Live Logs:         ${BLUE}journalctl -u mantapool -f${NC}"
echo -e "=================================================================="
prototype_post_notice "MantaPool" "admin" "mantaprint2026!"
