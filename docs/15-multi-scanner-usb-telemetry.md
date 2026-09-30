# Multi-Scanner USB Telemetry & SANE Discovery Guide

## 1. Problem Overview & Bug Diagnosis

When attaching multiple USB scanning devices simultaneously to a low-power ARM64 SBC (such as an Amlogic S905X MantaPrint Hub STB), neither scanner was detected in the Web App (`/scan` and `/admin`), resulting in persistent `"Belum Ada Scanner Terhubung"` (No scanner connected) states.

### Tested Hardware Configuration:
1. **Canon CanoScan LiDE 120** (Dedicated USB Flatbed Scanner, USB ID `04a9:190e`, SANE backend `genesys:libusb:001:002`)
2. **HP LaserJet MFP M129-M134** (Multifunction Laser Printer + Scanner, USB ID `03f0:602a`, SANE backend `hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNC7G02072`)

### Root Cause Analysis:

#### 1. SANE USB Bus Enumeration Timeout (Crucial Bug)
- **Previous implementation**: `src/web/server/server.mjs` executed `runCmd('scanimage', ['-f', '%d|%v|%m|%t%n'], 6000)` with a strict **6,000 ms (6 second)** timeout.
- **The reality**: When multiple USB devices (or multifunction devices with USB print + scan interfaces) are connected, SANE must probe multiple backends (`genesys`, `hpaio`, `escl`, `pixma`, etc.) across USB hubs. On low-power ARM64 processors, this probe takes **~9.8 to 14.0 seconds**.
- **Result**: `runCmd` killed the `scanimage` process via `SIGTERM` every single probe. The backend caught the error and returned null, leaving `cachedScanner = null` and rendering all connected scanners completely invisible.

#### 2. Single-Device Return Assumption
- In `probeScannerTelemetry()`, the loop over `scanimage` output executed `return cachedScanner;` on the very first matched line.
- Even if the timeout was raised, only one scanner was stored. The second scanner was completely discarded from state and telemetry.

#### 3. Frontend Inability to Select Scanner
- Neither `MantaPageScan Studio` (`frontend/src/scan/components/trays.jsx`) nor `Admin Scanner` (`frontend/src/admin/sections/Scanner.jsx`) had provisions to switch between multiple connected scanners. The UI only displayed whichever device was first.

---

## 2. Implemented Fixes & Architecture

### Backend (`src/web/server/server.mjs`)

1. **Extended Timeout & SWR Cache TTL**:
   - `SCANNER_PROBE_TIMEOUT`: Raised from `6,000ms` to `25,000ms` (25 seconds).
   - `SWR_SCANNER_TTL`: Raised from `10,000ms` to `30,000ms` (30 seconds) to prevent constant USB bus polling and I/O congestion.

2. **Multi-Scanner Aggregation (`available_devices`)**:
   - Iterates through all lines of `scanimage` formatted output (`%d|%v|%m|%t%n`).
   - Normalizes device IDs, vendor names, and driver names into an array of discovered scanner objects (`allScanners`).
   - Attaches `available_devices: allScanners` to the active scanner status payload.

3. **Active Scanner Selection Persistence (`POST /api/scanner/select`)**:
   - Allows changing the active scanner via `{ device_id: "..." }`.
   - Persists `selected_device_id` into `configManager` (`/etc/mantaprint/config.json`).
   - Re-probes telemetry and selects the persisted device as primary.
   - Accepts `device_id` or `deviceId` in `POST /api/scanner/scan` requests.

4. **Telemetry Exposure**:
   - `/api/status` and `/api/scanner/status` expose `scanners: scannerStatus?.available_devices || [scannerStatus]`.
   - Supports `?fresh=true` or `?rescan=true` query parameters to bypass SWR cache during manual refreshes.

### Frontend UI

1. **Scan Studio (`frontend/src/scan/components/trays.jsx`)**:
   - When `scanner.available_devices.length > 1`, a dropdown selector (`studio-select`) appears in `ScanTray`.
   - Selecting a scanner invokes `POST /api/scanner/select` and updates local scan settings.

2. **Admin Console (`frontend/src/admin/sections/Scanner.jsx`)**:
   - When multiple scanners are detected, displays all devices with individual status badges (`Siap` / `Tersedia`).
   - Provides a `"Pilih Scanner"` button for inactive scanners to switch the active device with immediate feedback.

---

## 3. Hardware & Driver Specific Notes

### Canon CanoScan LiDE 120 (`genesys` backend)
- **Status**: 100% Native Linux/SANE support via `libsane-common`. Zero proprietary firmware required.
- **USB Bus Reset Quirk**: The SANE `genesys` backend executes a USB hardware reset upon closing the scan session (`sane_close_impl`). In kernel logs (`dmesg`), you will observe:
  ```
  usb 1-1.2: reset high-speed USB device number ...
  ```
  This causes the LiDE 120 to momentarily disconnect and re-enumerate over ~1.2 seconds.
- **Workaround / Best Practice**: Never issue back-to-back `scanimage -L` probes in rapid loops (< 3 seconds) after an active scan. The 30-second SWR caching layer prevents probing during re-enumeration.

### HP LaserJet MFP M129-M134 (`hpaio` backend)
- **Status**: 100% Native open-source scanning via `libsane-hpaio`.
- **Proprietary Plugin Requirement**: In HPLIP's internal database (`models.dat`), `[hp_laserjet_mfp_m129-m134]` specifies `plugin=0`. Unlike older HP LaserJets (e.g. M130a with `plugin=64`), this printer/scanner **does NOT require** HP's closed-source proprietary plugin binary (`hp-plugin`). It works out of the box on standard ARM64 Linux installations with `hplip` and `libsane-hpaio`.

---

## 4. Physical Hardware Verification Results

Both devices were physically tested on the SBC running MantaPrint Hub:

1. **Canon CanoScan LiDE 120**:
   - Selected device: `genesys:libusb:001:002`
   - Test resolution: 300 DPI Color
   - Scan command output: `Scanned 2480 lines at 300 dpi ... Scan completed successfully`
   - RAM transfer & wipe: Acquired into `/run/mantaprint/scans/`, downloaded to client, and wiped cleanly.

2. **HP LaserJet MFP M129-M134**:
   - Selected device: `hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNC7G02072`
   - Test resolution: 300 DPI Grayscale
   - Scan command output: `Scanned 2480 lines at 300 dpi ... Scan completed successfully`
   - RAM transfer & wipe: Acquired into `/run/mantaprint/scans/`, downloaded to client, and wiped cleanly.

---

## 5. HP MFP Platen Geometry Quirk & `--br-y` Boundary Fix

### Issue Encountered:
When scanning on HP LaserJet MFP with standard A4 paper size, the web dashboard reported:
`"Gagal memindai dokumen. Pastikan penutup tertutup dan scanner siap."`

### Root Cause:
1. Standard ISO A4 dimensions are `210mm x 297mm`.
2. The HP LaserJet MFP platen hardware limit reported by SANE is `-y 0..296.926mm` and `-x 0..215.9mm`.
3. When `scanimage` was invoked with `-y 297`, the `hpaio` driver strictly rejected the extra 0.074mm with:
   `scanimage: setting of option --br-y failed (Invalid argument)`.
4. `parseSaneError()` lacked a matcher for geometry errors and fell through to the generic cover/ready failure message.

### Resolution:
1. Clamped geometry limits for HP devices: `width` clamped to `215.9mm`, `height` clamped to `296.9mm`.
2. Implemented automatic geometry fallback retry: if `scanimage` returns an error matching `br-y`, `br-x`, or `Invalid argument`, the runner strips the boundary flags and retries immediately with native hardware platen geometry.
3. Updated `parseSaneError()` to recognize `ERR_GEOMETRY_INVALID` and provide clear diagnostic feedback.

---

## 6. Notes on the merged version (0.3.14)

- `POST /api/scanner/select` requires the admin session; it sets the hub's *default* scanner.
- Scan Studio does not call it: the *Scanner* dropdown only sets `device_id` on that page's own
  `POST /api/scanner/scan`, so one user picking a scanner does not change it for everyone.
- The installer changes that travelled with the original fix branch (copying `version.json` and
  `config/` into `/opt`, enabling `mantaprint-tui.service` on tty1) were left out on purpose: they
  are unrelated to scanning and the TUI unit conflicts with the HDMI kiosk on the STB.

