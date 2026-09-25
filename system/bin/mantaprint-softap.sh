#!/bin/bash
# ==============================================================================
# MantaPrint Hub - SoftAP Setup Hotspot Controller
# Provides lightweight Out-Of-The-Box (OOBE) Wi-Fi Hotspot for headless onboarding
# Built on native Linux wpa_supplicant AP mode (mode=2) and systemd-networkd DHCP
# ==============================================================================

set -euo pipefail

STATE_DIR="/run/mantaprint"
STATE_FILE="$STATE_DIR/softap.json"
NETWORKD_DIR="/run/systemd/network"
NETWORKD_CONF="$NETWORKD_DIR/10-mantaprint-softap.network"

mkdir -p "$STATE_DIR"
mkdir -p "$NETWORKD_DIR"

# 1. Dynamically discover active Wi-Fi interface
get_wifi_iface() {
    local iface=""
    if [ -d /sys/class/net ]; then
        for n in /sys/class/net/*; do
            local base
            base=$(basename "$n")
            case "$base" in
                wlan*|wlp*|wls*|wl*|ra*)
                    iface="$base"
                    break
                    ;;
            esac
        done
    fi
    echo "${iface:-wlan0}"
}

# 2. Get 4-character machine suffix
get_machine_suffix() {
    if [ -f /etc/machine-id ]; then
        tail -c 5 /etc/machine-id | tr -d '\n' | tr '[:lower:]' '[:upper:]'
    else
        local wifi_dev
        wifi_dev=$(get_wifi_iface)
        if [ -f "/sys/class/net/$wifi_dev/address" ]; then
            tr -d ':' < "/sys/class/net/$wifi_dev/address" | tail -c 5 | tr -d '\n' | tr '[:lower:]' '[:upper:]'
        else
            echo "SETUP"
        fi
    fi
}

start_softap() {
    local wifi_dev
    wifi_dev=$(get_wifi_iface)
    local suffix
    suffix=$(get_machine_suffix)
    local ssid="${1:-MantaPrint-Setup-$suffix}"

    echo "[*] Activating SoftAP Hotspot on $wifi_dev (SSID: $ssid)..."

    # Ensure rfkill unblocked and isolate from NetworkManager interference
    rfkill unblock wifi 2>/dev/null || true
    nmcli dev set "$wifi_dev" managed no 2>/dev/null || true
    ip link set "$wifi_dev" up 2>/dev/null || true

    # Configure wpa_supplicant into AP mode (mode=2)
    # Check if network already exists
    local net_id
    net_id=$(wpa_cli -i "$wifi_dev" add_network 2>/dev/null | tail -n 1 || true)
    if [ -z "$net_id" ] || ! echo "$net_id" | grep -qE '^[0-9]+$'; then
        # Fallback without -i
        net_id=$(wpa_cli add_network 2>/dev/null | tail -n 1 || echo 0)
    fi

    wpa_cli -i "$wifi_dev" set_network "$net_id" mode 2 2>/dev/null || true
    wpa_cli -i "$wifi_dev" set_network "$net_id" ssid "\"$ssid\"" 2>/dev/null || true
    wpa_cli -i "$wifi_dev" set_network "$net_id" key_mgmt NONE 2>/dev/null || true
    wpa_cli -i "$wifi_dev" set_network "$net_id" frequency 2412 2>/dev/null || true
    wpa_cli -i "$wifi_dev" select_network "$net_id" 2>/dev/null || true

    # Assign static gateway IP (192.168.4.1/24)
    ip addr flush dev "$wifi_dev" 2>/dev/null || true
    ip addr add 192.168.4.1/24 dev "$wifi_dev" 2>/dev/null || true

    # Write systemd-networkd DHCP server configuration
    cat <<EOF > "$NETWORKD_CONF"
[Match]
Name=$wifi_dev

[Network]
Address=192.168.4.1/24
DHCPServer=yes

[DHCPServer]
PoolOffset=10
PoolSize=50
EmitDNS=yes
DNS=192.168.4.1
EOF

    # Reload networkd to activate DHCP server
    networkctl reload 2>/dev/null || systemctl restart systemd-networkd 2>/dev/null || true

    # Record state
    cat <<EOF > "$STATE_FILE"
{
  "active": true,
  "ssid": "$ssid",
  "ip": "192.168.4.1",
  "interface": "$wifi_dev",
  "net_id": "$net_id",
  "started_at": $(date +%s)
}
EOF

    echo "[OK] SoftAP Hotspot active: SSID '$ssid' at 192.168.4.1"
}

stop_softap() {
    local wifi_dev
    wifi_dev=$(get_wifi_iface)

    echo "[*] Deactivating SoftAP Hotspot on $wifi_dev..."

    # Read previous net_id if available
    local net_id=""
    if [ -f "$STATE_FILE" ]; then
        net_id=$(grep -o '"net_id": "[0-9]*"' "$STATE_FILE" | cut -d'"' -f4 || true)
    fi

    if [ -n "$net_id" ]; then
        wpa_cli -i "$wifi_dev" remove_network "$net_id" 2>/dev/null || true
    fi

    # Remove networkd DHCP config
    rm -f "$NETWORKD_CONF"
    networkctl reload 2>/dev/null || true

    # Restore client mode
    ip addr flush dev "$wifi_dev" 2>/dev/null || true
    nmcli dev set "$wifi_dev" managed yes 2>/dev/null || true
    wpa_cli -i "$wifi_dev" reassociate 2>/dev/null || true

    # Update state file
    cat <<EOF > "$STATE_FILE"
{
  "active": false,
  "ssid": null,
  "ip": null,
  "interface": "$wifi_dev",
  "stopped_at": $(date +%s)
}
EOF

    echo "[OK] SoftAP Hotspot deactivated."
}

status_softap() {
    if [ -f "$STATE_FILE" ]; then
        cat "$STATE_FILE"
    else
        local wifi_dev
        wifi_dev=$(get_wifi_iface)
        cat <<EOF
{
  "active": false,
  "ssid": null,
  "ip": null,
  "interface": "$wifi_dev"
}
EOF
    fi
}

case "${1:-status}" in
    start)
        start_softap "${2:-}"
        ;;
    stop)
        stop_softap
        ;;
    status)
        status_softap
        ;;
    toggle)
        if [ -f "$STATE_FILE" ] && grep -q '"active": true' "$STATE_FILE"; then
            stop_softap
        else
            start_softap "${2:-}"
        fi
        ;;
    *)
        echo "Usage: $0 {start [ssid]|stop|status|toggle}"
        exit 1
        ;;
esac
