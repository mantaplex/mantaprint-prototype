#!/usr/bin/env bash
# ==============================================================================
# MantaPrint Hub - Fujitsu ScanSnap S1300 / S1300i Firmware Provisioner
# ==============================================================================
# The Fujitsu ScanSnap S1300 and S1300i scanners require proprietary microcode
# (.nal firmware) to initialize their onboard image sensor and ASIC over USB.
#
# Firmware files required by SANE sane-epjitsu backend:
#   - S1300  (USB ID 04c5:11ed) -> /usr/share/sane/epjitsu/1300_0C26.nal
#   - S1300i (USB ID 04c5:128d) -> /usr/share/sane/epjitsu/1300i_0D12.nal
# ==============================================================================

set -euo pipefail

TARGET_DIR="/usr/share/sane/epjitsu"

echo "=================================================="
echo " MantaPrint ScanSnap Firmware Provisioner"
echo "=================================================="

if [ "$(id -u)" -ne 0 ]; then
    echo "[!] Error: This script must be run as root (use sudo)."
    exit 1
fi

mkdir -p "$TARGET_DIR"
chmod 755 "$TARGET_DIR"

# Check if input path is provided
if [ $# -ge 1 ]; then
    SRC="$1"
    if [ -f "$SRC" ]; then
        FNAME=$(basename "$SRC")
        TARGET_NAME="$FNAME"
        # Normalize uppercase/lowercase variations expected by SANE epjitsu
        if [[ "${FNAME,,}" == "1300_0c26.nal" ]]; then
            TARGET_NAME="1300_0C26.nal"
        elif [[ "${FNAME,,}" == "1300i_0d12.nal" ]]; then
            TARGET_NAME="1300i_0D12.nal"
        fi
        
        SIZE=$(stat -c%s "$SRC" 2>/dev/null || stat -f%z "$SRC" 2>/dev/null || echo "0")
        if [ "$SIZE" -lt 10000 ]; then
            echo "[!] Warning: $SRC is unusually small ($SIZE bytes). Firmware files are usually ~40KB-120KB."
        fi

        cp "$SRC" "$TARGET_DIR/$TARGET_NAME"
        chmod 644 "$TARGET_DIR/$TARGET_NAME"
        echo "[+] Successfully installed firmware: $TARGET_DIR/$TARGET_NAME"
    elif [ -d "$SRC" ]; then
        for f in "$SRC"/*.[nN][aA][lL]; do
            [ -e "$f" ] || continue
            BNAME=$(basename "$f")
            TARGET_NAME="$BNAME"
            if [[ "${BNAME,,}" == "1300_0c26.nal" ]]; then
                TARGET_NAME="1300_0C26.nal"
            elif [[ "${BNAME,,}" == "1300i_0d12.nal" ]]; then
                TARGET_NAME="1300i_0D12.nal"
            fi
            cp "$f" "$TARGET_DIR/$TARGET_NAME"
            chmod 644 "$TARGET_DIR/$TARGET_NAME"
            echo "[+] Installed: $TARGET_DIR/$TARGET_NAME"
        done
    fi
fi

# Ensure /etc/sane.d/epjitsu.conf points to /usr/share/sane/epjitsu
EPJITSU_CONF="/etc/sane.d/epjitsu.conf"
if [ -f "$EPJITSU_CONF" ]; then
    if ! grep -q "firmware /usr/share/sane/epjitsu" "$EPJITSU_CONF" 2>/dev/null; then
        echo "" >> "$EPJITSU_CONF"
        echo "# MantaPrint Fujitsu ScanSnap S1300 / S1300i firmware mappings" >> "$EPJITSU_CONF"
        echo "firmware /usr/share/sane/epjitsu/1300_0C26.nal" >> "$EPJITSU_CONF"
        echo "firmware /usr/share/sane/epjitsu/1300i_0D12.nal" >> "$EPJITSU_CONF"
        echo "[+] Configured SANE firmware path in $EPJITSU_CONF"
    fi
fi

# Verify existing firmware status
echo ""
echo "[*] Current firmware status in $TARGET_DIR:"
for FW in "1300_0C26.nal" "1300i_0D12.nal"; do
    if [ -f "$TARGET_DIR/$FW" ]; then
        SIZE=$(stat -c%s "$TARGET_DIR/$FW" 2>/dev/null || stat -f%z "$TARGET_DIR/$FW" 2>/dev/null || echo "OK")
        echo "  - $FW: [PRESENT] ($SIZE bytes, mode $(stat -c%a "$TARGET_DIR/$FW" 2>/dev/null || echo "644"))"
    else
        echo "  - $FW: [MISSING] (Fujitsu ScanSnap $([ "$FW" == "1300_0C26.nal" ] && echo "S1300" || echo "S1300i") requires this file)"
    fi
done

echo ""
echo "To install missing firmware, place the .nal file from the original driver CD"
echo "or extract it from the Windows installer, then run:"
echo "  sudo $0 /path/to/firmware.nal"
echo "=================================================="
