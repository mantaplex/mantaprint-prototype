# Changelog

All notable changes to the **MantaPrint Hub** project will be documented in this file.

> **Prototype.** From 0.3.0 on, MantaPrint is published as a prototype in
> [mantaplex/mantaprint-prototype](https://github.com/mantaplex/mantaprint-prototype). Versions before
> 0.3.0 were developed in an earlier repository; their history is kept below for reference, but their
> tags and releases are not part of this repository.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> Versions 0.4.0, 0.5.0 and 0.5.1 were renumbered to 0.3.3, 0.3.4 and 0.3.5 on the day of release
> (the project stays on 0.3.x while it is a prototype); their tags and releases were removed.

## [0.3.8] - 2026-09-29

### Fixed
- **Uploading the HPLIP plugin hung at "Checking file…" forever.** `hp-plugin -i -p` was run with its answers piped into stdin. hp-plugin reads that pipe into its own buffer, so the plugin's install script (started by hp-plugin, sharing the same stdin) found it at EOF at the license prompt, and HPLIP's `tui.enter_yes_no()` retries on EOF without end: the installer spun at 100% CPU until the 10-minute kill, which only killed hp-plugin and left the script running. The hub now runs hp-plugin under a pseudo-terminal (`script`), answers each yes/no prompt as it appears, kills the whole process tree on timeout, and runs the install as a background job whose log the Drivers & devices page shows live (`install-hplip-plugin`). Found on the first upload of `hplip-3.22.10-plugin.run` to a Pi 3.
- The `.asc` signature upload from the plugin step used the wrong kind and was treated as a `.run`.

---

## [0.3.7] - 2026-09-29

### Changed
- **Drivers & devices is now a checklist you run in place.** For every connected device and every catalog family the hub computes the ordered steps it needs (`familySteps` / `deviceSteps` in `driver-center.mjs`: support packages → vendor `.deb` / HP plugin / ScanSnap `.nal` / HP LaserJet firmware → PPD fallback → connect → verify), marks which are done from dpkg, HPLIP, the firmware caches and the printer readiness verdict, and puts the matching action on each open step: *Install support*, *Upload .deb / plugin / .nal / .dl / PPD*, *Fetch from HP (internet)*, *Send firmware now*, *Print test page*, *Open the scanner*. Device cards and family rows share the engine, so the M130a card and the "LaserJet / DeskJet / OfficeJet MFP" family show the same two steps. Blocked steps say what they wait for and show no buttons. `GET /api/drivers/overview` returns `steps[]` + `summary` per device and family.
- **HP LaserJet 1000 / 1005 / 1018 / 1020 / P1005–P1505 firmware can be fetched from the page** (`POST /api/drivers/hp-firmware/fetch {models[]}`, foo2zjs `getweb`, needs internet) when the installer could not. Fetched or uploaded `.dl` files are also kept in `/mnt/data/firmware/hp` (or `/var/cache/mantaprint/firmware/hp`) so they survive an OTA update. A printer card only talks about its own firmware file (P1007 shares P1005's, P1008 shares P1006's).
- Catalog families have short names; *Receipt printers*, *Label printers* and *Fujitsu* replace raw vendor ids. Families with a connected device and single search hits open by themselves, and a *Needs setup* filter shows only families with open steps. "Check a model" moved under the list as the fallback for models that are not in the catalog.

### Fixed
- The overview's package state now covers every package the checklists mention (allowlist, family `apt` lists, vendor `.deb` names), not only the allowlist.
- A printer readiness reason the UI has no text for no longer shows a raw translation key.

---

## [0.3.6] - 2026-09-29

### Changed
- **Drivers & devices: "Supported printers & scanners" replaces the package list.** The catalog is now grouped by brand, every family carries *Printer* / *Scanner* badges (both for MFPs), and there is a filter (All / Printers / Scanners) and a search box that matches brand, family and model names (`models` in `driver-recipes.json`). **Install support** installs the Debian packages a family needs in one `apt-get` run (`apt` in the recipes; `POST /api/drivers/apt/install` accepts `packages[]`). System packages that are not tied to a device (nftables, archive tools, ipp-usb, sane-airscan, …) sit under a small *Hub tools* list with plain-language names.

---

## [0.3.5] - 2026-09-29

### Fixed
- **Drivers & devices jobs reported "Unexpected error" although the install had succeeded.** After a successful apt install, `.deb` install or HP firmware (`.dl`) upload, the hub re-syncs printer queues by calling `printer_manager.py`; that call used a misnamed helper (`printerManagerPath` instead of `printerManagerScript`), which threw and marked the job failed. Found on the first real run (`hplip` from the apt list on a Pi 3). The job card now also shows the exception message, and job exceptions are logged with their stack.

---

## [0.3.4] - 2026-09-29

**Lockdown mode (print-only).** For sites where the hub must expose as little as possible: one
switch that leaves only printing reachable. See `docs/14-lockdown-mode.md`.

### Added
- **Lockdown mode** (`src/web/server/lockdown.mjs`, `system/bin/mantaprint-lockdown`, `systemd/mantaprint-lockdown.service`). An nftables ruleset (`table inet mantaprint_lockdown`, default drop both ways) allows inbound only IPP `631/tcp`, mDNS `5353/udp`, DHCP and ICMP; the admin web `80/tcp` only from the admin IPs/CIDRs the operator lists (none listed = unreachable from the network); SSH `22/tcp` from the same list only when enabled; outbound only DHCP, DNS, NTP and mDNS, which also blocks update checks and the MantaPool agent. `cups-browsed` is disabled. The ruleset is written to `/etc/mantaprint/lockdown.nft` and re-applied at boot by the new service. Dropped packets are counted and shown.
- **Switch in the TUI** (Diagnostics → *9. Lockdown Mode (print-only)*) with a dialog that lists what stops working, takes an optional admin IP/CIDR, and asks the PIN when turning it off; the TUI header shows `[LOCKDOWN]`.
- **Admin → Settings → Lockdown mode**: status with drop counters, admin IP list, SSH toggle, PIN change (default `1234`, 4–8 digits, salted scrypt hash in `/etc/mantaprint/lockdown.json`), and confirmation dialogs that spell out the consequences. The admin header shows a red **LOCKDOWN** pill and Overview lists it under *Needs attention*.
- Routes: `GET /api/lockdown`, `POST /api/lockdown/enable`, `POST /api/lockdown/disable` (PIN), `POST /api/lockdown/config` (admin session). `/api/status` carries a `lockdown` summary.
- `install.sh` installs `nftables` and enables `mantaprint-lockdown.service`; `nftables` is also on the Drivers & devices apt allowlist for hubs installed before this version.
- Unit tests (`test/lockdown.test.mjs`): admin IP/CIDR parsing, PIN hashing, ruleset content, config round-trip.

### Not yet verified on hardware
- The ruleset was reviewed for nft syntax but not loaded on a hub yet; first enable it from the console with a second SSH session open (existing sessions survive) so it can be cleared with `mantaprint-lockdown clear` if anything is off.

---

## [0.3.3] - 2026-09-29

**Driver Center.** A new admin page, *Drivers & devices*, gathers everything about device support:
what each connected device still needs, an offline "is model X supported?" check, uploads of vendor
files the hub can't ship with (PPD, `.deb`, HP plugin, HP LaserJet firmware, installer archives) with a
confirmation popup before anything runs as root, installs from a fixed apt allowlist, and a catalog with
honest status per family. First concrete use: HP MFPs such as the LaserJet MFP M130a scan only once
HP's proprietary plugin is installed; the admin now uploads it.

### Added
- **Admin → Drivers & devices** (`frontend/src/admin/sections/Drivers.jsx`, `src/web/server/driver-center.mjs`, routes `/api/drivers/*`; see `docs/13-driver-center.md`): *Your devices* (queues with readiness, scanners, ScanSnaps waiting for firmware, HP MFPs waiting for the plugin, unprovisioned USB printers) each with its needs, vendor download link and a targeted upload button; *Check a model* (`/api/drivers/lookup`) answered from the PPD index, SANE's hwdb, HPLIP's `models.dat` and the catalog; one upload area that classifies `.ppd`/`.ppd.gz`, `.deb`, `hplip-*-plugin.run` (+`.asc`), `sihpXXXX.dl` and installer archives (unpacked up to three levels); `.deb` and archive contents become *pending* items, a `.deb` is installed only after a confirmation popup showing package, version, architecture (checked against the hub's), maintainer, dependencies, whether it has maintainer scripts and its SHA-256; *Installed by you* registry in `/etc/mantaprint/drivers.json` with removal; *Packages from the Debian repositories* from a fixed allowlist (`apt-get`, needs internet); the catalog (`src/web/server/driver-recipes.json`, 18 families) with `verified` / `available` / `needs_file` / `unsupported` status. Long installs run as one background job with a live log. Scanner and Printers link to the page.
- **HP plugin provisioning** (`src/web/server/hplip-plugin.mjs`). Connected HP USB devices are looked up in HPLIP's own database (`/usr/share/hplip/data/models/models.dat`); a `plugin` value > 0 or the scan bit (64) in `plugin-reason` marks the scanner as needing the plugin. `GET /api/drivers/hplip` reports the installed HPLIP version, whether the plugin is installed (`/var/lib/hp/hplip.state` plus the plugin `.so` files), the exact file name to download (`hplip-<version>-plugin.run`, the version must match HPLIP) and the devices waiting for it. `POST /api/drivers/hplip/plugin` receives the `.run` (streamed to disk, name and version checked first), optionally HP's detached `.asc` signature (`?kind=asc`, stored beside it so `hp-plugin` can verify it), runs `hp-plugin -i -p <file>` non-interactively, verifies the result and re-probes the scanner. Failures come back with a code and the tail of hp-plugin's output.
- **Admin → Scanner: "Drivers & firmware".** The ScanSnap firmware row moves here and gets a sibling row for the HP plugin (installed version, or the file to download from developers.hp.com with a link). When an HP MFP that needs the plugin is plugged in, an amber card replaces "No scanner detected", like the ScanSnap firmware card. Overview lists it under *Needs attention*; Scan Studio says "*{model} needs the HP plugin*" instead of "no scanner".
- `plugin_required` on the scanner status (next to `firmware_required`), an `hp-mfp-hpaio` scanner profile for anything on SANE's `hpaio` backend, and unit tests for the models.dat lookup, version checks, state parsing and sysfs detection (`test/hplip-plugin.test.mjs`).
- `install.sh` installs `hplip` (provides `hp-plugin`) and `gnupg`.
- Unit tests for the Driver Center engine (`test/driver-center.test.mjs`: catalog matching, upload classification, hwdb/PPD-index lookups, device needs, deb control parsing, registry, firmware install guard rails).

### Changed
- Overview: `ipp-usb` shows *Standby* (neutral) instead of a red *Stopped* when no IPP-over-USB device is plugged in; udev only starts it on demand.
- `docs/KNOWN-LIMITATIONS.md` gains I5: driver uploads run vendor code as root. `docs/SUPPORTED_DEVICES.md` explains the HP plugin requirement.

### Not yet verified on hardware
- The HP plugin install path (`hp-plugin -i -p`, arm64 plugin, M130a scanning through `hpaio`) is implemented and unit-tested around it, but has not yet been run against a real M130a on a hub.
- Likewise `.deb` installation (Canon UFR II LT) and PPD assignment to a live queue through the new page.

---

## [0.3.2] - 2026-09-29

### Fixed
- **Installer could hang while fetching HP LaserJet firmware.** The `foo2zjs getweb` step downloads firmware for seven LaserJet models from third-party mirrors with no timeout and with its output hidden, so an unreachable mirror froze the installation at "Provisioning HP LaserJet cold firmware" with no indication of what was happening. Each download is now capped at 60 seconds, progress is printed per model, failures are listed as warnings in the final report, and the whole step can be skipped with `MANTAPRINT_SKIP_HP_FIRMWARE=1` (the firmware can be provisioned later from Admin → Printers). The NodeSource download also has a 120 second cap.

---

## [0.3.1] - 2026-09-29

### Fixed
- **Installer risk prompt could not be answered.** The prototype notice was shown in a `whiptail` dialog, which cannot take over the keyboard when the installer's output is piped (for example `sudo ./install.sh | tee install.log`): arrow keys and Enter were echoed as `^[[B` and typing `y` did nothing. The notice is now printed as plain text on the terminal and the `y` / `yes` / `ya` prompt is read from `/dev/tty`, which works with or without a pipe. `--accept-prototype-risk` and `MANTAPRINT_ACCEPT_RISK=yes` are unchanged.

---

## [0.3.0] - 2026-09-25

**Prototype disclosure release.** MantaPrint is now published as a prototype with its known
security weaknesses documented. There are no functional changes to printing or scanning.

### Added
- **Risk disclosure documents.** `docs/KNOWN-LIMITATIONS.md` lists every known weakness of the Hub, Scan Studio, Scanner PWA, MantaPool and the installers with impact, severity and interim mitigations; `SECURITY.md` now states the prototype status, private reporting through GitHub and the "AS IS" disclaimer; `docs/PROTOTYPE-NOTICE.txt` is the single notice text shown by the installers.
- **Installer risk acknowledgement.** `install.sh` and `apps/mantaman/install-mantaman.sh` show the prototype notice before changing anything and continue only when the operator types `y`, `yes` or `ya`; any other answer exits with no changes. The prompt reads from `/dev/tty`, so it also works when stdin is a pipe. Without a terminal the installers refuse to run unless `--accept-prototype-risk` or `MANTAPRINT_ACCEPT_RISK=yes` is given. The acceptance (time, user, method, host, notice checksum) is recorded in `/etc/mantaprint/prototype-ack.json` or `/etc/mantapool/prototype-ack.json`. Both installers end with a prototype reminder and a hardening checklist.
- **Prototype labels everywhere.** A `PROTOTYPE` badge in the Hub homepage, admin console and MantaPageScan Studio headers (it opens the risk notice), a one-time "I understand the risks" dialog in the admin console, a warning on the admin login, a `PROTOTYPE` badge on the HDMI kiosk and in the Scanner PWA, a permanent warning bar in MantaPool, `PROTOTYPE` in the TUI header, and "(Prototype)" in every page title and PWA manifest.
- `GET /api/health` reports `channel: "prototype"`, `prototype: true` and whether the install-time risk acknowledgement exists.

### Changed
- **New repository:** `mantaplex/mantaprint-prototype`. The hub updater, MantaPool updater, default `repo_url`, package metadata and documentation links point to it.
- **All components are versioned 0.3.0** (Hub, web, frontend and MantaPool) on the new `prototype` release channel.
- **GitHub Releases are always pre-releases** and every release body starts with the prototype warning. `scripts/publish-releases.mjs` now derives the releases to publish from pushed git tags that have a CHANGELOG section, and on a push to `main` it creates the missing tag for the version in `version.json` itself, so a new version only needs a version bump and a CHANGELOG entry on `main`.
- README: prototype warning at the top, install instructions describe the risk prompt, MantaPool port documented as HTTP without TLS, and "Zero-Trace" clarified as covering storage on the hub only.

### Known weaknesses (documented, not fixed in this release)
- Plain HTTP everywhere; shared default admin passwords; CUPS remote administration enabled; unsigned updates; admin tokens in `localStorage` and URLs; wildcard CORS.
- MantaPool: most API routes unauthenticated, password guessing against hubs, admin tokens handed out by SSO, hard-coded enrollment token, unencrypted `ws://` agent channel.
- The installers pipe the NodeSource setup script into a root shell without verification.

---

## [0.2.13] - 2026-09-25

### Fixed
- **Linux Kernel Dead-Route Retention & Reverse Path Filtering Hardening (`99-mantaprint-network.conf`).** Configured `net.ipv4.conf.all.ignore_routes_with_linkdown = 1` and `rp_filter = 2` (loose mode) across all interfaces. When an Ethernet cable is physically unplugged, the kernel immediately bypasses `eth0` routes and switches all outgoing and incoming traffic to Wi-Fi (`wlan0`), fixing the issue where Wi-Fi became unresponsive or unpingable despite being connected.
- **Ethernet & Wi-Fi Route Metric Prioritization.** Assigned metric 100 to Ethernet (primary) and metric 600 to Wi-Fi (fallback). Removed `ConfigureWithoutCarrier=yes` in systemd-networkd to allow graceful route deactivation on cable detachment.
- **Physical Link Carrier Aware Primary IP Resolution.** Updated server and TUI to evaluate `/sys/class/net/<iface>/carrier` before selecting default network paths. When Ethernet is unplugged, Wi-Fi automatically takes over as primary IP and active interface.
- **Kernel Netlink Link Event Monitor.** Extended `ip monitor address` to `ip monitor address link` to detect cable plug and unplug events instantaneously without polling lag.

### Added
- **TUI Network Failover Alert Banners & Role Badges.** Added real-time screen banners on cable unplug/plug, explicit link role capsules (`[● LAN (Utama)]`, `[● Wi-Fi: <SSID>]`, `[KONEKSI UTAMA (FAILOVER)]`, `[CADANGAN (Ethernet Aktif)]`), and bottom status line link indicators (`NET: [● LAN] [○ Wi-Fi]`).

---

## [0.2.12] - 2026-09-25

### Added
- **Responsive Monitor Full-Screen TUI Engine.** Automatically detects the actual monitor resolution and console dimensions via `process.stdout.columns` and `process.stdout.rows`, dynamically expanding framed cards, system telemetry widgets, and lists edge-to-edge. Includes buffer clearing on terminal resize to prevent text artifacting.
- **MantaPool Fleet Management UI/UX Overhaul.** Complete redesign adhering strictly to the MantaPrint Hub dark design language, badges, and status widgets.
- **Central Peripherals Management in MantaPool.** Dedicated tab to inspect, rename, assign locations, and configure mDNS hostnames for all printers and scanners attached to adopted hubs.
- **1-Click Seamless SSO into Hub Admin.** Directly jump into individual MantaPrint Hub admin dashboards from MantaPool without repeated login prompts.

## [0.2.11] - 2026-09-25

### Added
- **OCR in MantaPageScan Studio.** Text recognition (Indonesian + English) runs in the browser
  with tesseract.js in a Web Worker; the engine and language data are served by the hub itself
  (`/ocr/<version>/`), so it works on networks without internet and pages never leave the device.
  New scans and imports are recognised automatically (can be turned off in the OCR tray), and a
  page is recognised again after it is rotated, straightened or cropped.
- **Workbench from MantaPDF.** All pages of a scan session show as one continuous document with
  Ctrl+wheel / pinch zoom, fit width and a pan tool; pages can still be reordered in the pages
  rail. Recognised text can be selected and copied, and searched with Ctrl+F.
- **Page objects:** pen, highlighter and eraser; text boxes; rectangle, rounded rectangle,
  ellipse, line and arrow; signatures (drawn or uploaded, up to four kept on the device), check,
  cross, date and images; blackout/whiteout redaction with an optional label. Objects can be
  moved, resized, restyled, duplicated and deleted, follow the page when it is rotated or
  cropped, and are listed in the **Objects** manager at the top right. Undo/redo covers them.
- **Export:** searchable PDF (invisible OCR text layer), plain text (.txt) and Word (.docx).
  Objects are painted into exported pages; recognised words under a redaction are left out of
  every export, the text layer and search.

### Fixed
- Undo could restore a state captured after the change instead of before it (history snapshots
  were taken lazily inside a React state updater).

## [0.2.10] - 2026-09-25

### Added
- **Direct-connect mode.** When the Ethernet cable is plugged in but no DHCP server answers for
  60 seconds (a laptop plugged straight into the hub, or a locked-down network), the hub takes
  `10.11.12.1/24` and serves DHCP `10.11.12.10`-`10.11.12.20` with itself as gateway, so the
  laptop can open `http://10.11.12.1/` and set the real network up. Uses `dnsmasq` (DHCP only,
  DNS off), falling back to systemd-networkd's DHCP server. Ends automatically when a real
  address arrives or the cable is unplugged; Start now / Cancel / Stop in the HDMI console and
  the web admin. The countdown is shown on every HDMI console tab.

### Fixed
- **Static IP could not be applied.** The TUI was rejected as unauthenticated, sent `dns`
  instead of `dns1`, and the netplan file it relied on sorted before Armbian's defaults so DHCP
  kept winning. Apply now edits the configuration of whichever stack owns the port
  (NetworkManager profile, a `05-mantaprint-<if>.network` networkd file, or iproute2 re-applied at
  boot), validates first, and makes the gateway optional.
- Changing the IP from the web admin now answers before the address changes and shows the new
  address to reconnect to; switching back to DHCP also asks for confirmation.
- HDMI console: IP fields are editable while direct-connect runs, and the confirmation dialog is
  no longer clipped off the bottom of the screen.

## [0.2.9] - 2026-09-25

### Changed
- **Driver matching, readiness and HP firmware overhaul.** A QA/QC audit found the driver matcher
  frequently picked the wrong PPD (or a generic PCL/PostScript fallback) while still enabling and
  broadcasting the queue as if it worked. See `docs/12-driver-compatibility.md` for the full
  write-up. Fixed, and verified against the real driver packages `install.sh` installs:
  - Canon LBP6018 (CAPT) vs. LBP6018L (UFR II LT) resolved to the same, wrong PPD depending on
    filesystem iteration order (a driver-version-suffix in one PPD's nickname was mangling its
    generated match candidates into unmatchable strings).
  - HP's own "Product" aliases in its `.drv` files (e.g. the M101-M106 family PPD covering M102a/
    M102w/M104a/M104w/M106w) were never indexed, so several real, already-installed HP drivers
    were unreachable by their retail model names.
  - Brother P-touch/QL label printers (`printer-driver-ptouch`) were never queried at all.
  - Generic ESC/POS clones (Xprinter and similar) were misclassified as 9-pin dot-matrix printers.
  - A curated vendor alias list's stated preference order (e.g. Epson L3210 → prefer the L3250
    filter) wasn't honored — ties were decided by driver-list iteration order instead.
- **Per-printer readiness**, computed by `printer_manager.py` and shown in `/admin` → Printers (a
  pill, a detail card with the reason, and a *Needs attention* entry on Overview): `ready`,
  `needs_firmware`, `provisioning`, `needs_review` (only a fuzzy match, or its filter chain looks
  broken) or `unsupported` (no real driver exists). Only `ready` queues are broadcast over
  AirPrint now — previously every queue was broadcast identically regardless of driver confidence.
- **`docs/SUPPORTED_DEVICES.md`** corrected: HP LaserJet 1018/1020/P1005–P1505 genuinely need a
  firmware upload every power-cycle (HPLIP's own `fw-download=True`); P1102/P1102w/M12a/M15a/M102a
  do not (the previous "P1102 needs an x86_64 host / proprietary HPLIP plugin" note was wrong —
  it prints fine via the open `foo2zjs` filter on ARM64). Models with no real driver in the
  packages this project installs (several Epson, HP MFP, Brother inkjet, Samsung, Fuji Xerox
  models) are now called out as unsupported instead of implied to be "Auto-Provisioned".

### Added
- **Automatic HP firmware provisioning** for the LaserJet models that genuinely need it (1000,
  1005, 1018, 1020, P1005–P1008, P1505): fetched via `getweb` (the GPL tool `foo2zjs` itself
  ships, already installed by `install.sh`) on hotplug, cached under `/mnt/data/firmware/hp/`,
  and delivered by invoking CUPS's own `usb` backend directly — the same transport a normal
  print job already uses, rather than a new low-level USB implementation. A **Provision firmware
  now** button in the printer's side sheet retries on demand. The previous implementation looked
  for foo2zjs's firmware-loader scripts at `/usr/sbin`/`/usr/bin`; Debian ships them at
  `/lib/udev`, so it silently never ran.
- `src/core/test_printer_manager.py`: regression tests for every matcher fix above and the HP
  firmware model table, run against the real installed driver packages.
- **ScanSnap firmware from Admin → Scanner.** ScanSnap S300/S1100/S1300/S1300i and fi-60F/fi-65F
  (SANE `epjitsu`) are invisible to SANE until their `.nal` firmware is installed; the hub now
  detects a connected one by USB ID and says which file it needs instead of "no scanner" (admin,
  Overview and Scan Studio). The admin uploads the `.nal` or the ScanSnap installer/driver package;
  the hub streams it to disk, unpacks it with `7z`/`cabextract`/`unshield` (nested archives,
  time/size budget) and installs every firmware file it recognises where `epjitsu.conf` expects it.
  `GET/POST /api/scanner/firmware`, `src/web/server/scanner-firmware.mjs`.
- **Network printer discovery and adoption.** Admin → Printers → *Found on your network* scans
  mDNS (`avahi-browse`) and SNMP (`lpinfo`), and says per printer whether phones can already print
  to it (AirPrint/IPP Everywhere), whether the hub has an exact or only a guessed driver, or none.
  *Add* creates the queue (driverless for AirPrint printers, else the matched driver over raw 9100/
  IPP/LPD) with a readiness verdict like USB printers. Optional **auto-add** (off by default) adds
  and shares, every 15 minutes, only printers phones can't use directly and that have an exact
  driver; a printer the admin deletes isn't re-added. `printer_manager.py discover-network` /
  `adopt-network`, `GET /api/printers/discover`, `POST /api/printers/discover/adopt`,
  `POST /api/printers/discover/settings`.
- **Network printers report real reachability** (`network_reachability` in `/api/status`, from a
  cached background TCP check) instead of always "connected".

### Fixed
- HP's PostScript PPDs (`printer-driver-postscript-hp`, 1,204 models) were never indexed, so
  PostScript LaserJets such as the LaserJet 400 M401 family fell to an unrelated fuzzy match.
- A driver listing a bare-number model (ptouch's `MDL:2300`) could substring-match unrelated models.
- The driver index cache was never rebuilt after an in-place update or a driver package change,
  so the matcher fixes above wouldn't have reached updated hubs; it's now versioned and rebuilt
  when older than the driver directories.
- The hotplug sync pruned readiness for every queue that wasn't USB hardware, including network
  queues.
- `POST /api/printers/delete` read the word "delete" from its own path as the queue name.
- Warning/danger tint on the admin readiness cards didn't apply (overridden by the card's base
  colours).

## [0.2.8] - 2026-09-24

### Changed
- **Homepage rebuilt around adding a printer by hand.** Its purpose is now explicit: help devices that do not receive the hub's mDNS/AirPrint broadcast. Two steps — choose a printer, then per-OS manual steps with the exact values to copy (IP, `printers/<queue>`, `http://…:631/printers/<queue>` for Windows, `lpadmin` for Linux) — plus a collapsed *Still not working?* section.
- **Print a file is a button**, opening a dialog, instead of a full-width drop-zone card; *Scan documents* is a button next to it. *Your print jobs* only appears once this browser has sent a job.
- **Colours follow the logo.** The emerald accent is replaced by a teal `manta` scale sampled from the Mantaplex logo, with `navy`, `plum` and `wine` scales for brand gradients; primary buttons use a teal → plum gradient; the *in progress* status is violet so it stays distinct from teal *OK*. Applies to the homepage, admin console and scan studio.

### Added
- `GET /api/airprint.mobileconfig?queue=<queue>`: an AirPrint configuration profile for a shared printer, so iPhone/iPad can add it on networks without Bonjour (iOS has no add-by-address option). Uses the address the phone reached the hub on.

## [0.2.7] - 2026-09-24

### Changed
- **New Mantaplex logo everywhere.** The round tribal manta sticker (`mantaplex-logo.png`) now replaces the old red manta in the web app header, PWA icons (`icon-192/512.png` plus separate maskable variants on a `#070a11` background), favicon (real multi-size `.ico`), Apple touch icon, the printed test page banner (teal accent, 256 px logo to keep the PDF small), the HDMI/TUI console banner and the MantaMan app. The scanner-illustration `icon.svg` was removed from the manifest.
- **Homepage and admin console redesigned** on the MantaPageScan Studio design language, with a shared design system in `frontend/src/ui/` (see `docs/11-hub-web-app-ui.md`).
  - Homepage: print card with an always-visible drop zone and live printer states, scan card, "your print jobs" (this browser only) and OS-specific device setup. The marketing hero, version badges and the mDNS/hostname dialog were removed from the public page.
  - Admin: seven sections (Overview, Printers, Queue, Scanner, Network, Settings, Updates) instead of stacked cards; "needs attention" list; printer details in a side sheet including the mDNS broadcast name; hub name (mDNS hostname) under Settings; destructive actions behind confirmations; phone layout with a tab bar.
  - Removed misleading labels ("ROOT LEVEL", "Mopria Certified", a hard-coded commit SHA and build date, a `127.0.0.1` IPP URL shown to clients) and the mislabelled "Storage & Hardware" menu.
  - Print uploads from the homepage are sent as the raw request body instead of multipart, avoiding the multipart slicing bug.
  - Frontend bundle reduced from 600 kB to 480 kB; about 9,900 lines of old components removed.

### Security
- `cancel-all`, `clear-history`, the printer attention flag, USB rescan and per-printer test pages now require an admin token (loopback callers such as the HDMI console are still allowed).
- Cancelling a single job requires an admin token or the job token returned to the submitting browser.
- `/api/status`, the SSE stream and public `/api/jobs` no longer expose document titles, submitter addresses or job tokens.

### Housekeeping
- One source of truth for the installed version: `src/web/server/version.mjs` reads `version.json` (`/etc/mantaprint`, `/opt/mantaprint`, repo root) with `package.json` as the last resort. The updater, config manager, status API, printed test page and TUI derive from it; no component carries its own release number any more.
- `config.json` no longer ships or persists a `version`/`current_version`: the config manager fills them from the installed version at load, so an old config cannot report an old release.
- The TUI banner reads the board model (`/proc/device-tree/model`), CPU, OS (`/etc/os-release`), kernel and CUPS version from the host instead of the hard-coded S905X/Armbian/CUPS 2.4.10 strings.
- Unused `common.version` string removed from the frontend translations; frontend lockfile version synced.

### Fixed
- The printed test page, TUI and config defaults showed stale hard-coded versions (v0.2.2, v0.2.0, v0.2.4) — the test page preferred the config's copy of the version over `version.json`.
- Status changes made in the admin were not pushed to open pages immediately (`broadcastStatusToSse` was undefined).
- The "Rescan USB" button called a non-existent endpoint (`/api/printers/rescan-usb`).
- Per-service restart now restarts only that service instead of the whole web stack.
- File names with spaces or non-ASCII characters are preserved on upload (`X-Document-Name` is URL-decoded).

## [v0.2.6] - 2026-09-24

### Changed
- **MantaPageScan Studio rebuilt as a local-first workbench (`/scan`)** (`frontend/src/scan/`):
  - Documents and pages are stored on the client device (IndexedDB, persistent storage) and can be reopened and edited later; nothing is kept on the hub. The hub is used only to acquire pages from the USB scanner (`/api/scanner/scan`, fetched with `?wipe=true`) and to print.
  - New library screen (recent documents, rename/pin/duplicate/delete, search, storage meter) and workbench (pages rail with multi-select and drag reorder, zoom/pan/pinch stage, tool dock with trays, undo/redo, autosave, keyboard shortcuts, EN/ID).
  - Non-destructive edits (rotate, auto/manual straighten, crop, whitening, contrast, brightness, filter modes) rendered in a Web Worker (OffscreenCanvas) with a main-thread fallback.
  - Client-side exporters: PDF (pdf-lib), JPG/PNG (+ZIP), multi-page TIFF (LZW) and File System Access "Save as…" on Chromium; direct print sends a PDF as a raw body to `/api/print/upload`.
  - KTP / ID card 2-in-1 composition now runs on the client (card detection, crop, tone mapping, A4 template).
- Service worker cache bumped to `mantaprint-app-v0.3.0-studio`; `/scan/*` routes are handled network-first.

### Deprecated
- Server-side scan processing endpoints `/api/scanner/enhance`, `/api/scanner/merge`, `/api/scanner/ktp2in1`, `/api/scanner/blank-detect`, `/api/scanner/session-status`, `/api/scanner/wipe-session` now answer with `Deprecation: true` and a `Sunset` header and are logged when called. They are no longer used by any bundled client.

### Removed
- The previous `ScanStudio.jsx` (server-dependent, in-memory session with 5-minute expiry) and its `scan.*` translation block.

---

## [0.2.5] - 2026-09-24

### Changed
- **Scan Studio UI & Workflow Simplification**: Removed redundant 'Bake Permanently to Server' UI button and handler from Scan Studio.
- Image adjustments, enhancements, and color filters are seamlessly baked client-side during document export (PDF, JPEG, PNG) and photocopy workflows.
- Eliminates 404 source image errors when testing with uploaded files.

---

## [v0.2.4] - 2026-09-23

### Fixed
- **OS Print Guides Accuracy & Protocol Hardening (`OSGuides.jsx`)**:
  - Completely purged phantom RAW Port 9100 configuration steps across all operating system guides. MantaPrint strictly uses IPP / IPPS Driverless architecture on Port 631.
  - Implemented 2-step progressive disclosure: Mode 1 Auto-Discovery (AirPrint / Mopria / Bonjour / Avahi) vs Mode 2 Manual IPP Everywhere (for enterprise networks with Wi-Fi AP Client Isolation).
  - Replaced dead-end iOS IPP URL copy button with 1-click Web Direct Print navigation CTA.
  - Added missing `sudo` prefix to Linux CUPS administrative commands (`sudo lpadmin -p ... -m everywhere`).
  - Added native ChromeOS Generic IPP Everywhere setup instructions.
- **mDNS Broadcast Persistence & Avahi Daemon Sync (`server.mjs`)**:
  - Patched `probePrinterTelemetry()` to forward custom queue broadcast names (`customMdnsConfig.custom_broadcast_names`) into `writeAvahiService()`, eliminating the race condition where periodic background polling clobbered user-defined broadcast names.
  - Switched Avahi configuration reload mechanism from `systemctl reload` to `systemctl restart --no-block avahi-daemon` to ensure immediate binding on interface changes.
  - Injected `X-Admin-Token` authentication headers into `MdnsSettingsModal.jsx` to prevent HTTP 401 Unauthorized errors when saving custom mDNS names.
- **Admin & Homepage Layout Ergonomics**:
  - Expanded container boundary geometry from `max-w-3xl` to `max-w-5xl` across customer and admin views.
  - Decoupled single-egg Hero status pill into two resilient flex-wrapping badges, preventing text truncation on mobile screens.
- **Admin Telemetry & Real-Time Update Stream**:
  - Embedded real-time `updates` payload (`update_available`, `latest_version`, `channel`) into global SSE `/api/status` stream, enabling instant Admin header and sidebar notification badges.

## [v0.2.3] - 2026-09-22

### Added
- **MantaPrint Customer Homepage Redesign (`/`)**:
  - **Cyber-Minimalist Hero & Identity**: Modern header presenting live appliance status, Zero-Trace privacy badge, and quick links to documentation and administration.
  - **Collapsible & Expandable Dropzone**: High-contrast drag-and-drop file target supporting both expanded and compact states with visual format badges (PDF, PNG, JPG, WEBP) and file-type validation.
  - **Progressive Disclosure Print Modal (`isPrintModalOpen`)**: Two-stage printing workflow separating document selection from print execution; provides fine-grained controls for copy count, color mode (Monochrome / Color), paper orientation (Portrait / Landscape), page ranges, fit-to-page scaling, and duplex options without visual clutter.
  - **Live Active Printer Carousel & Queue Filtering**: Dynamic carousel displaying only active, ready printers with real-time status pills (Idle, Processing, Attention), isolating offline or administratively disabled queues from the customer interface.
  - **Collapsible Native OS Setup Guides**: Step-by-step driverless setup accordions for Apple iOS/macOS (AirPrint), Android (Mopria), ChromeOS (IPP Everywhere), and Windows 10/11 with zero client driver requirements.
- **Admin Console Left Sidebar Navigation Overhaul (`/admin`)**:
  - **Collapsible 240px / 68px Navigation Rail**: Replaced monolithic horizontal tabs with a space-efficient left rail that collapses to an icon-only dock with hover tooltips and persistent state in `localStorage`.
  - **Off-Canvas Mobile Drawer**: Slide-in navigation drawer with backdrop dismiss for responsive maintenance on mobile phones and tablets.
  - **Three Structured Operational Pillars**:
    - **Operasional**: Ringkasan & Telemetri (System Overview), Antrean & Pengaturan Printer (CUPS Print Queues), MantaPageScan & PWA (Scanner clients and pairing).
    - **Infrastruktur**: Jaringan & Hotspot (Wi-Fi, Ethernet, VLANs), Sistem & Diagnostik (Hardware vitals, storage tiering, Netlink sockets), Akun Admin & Keamanan (Profile & password hash).
    - **Pemeliharaan**: Pusat Pembaruan (Appliance OTA Updater with pre-update backups and 1-click snapshot rollback).
  - **Ambient Hardware Vitals Footer Pill**: Real-time telemetry indicators docked at the bottom of the navigation rail displaying CPU SoC temperature, system RAM utilization percentage, and CUPS daemon status.
  - **Sticky Container Decoupling**: Decoupled the sidebar layout from the scrollable main content body, preventing unwanted scroll-sync jumps during administrative workflows.
- **MantaPageScan Autonomous Scanner Studio & Offline PWA (`apps/scanner-pwa`)**:
  - **Ecosystem Rebranding**: Harmonized naming from WebScan Studio to **MantaPageScan** across web manifests, app headers, and pairing modals.
  - **Client-Side Image Processing Engine**: Pure JavaScript HTML5 Canvas workbench featuring Integral-Image accelerated Sauvola local adaptive binarization, horizontal projection profile deskew, soft-knee paper whitening, and dual-layer wet stamp & signature preservation.
  - **KTP / ID Card 2-in-1 Guided Scan**: Two-pass alignment workflow auto-segmenting CR80 ID cards and synthesizing front and back sides onto a standardized ISO A4 canvas.
  - **Client-Side PDF Synthesis**: Direct in-memory multi-page document compilation via `pdf-lib` without transmission to server.
  - **In-App PWA Updater (`usePwaUpdate`)**: Automatic service worker lifecycle management with `skipWaiting` and `clientsClaim`, non-intrusive update prompt toast, and 1-click refresh to activate newly deployed PWA bundles.
- **MantaPool Console Fleet Orchestrator (`apps/mantaman`)**:
  - **Unified Brand Alignment**: Rebranded the centralized enterprise fleet manager to **MantaPool Console** (formerly MantaMan) while preserving 100% backward compatibility for configuration paths and systemd daemons.
  - **Standardized Port 8443 Deployment**: Native HTTPS/HTTP service running on port 8443 under dedicated unprivileged system user `mantaman` with hardened systemd unit sandboxing (`NoNewPrivileges`, `ProtectClock`, `LockPersonality`, `RestrictAddressFamilies`).
  - **Automated GitHub OTA Updates (`manta-pool-updater.mjs`)**: Self-hosted update engine for MantaPool Console featuring GitHub Releases polling, automated pre-update backups, and atomic rollback capabilities.
  - **SQLite WAL Hardening & Atomic Snapshots**: Integrated `PRAGMA wal_checkpoint(TRUNCATE)` and atomic `VACUUM INTO` backup creation to eliminate snapshot corruption in high-concurrency environments; cleans stale WAL/SHM companion files during rollback.
  - **React ErrorBoundary & Defensive Null-Safety**: Added cyber-industrial fallback error boundary card and comprehensive null guards across WebSocket event listeners and fleet metrics.
  - **Keepalive Watchdog**: 30-second ping/pong heartbeat watchdog on console WebSockets (`wssConsole`) preventing zombie connections through reverse proxies and NAT gateways.
- **Full Bilingual Localization Synchronization**:
  - 100% translation parity across English and Indonesian (Bahasa Indonesia) for all new navigation components, dropzone states, print configuration dialogs, and fleet operations.

### Changed
- Refactored `UserHome.jsx` to adopt modular dropzone and progressive disclosure printing paradigms.
- Updated `AdminDashboard.jsx` and extracted sidebar layout into dedicated `AdminSidebar.jsx` component.
- Standardized MantaPool Console API routing and hardened static asset serving with strict directory boundary validation (`path.sep`).
- Synchronized compiled production distribution bundles for Web Dashboard and MantaPageScan PWA in `src/web/dist/`.

### Fixed
- **Hardware & Driver Compatibility Fixes**:
  - **Epson L120 / L220 Fallback**: Added explicit driver aliases in `src/core/printer_manager.py` mapping legacy EcoTank L120/L220 to Gutenprint L110/L210/L310 profiles, preventing incorrect fallback to generic PCL laser driver.
  - **Canon CAPT Paper Size Halt**: Resolved case-sensitivity defect in `prn_lbp2900.c` by switching from `strncmp` to `strncasecmp` and adding Folio/F4 support, eliminating the trailing-edge photo-interrupter paper size mismatch halts on LBP2900/LBP3000.
  - **Canon CAPT SIGFPE Guard**: Added defensive zero checks in `rastertocapt.c` center_pixels routine to prevent potential division-by-zero crashes.
  - **Vendor Scanner Class Hotplug**: Expanded `99-mantaprint-hotplug.rules` to match vendor-specific USB interface class `0xff` (`ID_USB_INTERFACES=="*:0601*:*|*:ff????:*"`), ensuring automated detection for Fujitsu ScanSnap, Canon LiDE, and Epson DS scanners.
- **Missing Hook & Props in UserHome**: Resolved runtime `ReferenceError` on the customer homepage by explicitly declaring the `isPrintModalOpen` state hook and adding `onDirectPrint`, `onRefreshStatus`, and `onNavigateAdmin` to component props.
- **Undeclared Global Scope Crawl**: Verified 0 undeclared globals or missing imports across all frontend components via AST scope crawl.
- **MantaPool Console Blank Screen**: Fixed uncaught `ReferenceError: Server is not defined` in `FleetOverview.jsx` and `ReferenceError: process is not defined` in `UpdateManager.jsx`.
- **MantaPool Base Path Resolution**: Set Vite base path to root-relative (`/`) in `apps/mantaman/frontend/vite.config.js` to ensure deterministic asset loading across varied reverse proxy subpaths.
- **Sidebar Scroll Behavior**: Fixed sticky positioning in `AdminSidebar.jsx` so navigation controls remain accessible regardless of table scroll depth.

### Security
- **Fleet Token Redaction**: Redacted `auth_token_hash` from MantaPool Console `/api/v1/hubs` and `/api/v1/hubs/:id` JSON responses to prevent credential exposure in API inspection tools.
- **Payload Size Limiter**: Enforced a strict 2MB request body ceiling on MantaPool Console HTTP routes to prevent unbounded payload memory exhaustion attacks.
- **Static File Directory Traversal Defense**: Strengthened static file resolution in MantaPool server by validating resolved canonical paths against system path separators (`path.sep`).

---

## [v0.2.2] - 2026-09-21

### Added
- **Deterministic Semantic Versioning Engine**:
  - Implemented unified version fallback and synchronization across `AdminHeader`, `UserHeader`, `AdminDashboard`, and `UpdateManager` to match `v0.2.2`.
  - Added SemVer comparator integration ensuring smooth OTA update availability notifications on appliances running `v0.2.1`.

### Fixed
- **Version Synchronization & Telemetry Drift**:
  - Eliminated stale legacy fallback version strings (`0.1.4`, `0.1.9`, `0.1.0`, `0.1.2`) that rendered when the `/api/status` telemetry endpoint was temporarily slow or unavailable.
  - Fixed `ConfigManager.saveConfig()` in `src/web/server/config-manager.mjs` to preserve the live system version instead of erroneously resetting to `0.0.1`.
- **Appliance OTA Update Detection**:
  - Corrected patch release comparison logic allowing edge appliances to accurately detect and stream GitHub release assets without version mismatch stalls.

---

## [v0.2.1] - 2026-09-21

### Added
- **Native Offline Scanner PWA (`apps/scanner-pwa`)**:
  - Independent, privacy-first Progressive Web App built with React 18, Vite, and Tailwind CSS.
  - Complete client-side document processing in pure JavaScript:
    - **Sauvola Local Adaptive Thresholding**: Canvas-based binarization with Integral Images $O(1)$ box-filtering to whiten paper backgrounds and optimize ink contrast.
    - **Document Rotation**: 90°, 180°, and 270° orientation adjustment.
    - **KTP 2-in-1 Dual Side Alignment**: Combines front and back ID card images onto an ISO A4 printable layout with alignment guides.
    - **Client-Side PDF Compilation**: Stitch multiple flatbed or ADF scan pages into an encrypted or standard PDF document via `pdf-lib` without server-side compute.
  - Cache-First Service Worker (`public/sw.js`) enabling 100% offline document editing and local export.
  - Persistent offline storage in IndexedDB (`idb-keyval`) requested via `navigator.storage.persist()`, immune to Apple Safari 7-day ITP cache eviction.
- **Cryptographic 1-Time Capability Pairing**:
  - **`ScannerPairingManager`**: Issues HMAC-SHA256 capability tokens (`mp_tok_v1.<clientId>.<epoch>.<flags>.<hmac>`) signed with a persistent appliance secret key (`/mnt/data/config/.hub_secret`).
  - **Dynamic Pairing Credentials**: Generates dynamic QR code payloads and 6-digit numeric PINs with a 5-minute (300-second) TTL and automatic expiration.
  - Verified with constant-time equality comparisons (`crypto.timingSafeEqual`) to prevent timing attacks.
- **Hardware Mutex Concurrency Lock (`ScannerHardwareLock`)**:
  - Asynchronous mutual exclusion engine preventing simultaneous access to physical USB scanner hardware (`LIBUSB_ERROR_BUSY`) by multiple network clients.
  - Returns `HTTP 423 Locked` with `Retry-After: 15` and active holder telemetry when a scan is currently running.
  - 90-second watchdog timer automatically cleans up stale or orphaned locks if a client abruptly disconnects.
- **3-Tiered Subnet Auto-Healing (`HubLocator`)**:
  - Autonomous Hub rediscovery engine resilient against DHCP router reassignments:
    - **Tier 1**: Probes last known endpoint (400ms timeout).
    - **Tier 2**: Probes local mDNS hostname `http://mantaprint.local` (600ms timeout).
    - **Tier 3**: Batched 16-worker parallel `/24` subnet sweep in < 1.2 seconds verifying `hub_uuid`.
- **Hub Admin Console Integration**:
  - Added dedicated **"Scanner & PWA"** tab in Admin Console (`frontend/src/components/ScannerPwaManager.jsx`).
  - Real-time Hardware Telemetry & Mutex status banner.
  - Dual service toggles: **WebScan Direct Hub Portal (`/scan`)** and **Remote Scanner PWA API**.
  - Ephemeral 1-time pairing modal with dynamic QR rendering, 6-digit PIN display, and visual 5-minute countdown.
  - Paired client registry table with device platform detection, inline renaming, last-seen timestamp, and 1-click **Revoke**, **Re-authorize**, and **Delete**.
- **Tell-Tale Fail-Safe Diagnostics**:
  - Client state machine reacts immediately to server revocation (`ERR_CLIENT_REVOKED`), purging local tokens and displaying informative diagnostic actions.
  - Searching radar view with manual IP override and **Mode Offline** fallback, allowing users to view and edit saved scans without an active connection.

---

## [v0.2.0] - 2026-09-21

### Fixed
- **Test Page Generation Engine**: Resolved fatal unhandled `TypeError` (`configManager?.get is not a function`) during `/api/print/test`, `/api/printer/test-page`, and `/api/printers/:queue/test-page` requests by adding a safe generic `.get()` key accessor to `ConfigManager` and wrapping script execution in safe resolution fallbacks (`getCurrentSystemLanguage()`, `getCurrentSystemVersion()`).
- **Right Metric Ruler Calibration**: Repositioned the right metric mm ruler on the diagnostic test page away from adjacent graphic containers into a dedicated lateral margin (`540.78 pt` to `567.78 pt`), rendering it with higher z-order to eliminate visual overlap.
- **TUI Static Version Artifacts**: Eliminated hardcoded `v0.0.1` strings in Cyber TUI (`src/tui/app.mjs` and `system/tui/app.mjs`) by introducing dynamic resolution from `version.json` with fallback.

### Added
- **Scanner Hardware Expansion**: Added dedicated hardware profiles in `SCANNER_PROFILES` for:
  - **Canon CanoScan LiDE Series (100, 110, 120, 300)**: 100% native plug-and-play via `sane-genesys` and `sane-pixma` backends with zero proprietary firmware blobs needed.
  - **Fujitsu ScanSnap iX1500**: Flagship touchscreen duplex ADF profile with dual-channel image capture up to 600 DPI.
  - **Fujitsu ScanSnap S1300 & S1300i**: Added firmware provisioning infrastructure (`/usr/share/sane/epjitsu`) and automated setup script (`scripts/install-scansnap-firmware.sh`) for `.nal` microcode deployment.
  - **Epson WorkForce DS-410**: Profile mapped to `utsushi` / `epsonscan2` driver backend with full duplex and long-paper support.
  - **Fujitsu ScanSnap SV600**: Profile with graceful UI advisory explaining overhead laser/camera scanner driver limitations on Linux SANE.
- **Zero-Delay USB Scanner Auto-Sensing**:
  - Updated `udev/99-mantaprint-hotplug.rules` with USB still image interface class (`0601`) to restart hotplug orchestrator on device attach/detach.
  - Enhanced Linux kernel `/dev/bus/usb` real-time hardware watcher in `server.mjs` to invalidate scanner cache and asynchronously broadcast fresh scanner telemetry over SSE in `<300ms`.
- **System Documentation Overhaul**: Completely updated `docs/SUPPORTED_DEVICES.md`, `README.md`, and `CHANGELOG.md` with complete printer and scanner support specifications, driver stacks, and setup instructions.

---

## [v0.1.9] - 2026-09-21

### Added
- **Dynamic Diagnostic Test Page Localization**: Integrated runtime system language and version injection into `src/core/test_page_generator.py` so calibration pages reflect live appliance settings.

---

## [v0.1.8] - 2026-09-21

### Fixed
- **Appliance OTA Updater Post-Install Lifecycle**:
  - Eliminated race condition where newly restarted Node.js daemon pushed initial `IDLE (0%)` SSE event to connected browsers, overwriting the restart spinner.
  - Implemented decoupled, resilient `/api/health` polling loop with exponential backoff and 60-second fail-safe fallback.
  - Forced hard browser navigation (`window.location.href`) upon health recovery to prevent client-side single-page router traps.
  - Added post-update celebration notification banner verifying successful transition to new release.

---

## [v0.1.7] - 2026-09-21

### Fixed
- **mDNS Driverless Broadcast Isolation**: Resolved collision between generic PostScript and driverless IPP Everywhere announcements by ensuring exactly one Avahi publication per physical printer queue.
- **Customer Homepage Printer Filtering**: Enforced display policy on public `/` portal to only show printers explicitly enabled for broadcast by the administrator.

---

## [v0.1.6] - 2026-09-21

### Fixed
- **Single Driverless Broadcast & Purge Generic PostScript**: Silenced CUPS duplicate DNS-SD announcements and enforced pure driverless AirPrint/Mopria PDL raster streams across local network.

---

## [v0.1.5] - 2026-09-21

### Fixed
- **Post-Install Auto-Reload & Avahi mDNS Self-Healing**: Resolved post-install browser reload loops and added automatic recovery for Avahi printer mDNS broadcast daemons.

---

## [v0.1.4] - 2026-09-21

### Added
- **Global Beta Badging**: Added clear Beta indicator badges across Web Dashboard, Admin Console, and Scanner headers.

---

## [v0.1.3] - 2026-09-21

### Added
- **Admin Account Profile Editor**: Added profile management tab in Admin Console allowing administrators to securely update username and password with cryptographic hash verification.
- **Fastly CDN Cache-Busting & PWA Network-First Sync**: Prevented stale cached service workers and assets from surviving appliance updates.

---

## [v0.1.2] - 2026-09-21

### Added
- **Dynamic Header Versioning & Multilingual Diagnostics**: Real-time localized system diagnostics and synchronized version indicators in client headers.
- **System Language Diagnostic Logging**: Aligned all diagnostic and installer log messages with active system locale preference (Indonesian & English).

---

## [v0.1.1] - 2026-09-21

### Added
- **Native CUPS Printer Management & Home Assistant-style Appliance Updater**: Multi-phase OTA update state machine, automatic pre-update backups, and atomic rollback capabilities.

---

## [v0.1.0] - 2026-09-21

### Added
- **MantaPrint Comprehensive Appliance Updater & Versioning Engine**:
  - Lifecycle state machine (`IDLE`, `CHECKING`, `READY_TO_UPDATE`, `BACKING_UP`, `DOWNLOADING`, `INSTALLING`, `RESTARTING`, `VERIFYING`, `COMPLETED`, `FAILED`, `ROLLING_BACK`).
  - Home Assistant OS-style multi-phase progress tracker with embedded cyber terminal log streaming.
  - Automated pre-update snapshot backup to high-endurance storage (`/mnt/data/backups/`) and 1-Click Rollback engine.
  - Pre-flight safety checks: CUPS active print job lock and minimum storage validation (>200MB free on MicroSD, >100MB on eMMC).

---

## [v0.0.1] - 2026-09-20

### Added

#### Universal Driverless Print Engine
- **Universal Driverless Bridge for Restricted OS**: Purpose-built architecture enabling full native printing and scanning on ChromeOS (Chromebooks), Apple iOS/iPadOS, Android, and Windows 10/11 S-Mode without installing vendor drivers or client software.
- **Bundled Multi-Architecture Drivers & 1-Click Plug-and-Play (`drivers/`)**: Pre-packaged Canon UFR II LT binaries for ARM64 and AMD64 (`drivers/canon-ufr2lt/`), native Canon CAPT C raster filter compilation with PPD models (`drivers/captdriver/`), and explicit provisioning of full multi-vendor driver suites (`brlaser`, `escpr`, `foo2zjs`, `hpcups`, `splix`, `libsane-hpaio`, `sane-airscan`) with zero manual steps.
- **Hardware-Verified Benchmarks & Device Matrix (`docs/SUPPORTED_DEVICES.md`)**: Extensive device compatibility documentation covering tested hardware (Canon PIXMA MegaTank G3030 series, Canon LBP6030 CAPT series) and auto-provisioned stacks (Epson EcoTank ESC/P-R, HP LaserJet HPLIP/foo2zjs, Brother brlaser, SANE scanner backends).
- **Smart CUPS USB Backend Wrapper (`mantaprint_smart_usb.c`)**: Lightweight C wrapper (`<72 KB` binary, `<3 MB` RSS) replacing default CUPS USB backend with real-time physical hardware status tracking via USB Control Transfers (`GET_PORT_STATUS`).
  - Pre-flight hardware inspection detecting out-of-paper conditions (`media-empty-warning`) prior to spooling.
  - In-flight mechanical monitoring polling at 4 Hz to detect paper jams (`media-jam-error`) and hardware stalls during actual paper transit.
  - Physical completion guarantee ensuring client jobs stay in `processing` state until pages physically clear the exit rollers.
- **Dynamic IEEE 1284 Driver Resolution (`printer_manager.py`)**: Automatic USB device ID parsing (`MFG`, `MDL`, `CMD`) matching printers against IPP Everywhere, Gutenprint, ESC/P-R, Canon CAPT, HPLIP, foo2zjs, and brlaser driver stacks.
- **Hyphenated DNS-SD mDNS Synchronization**: Real-time Avahi service publication using sanitized hyphenated IP hostnames (e.g. `Canon LBP6030 (192-168-1-114)`) preventing truncation on Windows 10/11 and ChromeOS discovery.
- **Dynamic Netlink IP Watcher**: Linux kernel Netlink socket monitor (`server.mjs`) tracking DHCP renewals, Wi-Fi reconnection, and network interface transitions with 500ms debounce.
- **Synchronous Print Verification API**: `/api/print/upload` with optional `X-Wait-Job: true` header enabling clients to block synchronously until physical printing completes.
- **Diagnostic A4 Vector Test Page Generator (`test_page_generator.py`)**: Custom PDF test page containing dynamic hub telemetry, QR code connecting to local dashboard, 10-step grayscale linearizers, CMYK/RGB swatches, resolution line-pair targets, typography matrices (4pt–16pt), and millimeter registration rulers.

#### WebScan Studio (`/scan`)
- **Interactive Browser Document Scanner**: Modern React 18 + Tailwind CSS scanning suite with flatbed and ADF scanning support via SANE backend.
- **Lossless Horizontal Projection Profile Deskew**: Ultrafast skew angle detection and correction executing in `<15ms`.
- **Integral Image Accelerated Sauvola Binarization**: Adaptive local thresholding delivering crisp photocopier-quality monochrome output for faded or carbon documents.
- **Morphological Illumination Normalization**: Soft-knee paper illumination background whitening eliminating shadows, wrinkles, and ambient lighting artifacts.
- **Dual-Layer Wet Stamp & Signature Color Preservation**: HSV saturation masking preserving vivid colored stamps and signatures while binarizing black-and-white background text.
- **KTP / ID Card 2-in-1 Guided Scan**: Interactive two-pass scan workflow auto-segmenting CR80 ID cards and perfectly centering front and back sides onto a standardized single A4 sheet.
- **1-Click Direct Photocopy**: Immediate document capture, enhancement, and automated dispatch to connected printers without manual file management.

#### Zero-Trace Privacy & Storage Tiering Architecture
- **Volatile RAM `tmpfs` Scans (`/run/mantaprint/scans`)**: 100% of customer scanned documents stream exclusively into ephemeral volatile RAM. Zero customer documents are ever written to persistent MicroSD or eMMC flash memory.
- **Ephemeral Self-Destruct Lifecycle**: Automatic background cleanup purging inactive scan sessions after 5 minutes of idle time.
- **Auto-Wipe on Download**: Immediate file shredding (`fs.unlinkSync`) triggered upon completion of document download streams via `?wipe=true` or `X-Auto-Wipe: true`.
- **Anti-Symlink Traversal Shield**: Security validation strictly rejecting and unlinking symlinks on external media to prevent filesystem boundary escalation.
- **eMMC Read-Mostly Wear Reduction**: System binaries and OS reside on internal eMMC, completely isolated from continuous write churn.
- **MicroSD High-Churn Storage Tiering (`/mnt/data`)**: Hardened filesystem mount (`noexec,nosuid,nodev,noatime,nodiratime,commit=60,errors=continue`) housing CUPS spooling queues (`/mnt/data/spool/cups` bind-mounted to `/var/spool/cups`), automated backups, and persistent configuration.
- **Automatic Fallback RAM-Spool**: Seamless provisioning of a 128MB `tmpfs` RAM spool if MicroSD storage is unplugged or unavailable.
- **ZRAM Compressed Log Partition**: `/var/log` mounted on compressed RAM (`/dev/zram1`) eliminating log-induced flash memory wear.

#### Modern Cyber TUI & 10-Foot HDMI Kiosk
- **Zero-Idle HDMI Lifecycle**: Dynamic display server orchestration powered by Linux kernel DRM hotplug udev rules. Compositor and browser run strictly when an HDMI cable is plugged in, dropping to 0% CPU and 0 MB RAM when disconnected.
- **Clamped Resolution Protection**: Automatic display resolution clamping to 1080p / 720p HD (`wlr-randr`) preventing GPU VRAM exhaustion on 4K televisions.
- **Universal IR Remote Navigation**: Low-latency kernel IR decoder (`ir-keytable`) with NEC and RC-5 protocols, mapped to standard Linux evdev keycodes with a 3-tier FSM navigation model.
- **Native Cyber TUI Console (`src/tui/app.mjs`)**: High-performance Node.js terminal user interface operating on `/dev/tty1` consuming only ~28MB RSS RAM with zero GPU overhead for USB keyboard administration.

#### Multilingual & Enterprise Management System
- **Synchronized Multilingual Engine**: Seamless bilingual localization (English & Indonesian / Bahasa Indonesia) reactive across Web Dashboard, WebScan Studio, Admin Console, and Cyber TUI.
- **Full-Featured Admin Management Console (`/admin`)**:
  - SoftAP Hotspot provisioning (`mantaprint-softap.sh`), Wi-Fi scanning (WPA2, WPA3, 802.1x Enterprise EAP-PEAP), and Ethernet static/DHCP configuration with 802.1Q tagged VLAN support.
  - Real-time CUPS queue management (pause, resume, cancel job, purge all).
  - Timezone and NTP synchronization engine.
  - Live hardware telemetry gauges: CPU core temperature, RAM usage, swap activity, storage tiering health, and IPP ink/toner status markers.
- **One-Command Automated Appliance Installer (`install.sh`)**: End-to-end automated installation script provisioning CUPS, SANE, Avahi, Node.js 20 LTS, Python dependencies, storage tiering mounts, udev rules, and systemd units across Debian, Ubuntu, Armbian, and Raspberry Pi OS.

---

