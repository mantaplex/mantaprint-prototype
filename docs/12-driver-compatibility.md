# Driver Compatibility Engine

`docs/SUPPORTED_DEVICES.md` used to label almost every listed printer "Auto-Provisioned" or
"Plug-and-Play" regardless of whether a real driver existed for it. A QA/QC audit found that
label was often wrong: unmatched models silently fell back to a generic PostScript/PCL PPD (or,
worse, to an unrelated real model that happened to share a few digits) and were still enabled,
shared and broadcast over AirPrint exactly like a verified-working printer. This document
describes the fix: an honest per-printer readiness signal, and the specific bugs and gaps that
signal now exposes instead of hiding.

## Readiness states

Every USB printer `printer_manager.py` provisions gets one, written to
`/var/cache/cups/mantaprint_readiness.json` and merged into `/api/status` and the admin UI:

| State | Meaning | Broadcast over AirPrint? |
|---|---|---|
| `ready` | Driverless IPP Everywhere, or a driver match confirmed exact/high-confidence and its filter chain verified installed. | Yes |
| `needs_firmware` | A small, specific family of HP LaserJets with no persistent flash — printing needs a firmware upload first (see below). | No |
| `provisioning` | Firmware was just sent; the printer is re-enumerating its USB interface. | No (briefly) |
| `needs_review` | Only a fuzzy/heuristic driver match was found, or its filter chain looks broken. The queue works well enough to try, but hasn't been confirmed. | No |
| `unsupported` | No real driver exists for this exact model; a generic fallback PPD was used and likely won't print correctly. | No |

Admins see this as a pill next to the printer (Printers section), a dedicated card with the
reason in the printer's side sheet, and an entry in Overview's *Needs attention* — see
`docs/11-hub-web-app-ui.md`. Previously none of this existed: a queue was either "connected" or
not, with no signal at all about whether its driver actually worked.

The reason `printer_manager.py` computes (`describe_readiness()`) is a stable code (e.g.
`fuzzy_match`, `firmware_downloading`, `hp_no_source`) plus an optional untranslated technical
`detail` fragment (a matched driver's debug description, or a missing filter binary's name) —
never a ready-made English sentence. The hub's admin UI is English/Indonesian throughout
(`docs/11-hub-web-app-ui.md`), so the frontend translates the code
(`frontend/src/i18n/ui.js` → `adm.printers.readiness.reasons`) and folds `detail` in where a
template calls for it.

## What changed in the matcher (`src/core/printer_manager.py`)

All verified against the real driver packages `install.sh` provisions, not just read from
documentation:

- **Canon LBP6018 (CAPT) vs. LBP6018L (UFR II LT).** These are different physical printers using
  different driver packages. A version suffix in the CAPT PPD's nickname (`"...LBP6018, 0.1.4"`)
  was mangling one of the two into an unmatchable string, so the CAPT model always fell through to
  the UFR II LT driver — determined by filesystem iteration order, not anything meaningful.
  Fixed by preferring the PPD's own `*ShortNickName` (revision-free) over `*NickName`, stripping
  known revision-code suffixes, and generating a clean, matchable entry for every model a
  multi-model PPD lists (previously only the *later* slash-separated models got one).
- **HP model "Product" aliases weren't indexed at all.** HPLIP's own `.drv` files spell out every
  rebrand of a shared engine as `Attribute "Product" "" "(HP LaserJet m102a)"` lines — e.g. the
  M101-M106 family PPD covers M102a, M102w, M104a, M104w and M106w. None of this was read, so
  querying for "HP LaserJet Pro M102a" fell back to an unrelated model (HP LaserJet 1020) instead
  of the correct, already-installed driver. Now indexed as searchable aliases.
- **Brother P-touch/QL label printers (`printer-driver-ptouch`) were never queried**, so every
  QL-800/PT-P700/etc. fell to the generic PCL fallback.
- **Generic ESC/POS clones** (Xprinter, Panda, Hoin, unbranded "POS-58/80") were matched against
  the *wrong, narrower* keyword list inside the matcher (separate from, and missing entries
  present in, the page-size-policy list) and were classified as 9-pin dot-matrix printers instead
  of raw ESC/POS passthrough.
- **Epson's curated alias list order wasn't honored.** `L3210: ["l3250", "l3110", "l3100"]` is a
  stated preference (try L3250 first), but two equally-scored matches from that same list were
  decided by driver-list iteration order, not list order — L3210 could resolve to any of the
  three depending on how the directory happened to enumerate.
- Fixing the above safely required a boundary-aware substring check (`contains_as_model`) so e.g.
  "6018" doesn't casually match inside "6018L", or "1005" inside "P1005" (a different HP model) —
  while still allowing a vendor-name prefix to run straight into the model digits, and still
  allowing the heuristic "guess a sibling model with the same filter" step to match across a
  trailing D/W/DW/N-style suffix on purpose.

None of this is guesswork: `src/core/test_printer_manager.py` asserts each case against the real
installed drivers (`python3 src/core/test_printer_manager.py`, safe to run anywhere — it
skips the assertions with a note if the driver packages aren't installed).

## What's still genuinely `needs_review` or `unsupported`

Fixing the bugs above did **not** make every model in `docs/SUPPORTED_DEVICES.md` plug-and-play.
Several documented models have no real driver in the packages `install.sh` installs at all —
Epson L6160/L6170/L6190/L6270/WF-3720/WF-7710/M105/L800 (need `escpr2`, not shipped), several
HP Pro MFP/M2xx models, Brother's inkjet DCP-T-series (only its *laser* line has `brlaser`),
Samsung Xpress and Xerox WorkCentre (unsupported by `splix`), and Fuji Xerox's non-ApeosPort line.
These now correctly report `unsupported` instead of silently installing Generic PCL and
broadcasting as if they worked. A confident, correct fix for these needs a real driver source
(vendor `.deb`, an open-source project, or a customer's own PPD via `CONTRIBUTING.md`) — not a
better string-matching heuristic.

## HP LaserJet firmware (`needs_firmware`)

A specific, narrow family of "host-based" HP LaserJets has **no persistent flash memory in the
print engine**: they lose their firmware every time they're powered off and won't print at all
until the host uploads it again over USB. This is confirmed against HP's own HPLIP compatibility
database (`models.dat`, `fw-download=True`) — not the far more commonly cited "plugin=1" flag,
which usually refers to hpcups's separate proprietary *rendering* plugin (a different thing that
most models, including the P1102/M12a/M102a/M15a/M130a this project's own docs previously and
incorrectly lumped in with this list, do not need at all).

| Automated (getweb has a fetch case) | Genuinely needs firmware, no known automatic source |
|---|---|
| 1000, 1005, 1018, 1020, P1005, P1006, P1007, P1008, P1505 | P1009, P1566, P1567, P1568, P1569 |

**Acquisition** reuses `getweb`, the GPL tool `foo2zjs` itself ships (already installed by this
repo's own `install.sh`): it fetches HP's firmware image from a public mirror and converts it to
the appliance's `.dl` format with `arm2hpdl` — the same pipeline running `sudo getweb 1020` by
hand performs. MantaPrint does not bundle, redistribute or reverse-engineer HP's firmware; it
automates running the same sanctioned tool per hotplugged device instead of a fixed list run once
at install time. Fetched files are cached under `/mnt/data/firmware/hp/` (or a tmpfs fallback) so
a flaky network only costs one retry, not one per power-cycle.

**Delivery** re-invokes CUPS's own standard `usb` backend directly — the exact interface `cupsd`
itself uses to send a real job (`DEVICE_URI` env var, `argv = [job-id, user, title, copies,
options, filename]`) — with the firmware file as the "document". This reuses the same
already-hardware-verified USB claim/transfer/detach logic every other print job on the hub
depends on, rather than a new, from-scratch low-level USB implementation. The previous
implementation looked for foo2zjs's own udev-triggered loader scripts at `/usr/sbin/<name>` or
`/usr/bin/<name>`; Debian ships them at `/lib/udev/<name>`, so it silently never ran.

**When it runs:** automatically on every hotplug sync (which fires on every USB (re)connect —
including the power-cycle that requires firmware in the first place), and on demand from the
admin Printers side sheet's **Provision firmware now** button (`POST
/api/printers/:queue/provision-firmware`), which bypasses the retry backoff.

**Needs on-device validation.** Everything above was verified in this development environment:
the matcher fixes against the real installed driver packages, `getweb`'s full fetch pipeline
(confirmed producing a genuine 128 KB PJL+firmware-image file), the readiness state machine, and
that the CUPS backend invocation is well-formed. What could **not** be verified without real
hardware is the final step — the actual USB bulk transfer succeeding against a real HP LaserJet
1018/1020/P1005/P1006/P1505 and the device re-enumerating afterward. Test this on the appliance
with real hardware before relying on it in production.

## ScanSnap firmware (`epjitsu` scanners)

The Fujitsu ScanSnap S300, S300M, S1100, S1100i, S1300, S1300i and the fi-60F/fi-65F have the same
problem as those HP LaserJets: no firmware in flash. SANE's `epjitsu` backend uploads a `.nal`
file from `/usr/share/sane/epjitsu/` every time it attaches, and — the part that made this look
like "scanner not detected" — when the file is missing, attach fails and the scanner never shows
up in `scanimage -L` at all. Its USB ID is visible to the kernel the whole time.

Unlike HP's, these files have no public, sanctioned download mirror: they are PFU's copyrighted
firmware, shipped only inside Fujitsu's own Windows/macOS ScanSnap software. MantaPrint doesn't
bundle or fetch them. What it automates is everything around that one file:

- **Detection** (`src/web/server/scanner-firmware.mjs`): the list of epjitsu models, their firmware
  filenames and USB IDs is read from the system's own `/etc/sane.d/epjitsu.conf` (with the stock
  sane-backends list as a fallback) and compared against `/sys/bus/usb/devices`. A connected
  model whose `.nal` is missing — or shorter than the `0x100 + 0x10000` bytes SANE's `load_fw()`
  reads — is reported as `firmware_required` on the scanner status, instead of "not detected".
- **Admin → Scanner** then says which scanner is waiting, which file it needs, and where to get
  it, with one upload button. The admin can upload either the `.nal` itself or the ScanSnap
  installer/driver package it came in (`.exe`, `.zip`, `.cab`, `.msi`, `.7z`, a macOS `.dmg`/`.pkg`
  …). The upload is streamed to disk (never held in the 64 MB Node heap) on the MicroSD tier
  when present, and unpacked with `7z`, then `cabextract`, then `unshield` (InstallShield
  cabinets), descending into nested archives up to three levels, with a time and size budget,
  archive listings checked against the budget before extracting, and symlinks discarded.
- **Installing**: a found file with the exact filename `epjitsu.conf` expects is installed as-is;
  a different revision of the same model (`1300_0C2A.nal` for `1300_0C26.nal`) is installed under
  the expected name; a single `.nal` with an unrecognised name goes to the one scanner that's
  waiting. Every recognised file in an installer is installed, so a later swap to another
  ScanSnap model just works. The hub then re-probes, and SANE loads the firmware on its next attach.
- **Scan Studio** shows "*ScanSnap S1300 needs its firmware — ask the hub admin*" rather than
  "no scanner", and Overview lists it under *Needs attention*.

`scripts/install-scansnap-firmware.sh` still works for installing a `.nal` from a shell.

**Needs on-device validation**: the whole pipeline is tested here with synthetic archives (zip,
MS cabinet, cabinet-inside-zip) and fake 65 KB files; a real ScanSnap S1300 attaching with a real
`.nal` could not be tested without the hardware and PFU's files.

## Network printer discovery (`printer_manager.py discover-network`)

Before this, a network printer only existed on the hub if an admin typed its IP address into
*Add network printer* and picked a generic driver preset, and it then reported "connected" forever,
whether or not it was actually switched on.

**Discovery** runs `avahi-browse` for `_ipp._tcp`, `_ipps._tcp`, `_pdl-datastream._tcp` (raw 9100)
and `_printer._tcp` (LPD), plus `lpinfo`, whose `snmp` backend finds older JetDirect-style printers
that never announce themselves over mDNS. Results are merged into one entry per printer (a printer
uses the same mDNS instance name for every protocol it speaks; SNMP results join the printer at the
same address), excluding the hub's own broadcasts. It takes about 3-5 seconds.

**Each printer gets a verdict**, reusing the same driver matcher and 1284 conventions as USB:

| Verdict | Meaning | What adopting does |
|---|---|---|
| `native` | Advertises AirPrint (`URF`) or IPP Everywhere (`image/pwg-raster`): phones can already print to it directly. | Driverless `everywhere` queue, not shared by default — the hub adds nothing for phones here. |
| `driver` | A legacy printer with an **exact** driver match. This is where the hub helps: it makes a non-AirPrint printer printable from phones. | Queue on raw 9100 (else IPP, else LPD) with that driver; shared by default. |
| `review` | Only a sibling-model guess. | Same, not shared by default; readiness `needs_review`. |
| `generic` | No driver for this model is installed. | Generic fallback; readiness `unsupported`. |

Adopted queues get a readiness entry like USB ones (`driver_readiness()` — the same verdict code,
minus the USB firmware step), which the hotplug sync now keeps instead of pruning it as
"unplugged hardware".

**Admin → Printers → Found on your network** lists the results with a scan button and an *Add*
dialog showing the address and driver. **Add network printers automatically** (off by default)
repeats the scan every 15 minutes and adopts only `driver`-verdict printers, sharing them only if
their readiness comes out `ready`. Each address is adopted automatically at most once, so a
printer an admin deletes doesn't come back.

**Reachability**: network queues now report `network_reachability` (`online` / `offline` /
`unknown`) from a background TCP check of the queue's own host and port, cached for 60 seconds, so
`/api/status` never waits on it; an unreachable printer shows as offline with its address instead
of "ready". `dnssd://` queues have no fixed address and stay `unknown`.

## Matcher fixes found while building discovery

- **HP's PostScript PPDs (`printer-driver-postscript-hp`, 1,204 models) were never indexed.** For
  PostScript LaserJets such as the LaserJet 400 M401 family it's the only installed driver, so they
  fell to an unrelated fuzzy match (an M401dn resolved to "HP PSC 1400"). Now indexed; the 875 HP
  models the old index already covered resolve exactly as before.
- **A driver whose 1284 model is a bare number** (ptouch lists the P-touch PT-2300 as `MDL:2300`)
  substring-matched any model containing that number, e.g. a Brother HL-L2350DW. Such entries are
  now indexed by their spelled-out name, and a purely numeric candidate never substring-matches.
- **The driver index was cached forever.** `/var/cache/cups/mantaprint_drivers.json` was reused as
  long as it existed, so indexing improvements (including every Phase 1 matcher fix above) never
  reached a hub updated in place until `install.sh` was re-run. The cache now carries an index
  version and is rebuilt when it's older than the driver directories.

## Testing

```bash
# Matcher, HP firmware table, network discovery parsing/verdicts — against whatever driver
# packages are actually installed (driver-dependent checks are skipped if there are none)
python3 src/core/test_printer_manager.py

# Hub server tests, including the ScanSnap firmware module (conf parsing, sysfs detection,
# synthetic zip/cab archives)
node --test test/*.test.mjs
```
