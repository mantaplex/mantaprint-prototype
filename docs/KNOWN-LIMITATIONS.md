# Known Limitations & Security Weaknesses

> [!WARNING]
> **MantaPrint is a prototype.** This page lists the weaknesses we know about so that anyone who
> installs it can judge the risk. It is not a complete list: the code has not been independently
> audited or penetration-tested. Read it together with [SECURITY.md](../SECURITY.md).

Status: v0.3.0 (prototype channel). Severity is our own estimate for a device on a shared
office/branch LAN.

## 1. MantaPrint Hub (appliance)

| # | Weakness | Impact | Severity |
|---|---|---|---|
| H1 | **HTTP only (port 80), no TLS.** The dashboard, admin console, Scan Studio and all APIs are served unencrypted. | Anyone on the same network path can read or alter logins, admin tokens, print jobs and scanned pages. | High |
| H2 | **Shared default admin credentials** (`mantaprint` / `mantapgan`) on every install until changed. | Anyone who knows the default can take over an unchanged hub. | High |
| H3 | **CUPS remote administration is enabled** (`cupsctl --remote-admin --remote-any`) and CUPS listens on the LAN (port 631). | Printer queues and CUPS settings can be changed from the network, protected only by CUPS' own authentication. | High |
| H4 | **Unsigned updates.** The updater downloads release metadata and the source tarball from GitHub and installs them without signature or checksum verification. | A compromised repository, account or network path can push code that runs as root on every hub. | High |
| H5 | **Admin token handling.** The admin token is kept in browser `localStorage` and can be passed in the URL (`?token=`), where it may end up in server logs and browser history. | Token theft via logs, shared browsers or script injection gives full admin access. | Medium |
| H6 | **Wildcard CORS** (`Access-Control-Allow-Origin: *`) on hub APIs. | Web pages on other origins can call hub APIs from a user's browser. | Medium |
| H7 | **Avahi/mDNS and printer sharing are on by default.** | The hub and its printers are advertised to the whole broadcast domain. | Low |
| H8 | **Local console (TUI/HDMI) has no login.** Anyone with a keyboard on the device can use it. | Physical access gives network and printer control. | Medium |
| H9 | **No audit log** of admin actions. | Misuse cannot be traced after the fact. | Medium |

## 2. Scan Studio & Scanner PWA

| # | Weakness | Impact | Severity |
|---|---|---|---|
| S1 | Scans travel from the hub to the browser over **plain HTTP** (see H1). "Zero-Trace" describes storage on the hub (RAM only), **not** transport. | Scanned documents can be intercepted on the network. | High |
| S2 | Documents are kept in the browser's **IndexedDB, unencrypted**, until the user deletes them. | Anyone with access to that browser profile (shared PCs, kiosks) can open earlier scans. | Medium |
| S3 | Because the hub is not a secure context (HTTP), browser features such as service workers, the async clipboard and `crypto.subtle` are unavailable; some fallbacks are less robust. | Reduced functionality; no client-side encryption possible. | Low |
| S4 | The standalone Scanner PWA pairs with a hub using tokens that travel over HTTP. | Pairing tokens can be intercepted and reused. | Medium |

## 3. MantaPool (fleet controller, `apps/mantaman`)

| # | Weakness | Impact | Severity |
|---|---|---|---|
| P1 | **Most API routes do not check a login session.** | Anyone who can reach the MantaPool port can read and change fleet data and trigger hub actions. | Critical |
| P2 | **Signs in to hubs by trying built-in default passwords** over HTTP. | Depends on the insecure defaults of H2 and sends them across the network. | High |
| P3 | **SSO hands out hub admin tokens** in API responses and in `?token=` URLs. | Hub admin tokens leak to logs, history and anyone who can call the API (see P1). | High |
| P4 | **Hard-coded fleet enrollment token** in the agent and controller. | Rogue devices can enroll into the fleet. | High |
| P5 | **Unencrypted agent channel** (`ws://`), no per-device identity. | Fleet commands and telemetry can be read, spoofed or replayed. | High |
| P6 | HTTP only (port 8443 despite the number), wildcard CORS, default admin `admin` / `mantaprint2026!`, in-memory sessions. | Same class of issues as H1, H2 and H6. | High |

## 4. Installation & supply chain

| # | Weakness | Impact | Severity |
|---|---|---|---|
| I1 | **NodeSource setup script is piped to a root shell** (`curl -fsSL https://deb.nodesource.com/setup_20.x \| bash -`) by both installers when Node.js is missing, without checksum or signature checks. | Whoever controls that script or the network path to it gets root on the device during installation. Also requires internet access. | High |
| I2 | Installers download further packages and firmware from third-party mirrors (e.g. HP firmware via `foo2zjs getweb`). | Same trust issue as I1 for those components. | Medium |
| I5 | **Driver Center installs vendor code as root.** Admin → Drivers & devices accepts vendor files (ScanSnap firmware, HP's HPLIP plugin, PPDs, HP LaserJet firmware, vendor `.deb` packages, installer archives) and installs them on the hub; a `.deb` runs its maintainer scripts as root after a confirmation popup that shows package, architecture, maintainer, dependencies and SHA-256, and the HP plugin is a proprietary installer executed with root rights (its signature is only verified when the admin also uploads HP's `.asc`). The page can also `apt-get install` packages from a fixed allowlist (needs internet). | A malicious or tampered file uploaded by an admin (or by anyone holding an admin token, see H1/H5) gets root on the hub. | High |
| I3 | Proprietary third-party driver packages are bundled under `drivers/`. | Their licenses are not re-verified for redistribution; check them before redistributing. | Legal |
| I4 | No SBOM, no reproducible builds, no signed release artifacts. | Hard to verify what is running on a device. | Medium |

## 5. Process

- No independent security audit or penetration test has been performed.
- No formal threat model.
- No guaranteed response time for vulnerability reports (see [SECURITY.md](../SECURITY.md)).

## Interim mitigations if you run it anyway

1. Install only on an **isolated lab/test network segment** (dedicated VLAN), never internet-facing.
2. **Change the default admin passwords** (hub and MantaPool) right after installation.
3. Firewall the device: allow printing (IPP 631) only from client subnets, and web/admin (80, 8443)
   only from trusted admin machines.
4. Do **not** process personal or sensitive documents (ID cards, bank, health or customer records).
5. Do not expose MantaPool to user networks; run it only where administrators can reach it.
6. Disable automatic updates and install releases manually after reviewing them.
7. Disable services you do not need (e.g. `cups-browsed`, Avahi) and switch off CUPS remote admin
   (`cupsctl --no-remote-admin`) if you do not use it.
8. Clear Scan Studio documents from shared browsers after use.

## What would have to change before this is production software

- TLS on every interface, with managed certificates.
- No default credentials; unique credentials or enrollment per device.
- Authentication and role-based access control on every MantaPool route; no password guessing, no
  tokens in URLs.
- Mutually authenticated, encrypted agent channel with per-device keys and signed commands.
- Signed updates with verification on the device.
- Audit logging, restrictive CORS, hardened CUPS defaults.
- Pinned, verified dependencies in the installers.
- An independent security review and penetration test.
