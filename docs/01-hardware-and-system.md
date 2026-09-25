# Hardware & System Architecture

## 1. Hardware Overview

| Component | Specification | Description |
|---|---|---|
| **SoC / Platform** | Amlogic Meson GXL (S905X) P212 | 64-bit ARMv8 Cortex-A53 |
| **CPU Cores** | 4 Cores @ Up to 1.5 GHz | aarch64 architecture |
| **RAM** | 2.0 GB (1.9 GiB usable) | ~1.4 GiB free under baseline load |
| **Swap** | 958 MiB zram / swap | Low-latency memory compression |
| **Internal Flash (eMMC)** | 5.7 GB (`/dev/mmcblk1p2`) | Root filesystem (`/`), ~3.2 GB available |
| **External Flash (MicroSD)** | 58 GB (`/dev/mmcblk0p1`) | High-endurance storage mounted at `/mnt/data` |
| **Log RAM Partition** | 47 MB (`/dev/zram1`) | Mounted at `/var/log` to eliminate write wear |
| **USB Bus** | USB 2.0 Root Hub (`1d6b:0002`) | Host connection for printers & scanners |
| **Network Interfaces** | `eth0` (10/100M Ethernet), `wlan0` (Wi-Fi 2.4/5GHz), `wlan1` | Dual-band wireless and wired networking |

---

## 2. Operating System & Kernel

* **Distribution**: Armbian Community Linux (Debian-compatible LTS base)
* **Kernel**: `Linux mantaprint 6.18.35-current-meson64 #2 SMP PREEMPT aarch64`
* **Init System**: `systemd 257`
* **Cgroup & Limits**: systemd memory slicing (`MemoryHigh`, `MemoryMax`) active across MantaPrint service units.

---

## 3. Appliance Storage Tiering (Zero-eMMC Wear Design)

eMMC flash memory on TV boxes and SBCs has limited finite write cycles. The appliance adopts a storage tiering architecture to ensure high endurance:

1. **eMMC (`/dev/mmcblk1p2` - Read-Mostly)**:
   * Hosts the operating system root, application binaries, and system libraries.
   * Never receives high-churn print spools or repeated scan writes.

2. **High-Endurance MicroSD (`/dev/mmcblk0p1` mounted at `/mnt/data`)**:
   * Initialized automatically during boot by `mantaprint-storage-init.service` (`/usr/local/sbin/mantaprint-storage-init.sh`).
   * Hardened kernel mount flags: `noexec,nosuid,nodev,noatime,nodiratime,commit=60,errors=continue`.
   * **Bind-Mounted CUPS Spool**: `/mnt/data/spool/cups` is bind-mounted to `/var/spool/cups`. All print spools are offloaded to MicroSD.
   * **Deployment Backups**: Automated snapshot backups stored at `/mnt/data/backups`.

3. **Volatile Ephemeral RAM tmpfs (`/run/mantaprint/scans`)**:
   * 100% in-memory document scanning buffer (Zero-Trace customer privacy).
   * Files auto-shred after 5 minutes or immediately upon download.

4. **ZRAM Log Partition (`/dev/zram1` mounted at `/var/log`)**:
   * Compresses logs in RAM to eliminate flash storage wear.
