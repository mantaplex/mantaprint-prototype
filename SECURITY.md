# Security Policy

## Status: prototype - not for production

MantaPrint (Hub, Scan Studio, Scanner PWA and MantaPool) is an **experimental prototype**. It has
**known, unfixed security weaknesses** and has **not** been independently audited or
penetration-tested. All releases are published as GitHub **pre-releases** on the `prototype`
channel.

**Do not use it:**

- with personal or sensitive data (ID cards, bank, health or customer records);
- in production, financial, healthcare or other regulated environments;
- on networks reachable from the internet or by untrusted users.

The full list of known weaknesses, their impact and interim mitigations is in
[docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md). The notice shown by the installers is
[docs/PROTOTYPE-NOTICE.txt](docs/PROTOTYPE-NOTICE.txt).

## Supported versions

| Version | Supported |
|---|---|
| 0.3.x (prototype) | Best effort only - no security guarantees |
| < 0.3.0 | No |

## Risk acknowledgement

`install.sh` and `apps/mantaman/install-mantaman.sh` show the prototype notice and refuse to change
the system until the operator answers `y`, `yes` or `ya`. Unattended installs must pass
`--accept-prototype-risk` (or set `MANTAPRINT_ACCEPT_RISK=yes`). The acceptance is recorded in
`/etc/mantaprint/prototype-ack.json` (hub) or `/etc/mantapool/prototype-ack.json` (MantaPool).

## Protections that do exist (not audited)

These measures are implemented, but none of them has been independently verified and they do not
offset the weaknesses above:

- **Scans are kept in RAM on the hub** (`/run/mantaprint/scans`, `tmpfs`), deleted after 5 minutes
  idle or right after download. This covers storage on the hub only; scans still cross the network
  over plain HTTP.
- **Storage tiering**: high-churn data (CUPS spool, backups) lives on a MicroSD mounted
  `noexec,nosuid,nodev`; logs live on ZRAM; a RAM spool is used when no MicroSD is present.
- **Admin endpoints require a session token**, compared with `crypto.timingSafeEqual`; admin
  credentials can be set via `MANTAPRINT_ADMIN_USER` / `MANTAPRINT_ADMIN_PASS`.
- **Input limits**: request payload size limits, validation of queue names and filenames, and
  rejection of symlinks on external media and spool directories.
- **Resource ceilings**: V8 heap limits and systemd memory limits on every daemon.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's
[private vulnerability reporting](https://github.com/mantaplex/mantaprint-prototype/security/advisories/new)
for this repository. Do not open public issues for undisclosed vulnerabilities.

Include the affected component and version, the impact, and the steps to reproduce. Reports are
handled on a best-effort basis; there is no guaranteed response time while the project is a
prototype. Issues already listed in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) do not
need to be reported again.

## Disclaimer

This software is provided "AS IS", without warranty of any kind, express or implied, as stated in
the [MIT License](LICENSE). The authors and contributors are not liable for any claim, damage, data
loss, data leak or other liability arising from its use. You install and operate it entirely at
your own risk.
