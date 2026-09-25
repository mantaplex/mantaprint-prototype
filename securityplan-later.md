# Architectural Security Blueprint, Enterprise Port Separation & Synchronous Authentication
**Planning Reference & Multi-Disciplinary Debate Notes (Deferred / For Future Release)**  
**Version:** 1.0-RC (Enterprise Security Architecture)  
**Status:** Preserved for future implementation (Non-Active)

---

## 1. Background & Problem Scope

This document details the architectural blueprint evaluated by specialized engineering roles (Security Architect, Linux Systems Engineer, UI/UX Principal Designer, and QA Red Team Devil's Advocate) regarding:
1. Network Port Separation:
   - Ports 80 & 443: Dedicated User Direct Access portal.
   - Port 80 automatically redirects (HTTP 301) to Port 443 (default HTTPS).
   - Port 8080: Dedicated Hub Administration & Configuration Console (Requires login: username `mantaprint`, password `<SET_ADMIN_PASSWORD>`).
2. Enterprise SSL/TLS Certificate Management:
   - Dedicated interface to upload `.crt`/`.key` files and paste PEM text blocks.
   - In-memory pre-flight validation preventing boot loops or daemon crashes.
   - Automated self-signed certificate generation with comprehensive Subject Alternative Names (SAN) for IPs and local domains.
   - Zero-downtime certificate hot-reloading without server restarts.
3. System Hostname Management (System FQDN vs mDNS):
   - Permanent system hostname configuration (`/etc/hostname`, `/etc/hosts`, `hostnamectl`).
4. HDMI TUI Console Authentication Synchronization (`/dev/tty1`):
   - Tab 1 (SYSTEM) and Tab 5 (DIAGNOSTICS) open without passwords.
   - Tab 3 (ETHERNET LAN) and Tab 4 (WI-FI SETUP) trigger interactive password modals.
   - Credentials 100% synchronized with Web Admin via MicroSD (`/mnt/data/config/admin_auth.json`).
   - Physical Root-of-Trust emergency password reset option on Tab 5.

---

## 2. Red Team Debate Matrix & Edge-Case Analysis

### Debate A: Port & Protocol Architecture on :8080 (Cleartext Trap vs Memory Spike)
* **Red Team Challenge:**
  - If port 8080 is plain HTTP, credentials travel unencrypted across the local network and can be sniffed.
  - If port 8080 is HTTPS with self-signed certificates, browsers display warnings and users navigating to `http://<ip>:8080` encounter `SSL_ERROR_RX_RECORD_TOO_LONG`.
  - Spawning a separate Node.js process would breach the 24MB memory limit (`--max-old-space-size=24`).
* **Consensus Resolution:**
  - Port 8080 must enforce HTTPS.
  - Implement a smart multiplexed detector on port 8080: plain HTTP requests receive an instant HTML redirect to HTTPS.
  - A single Node.js process manages 3 native listeners (`http.createServer` on 80, `https.createServer` on 443, and `https.createServer` on 8080) sharing the same TLS Context. Additional memory overhead is only ~2.8MB, maintaining total RSS around 38–44MB (well below the 60MB budget).

### Debate B: Poisoned Key Scenarios & Bootloop Disaster
* **Red Team Challenge:**
  - Corrupt certificate uploads, passphrase-encrypted keys, or keypair modulus mismatches could throw uncaught exceptions and cause permanent crash-loops during boot.
* **Consensus Resolution:**
  - Mandatory in-memory validation using `node:crypto`:
    1. Parse X.509 cert via `new crypto.X509Certificate(certPem)`.
    2. Parse private key via `crypto.createPrivateKey(keyPem)`.
    3. Extract and compare public keys using `crypto.timingSafeEqual()`.
  - Atomic Fallback Mechanism: If a custom certificate fails verification during startup, the server automatically falls back to the emergency `/mnt/data/ssl/hub-selfsigned.crt`. The server never enters a crash loop.

### Debate C: Forgotten Password Scenarios ("Forgotten Password Brick")
* **Red Team Challenge:**
  - If a user changes the password and forgets it, they are locked out of the Web Admin and TUI Tabs 3 & 4.
* **Consensus Resolution:**
  - Emergency reset action on Tab 5 (DIAGNOSTICS):  
    `[RST] 9. Reset Admin Password to Default (mantaprint/<SET_ADMIN_PASSWORD>)`
  - Requires physical keyboard confirmation `[Y/N]` on the appliance. Physical access constitutes the ultimate root of trust.

---

## 3. Technical Specifications

### A. Credential Storage & Hashing Algorithm
* File path: `/mnt/data/config/admin_auth.json` (MicroSD, zero eMMC wear).
* Structure:
  ```json
  {
    "username": "mantaprint",
    "salt": "32-byte-hex-random-salt",
    "password_hash": "64-byte-scrypt-hash",
    "scrypt_params": { "N": 16384, "r": 8, "p": 1 },
    "updated_at": 1726830000000
  }
  ```
* Hashing utilizes native `crypto.scryptSync`.
* Comparison uses `crypto.timingSafeEqual` to eliminate timing attacks.

### B. Web Admin Session Management (:8080)
* Login endpoint: `POST /api/admin/login`.
* Session token (32 bytes crypto random hex) stored in in-memory Map with a 2-hour idle timeout.
* Cookie: `mantaprint_admin_sid=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=7200`.
* Brute-Force Rate Limiting: Maximum 5 failed attempts per IP within 5 minutes, followed by progressive delays and a 10-minute lockout.

### C. SSL/TLS Certificate Management
* Directory: `/mnt/data/ssl/`
  * `hub.crt`: Active certificate
  * `hub.key`: Active private key (chmod 600)
  * `hub-selfsigned.crt`: Default fallback certificate
  * `hub-selfsigned.key`: Default fallback private key
* Automated self-signed certificate generation with OpenSSL 3:
  ```bash
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /mnt/data/ssl/hub-selfsigned.key \
    -out /mnt/data/ssl/hub-selfsigned.crt \
    -subj "/CN=mantaprint.local/O=MantaPrint Appliance" \
    -addext "subjectAltName=DNS:mantaprint.local,DNS:localhost,IP:192.168.1.238,IP:192.0.2.10,IP:127.0.0.1"
  ```
* Zero-downtime hot-reload:
  ```javascript
  const newCtx = tls.createSecureContext({
    key: fs.readFileSync('/mnt/data/ssl/hub.key'),
    cert: fs.readFileSync('/mnt/data/ssl/hub.crt')
  });
  server443.setSecureContext(newCtx);
  server8080.setSecureContext(newCtx);
  ```

---

## 4. Implementation Checklist
When domain certificates or dedicated multi-port separation are scheduled for rollout:
1. Implement backend modules `auth-manager.mjs` and `ssl-manager.mjs`.
2. Multiplex listeners in `server.mjs` (80 -> 443 redirect, 443 user direct, 8080 admin HTTPS).
3. Build the multi-page Vite `admin.html` bundle.
4. Implement interactive password modals in `src/tui/app.mjs`.
5. Run full regression test suite against Red Team failure scenarios.
