# 📄 MantaPageScan (PWA Studio)

### Autonomous Offline Progressive Web App & Client-Side Scanner Studio for MantaPrint Hub

A standalone, privacy-first Progressive Web Application (PWA) designed to connect locally and securely with **MantaPrint Hub** without transmitting customer documents across the internet or writing them to flash storage.

---

> [!CAUTION]
> **PROTOTYPE - NOT FOR PRODUCTION OR SENSITIVE DATA.** MantaPageScan PWA is part of the MantaPrint prototype and has known, unfixed security weaknesses. Pairing tokens and scanned pages travel over plain HTTP.
> See [docs/KNOWN-LIMITATIONS.md](../../docs/KNOWN-LIMITATIONS.md) and [SECURITY.md](../../SECURITY.md). Provided "AS IS", without warranty of any kind.

> [!NOTE]
> **Ecosystem Nomenclature**:
> **MantaPageScan** represents the evolution and official brand for MantaPrint's document digitization suite—spanning both the embedded browser studio (`/scan`) and the installable, standalone Progressive Web App (`/scanner/`).

---

## Key Features

1. **1-Time Durable Capability Pairing**:
   - Uses cryptographically signed HMAC-SHA256 capability tokens (`mp_tok_v1.<client_id>.<epoch>.<flags>.<hmac>`) signed with the Hub appliance secret.
   - Pairs seamlessly via dynamic QR code or 6-digit numeric PIN generated in the Hub Admin Console (`/admin` -> *Operasional* -> *MantaPageScan & PWA*).
   - Persists indefinitely in `IndexedDB` with `navigator.storage.persist()`, bypassing Apple Safari's 7-day ITP cache wipes.

2. **3-Tiered Auto-Healing Hub Discovery (`HubLocator`)**:
   - Resilient against DHCP router IP reassignments:
     - **Tier 1**: Probes last known endpoint (400ms timeout).
     - **Tier 2**: Probes mDNS OS hostname `http://mantaprint.local` (600ms timeout).
     - **Tier 3**: Batched 16-worker parallel `/24` subnet sweep in < 1.2s matching constant `hub_uuid`.

3. **100% Client-Side In-Browser Document Processing**:
   - **Sauvola Local Adaptive Thresholding**: Integral-image accelerated $O(1)$ binarization running directly in pure JavaScript on HTML5 Canvas to eliminate paper shadows, creases, and smudges from receipts and documents.
   - **KTP 2-in-1 Guided Merger**: Interactive workflow that crops ID-1/CR80 cards and aligns front and back sides onto a standardized ISO A4 canvas with alignment marks.
   - **Dual-Layer Stamp & Wet Signature Preservation**: HSV color filtering preserves vivid colored ink stamps while binarizing black-and-white background text.
   - **Direct PDF Compilation**: Uses `pdf-lib` to stitch multiple ADF or flatbed pages into a single PDF entirely inside client memory.

4. **In-App PWA Updater (`usePwaUpdate`)**:
   - Non-intrusive service worker update detector listening for `waiting` worker states.
   - Automatically issues `skipWaiting` and `clientsClaim` upon user confirmation.
   - Displays a sleek cyber-industrial toast notification with 1-click instant reload to activate newly deployed PWA bundles.

5. **Hardware Mutex Lock Protection**:
   - SANE backends (`scanimage`) fail if multiple processes access the USB interface simultaneously (`LIBUSB_ERROR_BUSY`).
   - MantaPrint Hub enforces an asynchronous mutex (`ScannerHardwareLock`) with a 90-second watchdog. If a scan is currently active, other clients receive HTTP 423 `SCANNER_BUSY` with the active holder's name and a countdown timer.

6. **Tell-Tale Fail-Safe Architecture**:
   - If an administrator revokes a device in the Admin Console, the client receives HTTP 403 `ERR_CLIENT_REVOKED`, securely clears its local credentials, and displays the reassuring *"Akses Perangkat Dicabut oleh Admin"* diagnostic screen with 1-click re-pairing or access to stored offline scans.
   - If the Hub is offline, the client provides a radar pulse search screen with options to edit and export existing documents in **Mode Offline**.

---

## Deployment & Hosting

The Scanner PWA can be hosted either directly from the Hub or on a static web host:

### Option A: Direct MantaPrint Hub Serving (Recommended)
Built into the MantaPrint Hub distribution and served directly at:
- `http://mantaprint.local/scanner/`
- `http://<hub-ip>/scanner/`

**Advantages**:
- Zero external internet dependencies; works 100% offline in air-gapped retail environments.
- Completely eliminates Mixed-Content (HTTPS-to-HTTP) blocks.
- One-click PWA installation via mobile Safari and Chrome.

### Option B: Cloud / Static Web Hosting
Can be deployed to GitHub Pages, Cloudflare Pages, Vercel, or Netlify.
- Note: When accessing local Hub endpoints (`http://192.168.x.x`) from a secure public origin, the browser will enforce W3C Private Network Access (PNA). MantaPrint Hub responds with `Access-Control-Allow-Private-Network: true` and dynamic origin reflection to permit this communication.

### Option C: Local Development
```bash
npm install
npm run dev
```

---

## Tech Stack
- **Framework**: React 18 + Vite
- **Styling**: Tailwind CSS (Cyber-Industrial Dark Theme)
- **Icons**: Lucide React
- **Storage**: `idb-keyval` (IndexedDB persistent storage)
- **PDF Generation**: `pdf-lib`
- **QR Scanner**: `jsQR` + HTML5 Canvas fallback
- **Service Worker Lifecycle**: Workbox / custom `sw.js` with `usePwaUpdate` hook
