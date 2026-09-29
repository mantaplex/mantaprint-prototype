# Driver Center (Admin → Drivers & devices)

Everything about device support that the hub cannot solve by itself lives on one admin page.
Sources: `src/web/server/driver-center.mjs` (engine), `driver-recipes.json` (catalog),
`hplip-plugin.mjs` (HP plugin), `scanner-firmware.mjs` (ScanSnap `.nal`, archive unpacking),
`frontend/src/admin/sections/Drivers.jsx` (page), routes under `/api/drivers/*` in `server.mjs`.

## What the page shows

The page is a **checklist runner**. For every connected device and every catalog family the
server computes the ordered steps it needs, marks which of them are already done, and attaches
to each open step the action that completes it right there (`familySteps` / `deviceSteps` in
`driver-center.mjs`; the facts come from `dpkg-query`, HPLIP's plugin state, the ScanSnap and HP
firmware caches and `printer_manager.py`'s readiness verdict). `GET /api/drivers/overview` returns
`devices[]` and `catalog[]`, each with `steps[]` and a `summary` (`ready`, `setup` + number of open
steps, `unsupported`).

1. **How it works** – plug the device in or pick its model → run the steps shown → verify.
2. **Your devices** – one card per printer queue, scanner, or USB printer the kernel sees without
   a queue: the readiness verdict, the catalog family it was matched to, and its checklist. Cards
   with open steps come first.
3. **Waiting for your decision** – pending `.deb`s and unpacked archives, with the confirmation
   popup for anything that runs as root.
4. **Set up a printer or scanner** – the catalog grouped by brand with *Printer* / *Scanner* badges,
   a search box (brand, family, model names) and filters (All / Printers / Scanners / Needs setup).
   A family opens into the same checklist, plus a *connect* step that lists the matching devices
   currently plugged in. Families with a connected device, and single search hits, open by
   themselves.
5. **Not in the list? Check** – `GET /api/drivers/lookup?q=` searches the PPD index
   (`/var/cache/cups/mantaprint_drivers.json`), SANE's USB hwdb (`20-sane.hwdb`), HPLIP's
   `models.dat` and the catalog, and returns one verdict: `supported`, `likely`, `needs_file`,
   `unsupported`, `unknown`. Works offline.
6. **Installed by you** – `/etc/mantaprint/drivers.json`; kept copies live under
   `/mnt/data/tmp/drivers/` (or `/var/tmp/drivers/`). Survives OTA updates (which only replace
   `/opt/mantaprint`). Removal: `apt-get remove` for packages, file deletion for PPD/firmware.
7. **Advanced** – a drop zone for any file (the hub classifies it, see below) and *Hub tools*, the
   allowlisted system packages (`APT_ALLOWLIST`) with plain-language names.

### Steps

| Step (`kind`) | Done when | Actions on the step |
|---|---|---|
| `packages` | every package in the family's `apt` list is installed | **Install support** → `POST /api/drivers/apt/install {packages[]}` (`apt-get update` at most hourly, then `install --no-install-recommends`; needs internet) |
| `deb` | the vendor package (`requires[].package`) is installed | **Upload .deb** (staged as pending, then the confirmation popup), vendor download link |
| `plugin` | HPLIP's proprietary plugin is installed and its version equals HPLIP's | **Upload plugin (.run / .asc)** → `POST /api/drivers/hplip/plugin`; *blocked* until `hplip` is installed |
| `nal` | the ScanSnap's firmware file is present (`scanner-firmware.mjs`) | **Upload** → `POST /api/scanner/firmware?target=<file>`; on a device card only that scanner's file |
| `dl` | the HP host-based firmware (`sihpXXXX.dl`, table `HP_FIRMWARE`; P1007 shares P1005's file, P1008 shares P1006's) is in the firmware cache or a foo2zjs directory | **Fetch from HP (internet)** → `POST /api/drivers/hp-firmware/fetch {models[]}` (foo2zjs `getweb`), **Upload .dl**, and **Send firmware now** on a queue in `needs_firmware`. A printer card only talks about its own file |
| `ppd` | – | **Upload PPD** → `POST /api/drivers/upload?queue=`; optional fallback for `unsupported` / `needs_review` queues, the only step for a USB printer without a recipe |
| `connect` | a matching device is plugged in (family view only) | – |
| `verify` | – (blocked until the steps above are done and the device is connected) | **Print test page**, **Open the scanner** |
| `unsupported` | – | the reason from the catalog |

Step statuses: `done`, `todo`, `blocked` (`blocked_by` names the step), `optional`, `info`. A
`ready` verdict from `printer_manager.py` wins over a `setup` summary, so a working queue never
shows as unfinished because a catalog package is missing.

HP `.dl` files, fetched or uploaded, are installed into the foo2zjs directories **and** kept in
`/mnt/data/firmware/hp` (or `/var/cache/mantaprint/firmware/hp`) so they survive an OTA update.

### Uploads

`POST /api/drivers/upload` (raw body, `X-File-Name`, optional `?queue=`). The hub classifies the
file by name and contents:

   | Kind | Handling |
   |---|---|
   | `.ppd` / `.ppd.gz` | validated (`*PPD-Adobe` header, `cupstestppd`), copied to `/usr/share/cups/model/mantaprint-uploads/`, optionally assigned to the target queue with `lpadmin -P` |
   | `sihpXXXX.dl` | HP LaserJet firmware, copied to the firmware cache and the `foo2zjs` firmware dirs; the target queue is re-provisioned |
   | `hplip-<v>-plugin.run` (+ `.run.asc`) | `hp-plugin -i -p`, version must equal the installed HPLIP |
   | `.deb` | inspected (`dpkg-deb -f`, architecture vs `dpkg --print-architecture`, maintainer scripts present?) and **staged as pending**; installed only after `POST /api/drivers/pending/install` with `confirm: true` (`dpkg -i`, then `apt-get -f install` for dependencies) |
   | installer archives (`.zip`, `.exe`, `.msi`, `.cab`, `.7z`, `.tar.gz`, …) | unpacked with 7z/cabextract/unshield up to three levels; the driver-ish files inside are listed as a pending item to pick from |
   | `.nal` | rejected here; ScanSnap firmware goes through the `nal` step (`/api/scanner/firmware`, which knows its targets) |

The catalog (`driver-recipes.json`) has one entry per family: `name`, `kind` (`printer`,
`scanner`, `mfp`), `match` (USB ids, model regex), `apt`, `requires[]` (`deb`, `hplip-plugin`,
`nal`, `dl`), `models[]` for search, and `status`: `verified` (tested on hub hardware),
`available` (package claim), `needs_file`, `unsupported`. Runtime verdicts always override these
claims for a connected device.

Long operations (`.deb`, apt, firmware fetch, removal) run as one background job at a time; the
page polls `GET /api/drivers/job` and shows the log.

## Security posture

Everything here runs as root on the hub, by design and after an explicit admin action. See
`docs/KNOWN-LIMITATIONS.md` I5. Vendor files never enter this repository; the admin downloads
them from the vendor and the hub keeps a copy locally.

## Not yet verified on hardware

The HP plugin path (`hp-plugin -i -p`, arm64 plugin, M130a scanning through `hpaio`), `.deb`
installation of the Canon UFR II LT driver through this page, and PPD assignment to a live
queue have unit tests around their pure parts but have not yet been exercised on a hub.
