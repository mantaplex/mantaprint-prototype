# Project Memory & Guidelines

## Infrastructure & Devices

Device addresses, SSH aliases and credentials are **not** kept in this repository.
Put them in `~/.ssh/config` (alias `mantaprint-hub`) and, if you want notes, in an
untracked `AGENTS.local.md`. The automation scripts under `scripts/` read the alias from
`MANTAPRINT_HOST` (default `mantaprint-hub`).

### MantaPrint Hub (target device)
- **SSH alias**: `mantaprint-hub` (configure in `~/.ssh/config`; key-based auth)
- **Role**: MantaPrint Hub STB (Armbian Linux, Amlogic Meson S905X / ARM64)
- **Web App**: `http://<hub-ip>/` (port 80)
- **CUPS**: `http://<hub-ip>:631/` (port 631)
- **Installed Services**:
  - `cups.service`: CUPS 2.4.10 daemon
  - `mantaprint-web.service`: Node.js server (`/opt/mantaprint/web/server/server.mjs`)
  - `mantaprint-agent.service`: Fleet agent (`/opt/mantaprint/agent/agent.mjs`)
  - `mantaprint-storage-init.service`: MicroSD storage tiering (`/usr/local/sbin/mantaprint-storage-init.sh`)
  - `mantaprint-ir.service`: IR remote keytable loader (`/etc/rc_keymaps/mantaprint_remote.toml`)
  - `mantaprint-hdmi.service`: Wayland Cage + Cog WPE WebKit 10-foot kiosk (`http://127.0.0.1:80/hdmi`, clamped to 1080p, triggered by HDMI cable hotplug)
  - `mantaprint-hotplug.service`: USB printer auto-detection & driver provisioner (oneshot)

### Development / test sandboxes
Any Raspberry Pi (3 or newer) or similar SBC can serve as a sandbox; keep its address in
`~/.ssh/config` and point `MANTAPRINT_HOST` at it.

---

## Critical Architecture Principles

### 1. Storage Tiering & Anti-Tampering VFS Architecture
- Internal eMMC (`/dev/mmcblk1p2`) is **read-mostly**. Never write continuous spools or logs directly to eMMC.
- High-endurance MicroSD (`/dev/mmcblk0p1` mounted at `/mnt/data`) handles high-churn I/O:
  - Mounted with hardened kernel VFS flags: `noexec,nosuid,nodev,noatime,nodiratime,commit=60,errors=continue`. Any dropped binary or script is blocked with `EACCES (Permission denied)`.
  - `/mnt/data/spool/cups` is bind-mounted to `/var/spool/cups` when present.
  - Fallback engine automatically provisions a 128MB `tmpfs` RAM-spool if MicroSD is absent or unplugged.
  - `/mnt/data/backups` stores automatic deployment backups.
- `/var/log` resides on ZRAM (`/dev/zram1`) to prevent log wear.
- **Zero-Trace In-Memory Ephemeral Scans**:
  - Customer scanned documents stream **100% to volatile RAM `tmpfs`** (`/run/mantaprint/scans`). ZERO customer documents touch MicroSD or eMMC.
  - 5-Minute Ephemeral Lifecycle: Inactive scans self-destruct from RAM after 5 minutes.
  - Auto-Wipe on Download: Files in RAM are shredded immediately upon download stream completion.
  - Anti-Symlink Traversal Shield: Symlinks on external media are automatically rejected and unlinked.

### 2. Memory Budget (< 60MB RAM Baseline on S905X, 64MB Ceiling on General SBCs)
- Node.js Web Dashboard runs with `--max-old-space-size=64 --max-semi-space-size=2 --expose-gc` in `systemd/mantaprint-web.service` with cgroup containment `MemoryHigh=150M` and `MemoryMax=200M`. Baseline target on constrained 1GB S905X STBs is ~24MB old space (<60MB RSS), while 64MB provides safety headroom on general SBCs for multi-device PDF parsing and concurrent SSE streams.
- Node.js Agent runs with `--max-old-space-size=16` (`MemoryMax=25M`).
- Python image processor operations (`image_processor.py`) run with aggressive memory reclamation (`gc.collect()`) keeping peak RSS < 60MB.

### 3. Zero-Idle HDMI Lifecycle
- HDMI kiosk runs `cage -d -s -m last -- /usr/local/bin/mantaprint-hdmi-runner`.
- Resolution clamped to 1080p (`wlr-randr --output HDMI-A-1 --mode 1920x1080@60Hz`) to prevent VRAM exhaustion on 4K TVs.
- Automatically started on HDMI cable insertion and stopped on disconnect via udev + flock debounce (`/usr/local/bin/mantaprint-hdmi-trigger`).

---

## Developer Tooling (`scripts/`)

Always use the local automation scripts from this directory:
- `./scripts/status.sh`: Check SBC hardware, RAM, disk, network, and systemd service health.
- `./scripts/logs.sh <web|agent|hotplug|cups|hdmi|ir>`: Live log stream from SBC.
- `./scripts/sync-from-device.sh`: Safe, 100% read-only rsync from `mantaprint-hub` to local workspace.
- `./scripts/deploy-to-device.sh <module>`: Safe deploy with dry-run support and automatic remote backup (`all`, `web`, `core`, `agent`, `systemd`).

---

## Prototype Status & Releases

- This repository (`mantaplex/mantaprint-prototype`) is a **prototype**. Keep the prototype labels (badges, titles, installer notice, `channel: "prototype"`) in place, and keep `docs/KNOWN-LIMITATIONS.md` in sync when a weakness is fixed or a new one is found. The notice text lives only in `docs/PROTOTYPE-NOTICE.txt`.
- **Every new version gets a tag AND a GitHub Release.** Steps: bump `version.json` (and `package.json`, `frontend/package.json`, `frontend/public/sw.js` cache name), add a `## [x.y.z] - date` section to `CHANGELOG.md`, and push the commit to `main`. The `Publish GitHub Releases` workflow (`scripts/publish-releases.mjs`) then creates the tag `vx.y.z` on that commit and the pre-release from the CHANGELOG section - no manual tag push needed (pushing an annotated tag yourself also works). Optionally add a custom title to `RELEASE_TITLES`.
