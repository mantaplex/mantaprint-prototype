# Print Engine & Hardware Management

## 1. CUPS & Driver Ecosystem

* **CUPS Version**: 2.4.10 (Debian package)
* **CUPS Port**: `631`
* **Printer Configuration**: `/etc/cups/printers.conf`

### Installed Drivers & Specialized Filters:
* **IPP Everywhere / Driverless**: Native IPP direct communication (`ipp://localhost:60000/ipp/print` or `ipp-usb`) for modern printers like Canon G3030 series.
* **Canon CAPT**: `/usr/local/bin/rastertocapt` for legacy Canon LBP printers (LBP6030, LBP2900, LBP3000, etc.).
* **Gutenprint / ESC/P-R**: Epson ink-tank printer raster support.
* **HPLIP / foo2zjs / brlaser**: HP, Brother, and standard monochrome laser drivers.

---

## 2. Dynamic Driver Resolution (`printer_manager.py`)

The file [`src/core/printer_manager.py`](file:///home/dev/mantaprint/src/core/printer_manager.py) executes automated device provisioning:
1. Reads IEEE 1284 Device ID from USB descriptors (`MFG`, `MDL`, `CMD`).
2. Checks whether the connected printer natively supports driverless IPP Everywhere.
3. If non-driverless, matches device strings against the compiled driver PPD repository.
4. Registers and configures the print queue in CUPS via `lpadmin`.
5. Emits an Avahi service definition XML in `/etc/avahi/services/` with AirPrint attributes (`URF`, `pdl`, `note`, `rp`).

---

## 3. Image Processing Engine (`image_processor.py`)

The file [`src/core/image_processor.py`](file:///home/dev/mantaprint/src/core/image_processor.py) provides pre-print document processing:
* **Horizontal Projection Profile Deskew**: Automatically straightens skewed documents in <15ms.
* **Dual-Layer Color Preservation**: Retains colored stamps and signatures while binarizing black-and-white text (Sauvola thresholding + HSV color masking).
* **KTP 2-in-1 Merger**: Combines front and back ID card images (ID-1 / CR80 aspect ratio) proportionally onto a single A4 sheet.
* **Aggressive Memory Management**: Explicit garbage collection (`gc.collect()`) keeps peak RSS under 60MB.

---

## 4. Custom MantaPrint Diagnostic Test Page (`test_page_generator.py`)

The file [`src/core/test_page_generator.py`](file:///home/dev/mantaprint/src/core/test_page_generator.py) generates a diagnostic A4 test page using pure vector PDF rendering (`reportlab`):
* **Dynamic Hub & Printer Diagnostics**: Prints model name, CUPS queue, hub IP address, mDNS hostname, and firmware timestamp.
* **Scannable Wi-Fi & Web Dashboard QR Code**: Dynamic QR code directing smartphones and laptops straight to the local web dashboard (`http://<ip-address>/`).
* **Stepped Grayscale & Continuous Density Gradient**: 10 stepped density patches (10% to 100%) and continuous sweep gradient to verify laser and inkjet halftone linearity.
* **CMYK & RGB Color Swatches**: Color calibration blocks for color printers.
* **Geometric Line-Pair Targets**: Precision line grids (0.5pt to 2pt) for optical resolution verification.
* **Multi-Scale Typography Test**: Positive and inverted text readability tests from 4pt to 16pt.
* **Metric Alignment & Registration Rulers**: Millimeter rulers along page borders and corner registration marks to inspect paper feed alignment.

---

## 5. Canon LBP6030 Telemetry & CRG-325 Toner Status

The official Canon CAPT driver pipeline is integrated with bidirectional telemetry:
* **Driver Binary**: `/usr/local/bin/rastertocapt` compiled specifically for ARM64 Linux.
* **Toner Status**: Reads printer hardware sensors via USB interface descriptors and maps status (OK, Low, Empty) to Web Dashboard, CUPS marker attributes, and Avahi TXT records.

---

## 6. Real-Time Dynamic Netlink IP Watcher & Hyphenated mDNS Naming

* **Kernel Netlink Monitor**: `server.mjs` runs `ip monitor address` to detect IP changes instantly (DHCP renewal, Wi-Fi reconnection, VLAN changes) with a 500ms debounce.
* **Hyphenated IP Format**: Printer mDNS names are standardized with hyphens, e.g., `Canon LBP6030 (192-168-1-114)`. This format prevents name truncation on Bonjour / DNS-SD on Windows 10/11, macOS, Android, and ChromeOS.

---

## 7. Real-Time Print Job Lifecycle & Synchronous Wait

* **Endpoint `/api/print/upload`**: Accepts PDF and image documents up to 25 MB with MIME validation and filename sanitization.
* **Header `X-Wait-Job: true`**: Allows clients to wait synchronously until physical printing completes on printer hardware before returning the HTTP response.
* **Server-Sent Events (`/api/events`)**: State transitions (`pending`, `processing`, `completed`, `canceled`, `stopped`) are broadcasted instantly to all connected browser clients.

---

## 8. Smart CUPS USB Backend Wrapper & Real-Time Physical Hardware Status Tracking

* **The Problem**: Standard CUPS USB backend transfers document bytes to the printer's RAM buffer and immediately exits with code 0 (`CUPS_BACKEND_OK`). Consequently, CUPS marks the job as `completed` (9) to client devices (iOS AirPrint, Android Mopria, Windows, macOS) while the physical printer has only just begun warming up the fuser and picking up paper. If paper runs out or a jam occurs, client devices never receive error feedback.
* **The Smart Wrapper Solution**:
  * Original backend backed up to `/usr/lib/cups/backend/usb-cups-orig`.
  * Lightweight C wrapper (<72 KB binary, <3 MB RSS, zero overhead): `/usr/lib/cups/backend/usb` (source in `src/backend/mantaprint_smart_usb.c`).
  * **Device Discovery (`argc == 1`)**: Transparently delegates to `usb-cups-orig` for fast discovery via `lpinfo -v` and CUPS device caches.
  * **CLI Diagnostics (`--status` / `-s`)**: Tests USB physical connection and reads port status in <2ms.
  * **Pre-flight Hardware Status Check (`argc >= 6`)**: Transmits USB Control Transfer `GET_PORT_STATUS` (`0xA1, 1`) to the printer. If paper tray is empty (`bit 5 == 1`), the wrapper emits `STATE: +media-empty-warning` to CUPS stderr and pauses spooling until paper is refilled.
  * **Spooling**: Executes `usb-cups-orig` as child process with preserved `stdin`/`stderr`.
  * **Physical Print Hardware Tracking Loop**: Post-transfer, the wrapper holds the process active, keeping `job-state` in `processing` (5) during the physical mechanical cycle (fuser warmup, pickup roller, drum transit).
  * **Real-time In-Flight Error Detection**: 4 Hz polling of `GET_PORT_STATUS` detects paper-empty mid-job (`media-empty-warning`) or mechanical paper jams (`media-jam-error`), broadcasting status via IPP RFC 8011 to all client devices in real time, and auto-recovers when resolved (`STATE: -media-jam-error`).
  * **Completion Guarantee**: Wrapper exits with code 0 (`CUPS_BACKEND_OK`) only when the printer physically finishes printing and port status returns to stable idle (`0x18`).
