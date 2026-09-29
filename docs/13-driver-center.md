# Driver Center (Admin → Drivers & devices)

Everything about device support that the hub cannot solve by itself lives on one admin page.
Sources: `src/web/server/driver-center.mjs` (engine), `driver-recipes.json` (catalog),
`hplip-plugin.mjs` (HP plugin), `scanner-firmware.mjs` (ScanSnap `.nal`, archive unpacking),
`frontend/src/admin/sections/Drivers.jsx` (page), routes under `/api/drivers/*` in `server.mjs`.

## What the page shows

1. **Your devices** – every printer queue (with `printer_manager.py`'s readiness verdict), the
   scanner, ScanSnaps waiting for firmware, HP MFPs waiting for the plugin, and USB printers the
   kernel sees but no queue represents yet. Each card lists what the device still needs
   (`needs[]`: `dl`, `ppd`, `deb`, `nal`, `hplip-plugin`, `review`) with the vendor download link
   from the catalog and an upload button that targets that device.
2. **Check a model** – `GET /api/drivers/lookup?q=` searches the PPD index
   (`/var/cache/cups/mantaprint_drivers.json`), SANE's USB hwdb (`20-sane.hwdb`), HPLIP's
   `models.dat` and the catalog, and returns one verdict: `supported`, `likely`, `needs_file`,
   `unsupported`, `unknown`. Works offline.
3. **Upload** – `POST /api/drivers/upload` (raw body, `X-File-Name`, optional `?queue=`). The hub
   classifies the file by name and contents:

   | Kind | Handling |
   |---|---|
   | `.ppd` / `.ppd.gz` | validated (`*PPD-Adobe` header, `cupstestppd`), copied to `/usr/share/cups/model/mantaprint-uploads/`, optionally assigned to the target queue with `lpadmin -P` |
   | `sihpXXXX.dl` | HP LaserJet firmware, copied to the `foo2zjs` firmware dirs; the target queue is re-provisioned |
   | `hplip-<v>-plugin.run` (+ `.run.asc`) | `hp-plugin -i -p`, version must equal the installed HPLIP |
   | `.deb` | inspected (`dpkg-deb -f`, architecture vs `dpkg --print-architecture`, maintainer scripts present?) and **staged as pending**; installed only after `POST /api/drivers/pending/install` with `confirm: true` (`dpkg -i`, then `apt-get -f install` for dependencies) |
   | installer archives (`.zip`, `.exe`, `.msi`, `.cab`, `.7z`, `.tar.gz`, …) | unpacked with 7z/cabextract/unshield up to three levels; the driver-ish files inside are listed as a pending item to pick from |
   | `.nal` | rejected here; ScanSnap firmware goes through Admin → Scanner (it knows its targets) |

4. **Waiting for your decision** – pending `.deb`s and unpacked archives, with the confirmation
   popup for anything that runs as root.
5. **Installed by you** – `/etc/mantaprint/drivers.json`; kept copies live under
   `/mnt/data/tmp/drivers/` (or `/var/tmp/drivers/`). Survives OTA updates (which only replace
   `/opt/mantaprint`). Removal: `apt-get remove` for packages, file deletion for PPD/firmware.
6. **Packages from the Debian repositories** – `POST /api/drivers/apt/install` for the allowlist in
   `APT_ALLOWLIST` only; runs `apt-get update` (at most hourly) and `apt-get install
   --no-install-recommends`. Needs internet on the hub.
7. **Catalog** – `driver-recipes.json`, one entry per family with `status`: `verified` (tested on hub
   hardware), `available` (package claim), `needs_file`, `unsupported`. Runtime verdicts always
   override these claims for a connected device.

Long operations (`.deb`, apt, removal) run as one background job at a time; the page polls
`GET /api/drivers/job` and shows the log.

## Security posture

Everything here runs as root on the hub, by design and after an explicit admin action. See
`docs/KNOWN-LIMITATIONS.md` I5. Vendor files never enter this repository; the admin downloads
them from the vendor and the hub keeps a copy locally.

## Not yet verified on hardware

The HP plugin path (`hp-plugin -i -p`, arm64 plugin, M130a scanning through `hpaio`), `.deb`
installation of the Canon UFR II LT driver through this page, and PPD assignment to a live
queue have unit tests around their pure parts but have not yet been exercised on a hub.
