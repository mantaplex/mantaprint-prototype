#!/bin/bash
# ==============================================================================
# MantaPrint Hub - Adaptive Storage Tiering & Hot-Swap Manager
# Zero-eMMC Wear Guarantee with Dynamic Multi-Storage & Auto-Fallback
#
# Commands:
#   init                : Boot-time initialization (mount external or activate fallback)
#   handle-plug <dev>   : Handle insertion of MicroSD or USB drive
#   handle-unplug <dev> : Handle surprise removal of storage media
#   check-health        : Canary test / periodic health check
#   status              : Display formatted status JSON
# ==============================================================================

set -eo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

MOUNT_POINT="/mnt/data"
CUPS_SPOOL="/var/spool/cups"
STATE_DIR="/run/mantaprint"
STATE_FILE="/run/mantaprint/storage.json"
LOCK_FILE="/run/mantaprint-storage.lock"
LABEL_NAME="MANTADATA"
LEGACY_LABEL="HEYKDATA"

log() {
    echo "[mantaprint-storage] $1" | logger -t mantaprint-storage || true
    echo "[mantaprint-storage] $1"
}

warn() {
    echo "[mantaprint-storage] [WARN] $1" | logger -t mantaprint-storage -p user.warning || true
    echo "[mantaprint-storage] [WARN] $1" >&2
}

err() {
    echo "[mantaprint-storage] [ERROR] $1" | logger -t mantaprint-storage -p user.err || true
    echo "[mantaprint-storage] [ERROR] $1" >&2
}

update_state() {
    local tier="$1"
    local dev="$2"
    local label="$3"
    local fstype="$4"
    local media_type="$5"
    local mounted="$6"
    local cups_spool="$7"
    local ram_spool="$8"
    local event="$9"

    mkdir -p "$STATE_DIR"
    local now
    now=$(date +%s 2>/dev/null || echo 0)

    cat <<EOF > "$STATE_FILE.tmp"
{
  "tier": "$tier",
  "device": "$dev",
  "label": "$label",
  "fstype": "$fstype",
  "media_type": "$media_type",
  "mounted": $mounted,
  "mount_point": "$MOUNT_POINT",
  "cups_spool": "$cups_spool",
  "ram_spool_active": $ram_spool,
  "last_event": "$event",
  "updated_at": $now
}
EOF
    mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}

get_root_disk() {
    local root_src
    root_src=$(findmnt -n -o SOURCE / 2>/dev/null || true)
    local root_disk=""
    if [ -n "$root_src" ]; then
        root_disk=$(lsblk -no PKNAME "$root_src" 2>/dev/null || true)
        if [ -z "$root_disk" ]; then
            root_disk=$(basename "$root_src" | sed -E 's/p?[0-9]+$//')
        fi
    fi
    echo "$root_disk"
}

get_root_media_info() {
    local root_disk
    root_disk=$(get_root_disk)
    local dev_name="${root_disk:-root_disk}"
    local media_type="Generic Primary Storage"

    if [ -n "$root_disk" ]; then
        if [[ "$root_disk" =~ mmcblk ]]; then
            local mmc_type
            mmc_type=$(cat "/sys/block/$root_disk/device/type" 2>/dev/null || true)
            if [ "$mmc_type" = "MMC" ]; then
                media_type="Internal eMMC"
            elif [ "$mmc_type" = "SD" ]; then
                media_type="MicroSD / SD Card"
            else
                media_type="eMMC/SD Storage"
            fi
        elif [[ "$root_disk" =~ nvme ]]; then
            media_type="NVMe SSD"
        elif [[ "$root_disk" =~ sd ]]; then
            local rotational
            rotational=$(cat "/sys/block/$root_disk/queue/rotational" 2>/dev/null || true)
            if [ "$rotational" = "0" ]; then
                media_type="SATA SSD"
            elif [ "$rotational" = "1" ]; then
                media_type="Hard Disk Drive (HDD)"
            else
                media_type="SATA/USB Storage"
            fi
        elif [[ "$root_disk" =~ vd ]]; then
            media_type="Virtual Disk (VM)"
        fi
    fi
    echo "$dev_name|$media_type"
}

ensure_directory_tree() {
    local target="$1"
    mkdir -p "$target/spool/cups/tmp"
    mkdir -p "$target/scans"
    mkdir -p "$target/config"
    mkdir -p "$target/drivers"
    mkdir -p "$target/backups"
    mkdir -p "$target/log.hdd"

    # Strict CUPS security permissions (CUPS halts if permissions deviate from 0710 root:lp)
    chown -R root:lp "$target/spool/cups" 2>/dev/null || true
    chmod 0710 "$target/spool/cups" 2>/dev/null || true
    chmod 1770 "$target/spool/cups/tmp" 2>/dev/null || true

    # WebScan studio storage
    chmod 0777 "$target/scans" 2>/dev/null || true

    # Drivers, config, backups
    chmod 0755 "$target/config" "$target/drivers" "$target/backups" "$target/log.hdd" 2>/dev/null || true

    # Anti-Symlink Traversal: prevent symlinks inside external storage
    find "$target/config" -type l -delete 2>/dev/null || true
    find "$target/drivers" -type l -delete 2>/dev/null || true

    # Ensure in-memory ephemeral scans directory exists in volatile tmpfs (RAM)
    mkdir -p /run/mantaprint/scans
    chmod 0777 /run/mantaprint/scans 2>/dev/null || true

    touch "$target/.health" 2>/dev/null || true
}

mount_ram_spool() {
    mkdir -p "$CUPS_SPOOL"
    if ! mountpoint -q "$CUPS_SPOOL"; then
        log "Mounting 128MB zero-wear tmpfs RAM spool on $CUPS_SPOOL..."
        mount -t tmpfs -o mode=0710,uid=0,gid=7,size=128M,noatime,nodiratime mantaprint_spool "$CUPS_SPOOL"
        mkdir -p "$CUPS_SPOOL/tmp"
        chown -R root:lp "$CUPS_SPOOL" 2>/dev/null || true
        chmod 0710 "$CUPS_SPOOL" 2>/dev/null || true
        chmod 1770 "$CUPS_SPOOL/tmp" 2>/dev/null || true
    fi
}

find_candidate_device() {
    local root_disk
    root_disk=$(get_root_disk)

    # 1. Check for labeled partition MANTADATA or HEYKDATA
    local by_label
    by_label=$(blkid -L "$LABEL_NAME" 2>/dev/null || blkid -L "$LEGACY_LABEL" 2>/dev/null || true)
    if [ -n "$by_label" ] && [ -b "$by_label" ]; then
        if [ -z "$root_disk" ] || ! echo "$by_label" | grep -q "$root_disk"; then
            echo "$by_label"
            return 0
        fi
    fi

    # 2. Check for other mmcblk partitions (e.g. dedicated MicroSD on mmcblk0 when root is mmcblk1)
    local mmc_part
    mmc_part=$(lsblk -lpno NAME,TYPE 2>/dev/null | grep -E '^/dev/mmcblk[0-9]+p[0-9]+' | awk '{print $1}' || true)
    for p in $mmc_part; do
        if [ -n "$root_disk" ] && echo "$p" | grep -q "$root_disk"; then
            continue
        fi
        if [ -b "$p" ]; then
            echo "$p"
            return 0
        fi
    done

    # 3. Check for unpartitioned secondary MicroSD only (/dev/mmcblk[0-9]+ disk, e.g. raw MicroSD)
    # NOTE: Never touch /dev/sd* or /dev/nvme* without MANTADATA label to protect customer media!
    local raw_mmc
    raw_mmc=$(lsblk -lpno NAME,TYPE 2>/dev/null | grep -E '^/dev/mmcblk[0-9]+\s+disk' | awk '{print $1}' || true)
    for d in $raw_mmc; do
        if [ -n "$root_disk" ] && echo "$d" | grep -q "$root_disk"; then
            continue
        fi
        # Check if disk has no existing partitions and no raw filesystem
        local has_parts
        has_parts=$(lsblk -no NAME "$d" 2>/dev/null | wc -l)
        local existing_fs
        existing_fs=$(blkid "$d" 2>/dev/null || true)
        if [ "$has_parts" -le 1 ] && [ -z "$existing_fs" ] && [ -b "$d" ]; then
            log "Unpartitioned secondary MicroSD detected at $d. Creating GPT partition..."
            wipefs -a "$d" 2>/dev/null || true
            parted -s "$d" mklabel gpt mkpart primary ext4 1MiB 100% 2>/dev/null || true
            sleep 1
            partprobe "$d" 2>/dev/null || true
            sleep 1
            local created_part="${d}p1"
            if [ ! -b "$created_part" ]; then
                created_part="${d}1"
            fi
            if [ -b "$created_part" ]; then
                echo "$created_part"
                return 0
            fi
        fi
    done

    echo ""
}

activate_fallback() {
    local reason="${1:-boot_fallback}"
    local root_info
    root_info=$(get_root_media_info)
    local dev_name="${root_info%|*}"
    local media_type="${root_info#*|}"

    log "Activating Adaptive Storage / Zero-Wear Fallback Mode ($reason) for $media_type..."

    # Ensure /mnt/data directory hierarchy exists on rootfs
    mkdir -p "$MOUNT_POINT"
    ensure_directory_tree "$MOUNT_POINT"

    # Mount tmpfs RAM spool to protect flash/disk from thrashing
    mount_ram_spool

    # If CUPS is active, trigger non-blocking restart to bind cleanly to RAM spool without deadlock
    if systemctl is-active --quiet cups 2>/dev/null; then
        systemctl restart --no-block cups 2>/dev/null || true
    fi

    local root_fstype
    root_fstype=$(findmnt -n -o FSTYPE / 2>/dev/null || echo "ext4")

    update_state "fallback" "$dev_name" "FALLBACK" "$root_fstype" "$media_type" "false" "ram_tmpfs" "true" "$reason"
    log "[OK] Adaptive Storage Mode active. $media_type protected with 128MB RAM-Spool."
}

mount_external() {
    local target_dev="$1"
    local reason="${2:-boot_mount}"
    log "Mounting external high-endurance storage: $target_dev ($reason)..."

    # Verify or apply filesystem
    local fstype
    fstype=$(blkid -s TYPE -o value "$target_dev" 2>/dev/null || true)
    local label
    label=$(blkid -s LABEL -o value "$target_dev" 2>/dev/null || true)

    if [ -z "$fstype" ]; then
        if echo "$target_dev" | grep -qE '^/dev/mmcblk'; then
            log "Device $target_dev is a raw MicroSD card. Formatting as ext4 with label $LABEL_NAME..."
            mkfs.ext4 -F -L "$LABEL_NAME" -O has_journal -E lazy_itable_init=0,lazy_journal_init=0 "$target_dev"
            tune2fs -e continue -c 0 -i 0 "$target_dev" 2>/dev/null || true
            fstype="ext4"
            label="$LABEL_NAME"
        else
            warn "Device $target_dev is unformatted and not dedicated MicroSD. Refusing to auto-format to prevent data loss."
            activate_fallback "${reason}_unformatted_device"
            return 1
        fi
    fi

    if [ "$fstype" != "ext4" ]; then
        warn "Storage device $target_dev has filesystem '$fstype' instead of ext4. Non-ext4 filesystems cannot support CUPS spool permissions or hardened VFS flags."
        activate_fallback "${reason}_incompatible_fstype"
        return 1
    fi

    # If /var/spool/cups has a tmpfs from fallback, unmount it cleanly
    if grep -q "mantaprint_spool" /proc/mounts 2>/dev/null; then
        log "Unmounting fallback RAM-spool tmpfs from $CUPS_SPOOL..."
        umount -l "$CUPS_SPOOL" 2>/dev/null || true
    fi

    # Fast non-destructive filesystem integrity check
    fsck.ext4 -p "$target_dev" 2>/dev/null || true

    # Mount to /mnt/data with strict VFS hardening (anti-SUID, anti-executable injection)
    mkdir -p "$MOUNT_POINT"
    if ! mountpoint -q "$MOUNT_POINT"; then
        mount -o defaults,noatime,nodiratime,noexec,nosuid,nodev,commit=60,errors=continue "$target_dev" "$MOUNT_POINT"
    fi

    # Ensure directories & permissions on external drive
    ensure_directory_tree "$MOUNT_POINT"

    # Bind-mount CUPS spool to external drive
    mkdir -p "$CUPS_SPOOL"
    if ! mountpoint -q "$CUPS_SPOOL"; then
        log "Bind-mounting $MOUNT_POINT/spool/cups to $CUPS_SPOOL..."
        mount --bind "$MOUNT_POINT/spool/cups" "$CUPS_SPOOL"
    fi

    # Restart CUPS if running (non-blocking to prevent systemd unit dependency deadlocks)
    if systemctl is-active --quiet cups 2>/dev/null; then
        systemctl restart --no-block cups 2>/dev/null || true
    fi

    local media_type="MicroSD"
    if echo "$target_dev" | grep -q "sd[a-z]"; then
        media_type="USB Storage"
    elif echo "$target_dev" | grep -q "nvme"; then
        media_type="NVMe SSD"
    fi

    update_state "external" "$target_dev" "${label:-$LABEL_NAME}" "$fstype" "$media_type" "true" "external" "false" "$reason"
    log "[OK] External storage $target_dev mounted at $MOUNT_POINT ($media_type, $label)."
}

handle_plug() {
    local dev_name="$1"
    local dev_path="/dev/$dev_name"
    log "Plug event received: $dev_path"

    if [ ! -b "$dev_path" ]; then
        # Could be device name like sda1
        if [ -b "/dev/$dev_name" ]; then
            dev_path="/dev/$dev_name"
        else
            log "Device $dev_path is not a valid block device. Skipping."
            return 0
        fi
    fi

    # Exclude root disk
    local root_disk
    root_disk=$(get_root_disk)
    if [ -n "$root_disk" ] && echo "$dev_name" | grep -q "$root_disk"; then
        log "Device $dev_path belongs to root disk ($root_disk). Skipping."
        return 0
    fi

    # Check if /mnt/data is already mounted to a healthy device
    if mountpoint -q "$MOUNT_POINT" && touch "$MOUNT_POINT/.health" 2>/dev/null; then
        local current_src
        current_src=$(findmnt -n -o SOURCE "$MOUNT_POINT" 2>/dev/null || true)
        if [ "$current_src" = "$dev_path" ]; then
            log "Device $dev_path is already active at $MOUNT_POINT."
            return 0
        fi
    fi

    # Inspect filesystem and label
    local fstype
    fstype=$(blkid -s TYPE -o value "$dev_path" 2>/dev/null || true)
    local label
    label=$(blkid -s LABEL -o value "$dev_path" 2>/dev/null || true)

    # Protect customer USB media: never adopt /dev/sd* unless explicitly labeled MANTADATA
    if echo "$dev_path" | grep -qE '^/dev/sd'; then
        if [ "$label" != "$LABEL_NAME" ] && [ "$label" != "$LEGACY_LABEL" ]; then
            log "USB block device $dev_path detected without $LABEL_NAME label (label='${label:-none}', fstype='${fstype:-raw}'). Preserving customer media; skipping tiering adoption."
            return 0
        fi
    fi

    if [ -z "$fstype" ]; then
        if echo "$dev_path" | grep -qE '^/dev/mmcblk'; then
            log "Dedicated MicroSD $dev_path is unformatted. Formatting as ext4 with label $LABEL_NAME..."
            mkfs.ext4 -F -L "$LABEL_NAME" -O has_journal -E lazy_itable_init=0,lazy_journal_init=0 "$dev_path"
            tune2fs -e continue -c 0 -i 0 "$dev_path" 2>/dev/null || true
        else
            log "Device $dev_path is unformatted and not dedicated MicroSD. Skipping adoption."
            return 0
        fi
    fi

    log "[+] Adopting storage device $dev_path into MantaPrint Tiering..."

    # Stage mount to sync any files accumulated during fallback
    local staging="/mnt/.data_staging"
    mkdir -p "$staging"
    if mount -o defaults,noatime,nodiratime,noexec,nosuid,nodev "$dev_path" "$staging" 2>/dev/null; then
        ensure_directory_tree "$staging"
        if ! mountpoint -q "$MOUNT_POINT"; then
            log "Syncing fallback configuration to newly connected storage (safe-links only)..."
            rsync -a --no-links --safe-links --update "$MOUNT_POINT/config/" "$staging/config/" 2>/dev/null || true
        fi
        umount "$staging" 2>/dev/null || true
    fi
    rmdir "$staging" 2>/dev/null || true

    # Clean unmount existing spool & mount point
    umount -l "$CUPS_SPOOL" 2>/dev/null || true
    umount -l "$MOUNT_POINT" 2>/dev/null || true

    mount_external "$dev_path" "hotplug_adopted"
}

handle_unplug() {
    local dev_name="$1"
    log "Unplug event received for device: $dev_name"

    local current_src
    current_src=$(findmnt -n -o SOURCE "$MOUNT_POINT" 2>/dev/null || true)

    local is_affected=false
    if [ -n "$dev_name" ] && [ -n "$current_src" ]; then
        if echo "$current_src" | grep -q "$dev_name"; then
            is_affected=true
        fi
    fi

    # Also test canary health
    if ! touch "$MOUNT_POINT/.health" 2>/dev/null; then
        is_affected=true
    fi

    if [ "$is_affected" = true ]; then
        warn "[!] Active storage media unplugged or inaccessible! Executing lazy unmount..."
        umount -l "$CUPS_SPOOL" 2>/dev/null || true
        umount -l "$MOUNT_POINT" 2>/dev/null || true
        activate_fallback "surprise_unplug"
    else
        log "Removed device $dev_name does not affect active storage ($current_src)."
    fi
}

check_health() {
    if mountpoint -q "$MOUNT_POINT"; then
        if ! touch "$MOUNT_POINT/.health" 2>/dev/null; then
            err "Storage health canary failed at $MOUNT_POINT! Triggering emergency fallback..."
            handle_unplug "health_canary_failure"
            return 1
        fi
    else
        # In fallback mode, check if a candidate storage has been plugged in silently
        local cand
        cand=$(find_candidate_device)
        if [ -n "$cand" ]; then
            log "Candidate storage $cand discovered during health check. Adopting..."
            handle_plug "$(basename "$cand")"
        fi
    fi
    return 0
}

# --- Main Entry Point with flock Protection ---
cmd="${1:-init}"
shift || true

mkdir -p "$STATE_DIR"
exec 200>"$LOCK_FILE"
if ! flock -x -w 15 200; then
    err "Could not acquire storage lock ($LOCK_FILE). Operation aborted."
    exit 1
fi

case "$cmd" in
    init)
        log "Initializing MantaPrint Storage Tiering Engine..."
        cand=$(find_candidate_device)
        if [ -n "$cand" ]; then
            log "Detected candidate high-endurance storage at $cand."
            mount_external "$cand" "boot_mount"
        else
            log "No secondary storage found. Activating Zero-eMMC Auto-Fallback..."
            activate_fallback "boot_fallback"
        fi
        ;;

    handle-plug)
        dev="$1"
        if [ -z "$dev" ]; then
            err "handle-plug requires block device parameter (e.g. sda1 or mmcblk0p1)."
            exit 1
        fi
        handle_plug "$dev"
        ;;

    handle-unplug)
        dev="$1"
        handle_unplug "$dev"
        ;;

    check-health)
        check_health
        ;;

    status)
        if [ -f "$STATE_FILE" ]; then
            cat "$STATE_FILE"
        else
            echo '{"tier":"unknown","mounted":false}'
        fi
        ;;

    *)
        echo "Usage: $0 {init|handle-plug <dev>|handle-unplug <dev>|check-health|status}"
        exit 1
        ;;
esac

exit 0
