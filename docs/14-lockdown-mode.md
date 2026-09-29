# Lockdown mode (print-only)

For sites where the hub must expose as little as possible. When lockdown is on, an nftables
ruleset on the hub leaves exactly two things reachable from the network:

- **IPP printing**: `631/tcp`
- **printer discovery**: mDNS `5353/udp` (AirPrint / Mopria / IPP Everywhere keep finding the printer)

plus the admin web (`80/tcp`) **only from the admin IPs/CIDRs the operator lists**, and SSH
(`22/tcp`) from the same list only when explicitly enabled. Everything else inbound is dropped.
Outbound is dropped too, except DHCP, DNS, NTP and mDNS: that also stops update checks from
GitHub and the MantaPool agent. `cups-browsed` is disabled permanently (CVE-2024-47176 family).

**Lockdown is for printing only.** Scanning (Scan Studio, the scanner app, eSCL over IPP-USB),
the public homepage, MantaPool management and OTA updates do not work while it is on. Every
place that offers the switch says so.

## Where the switch is

- **TUI** (screen + keyboard on the hub): Diagnostics tab → *9. Lockdown Mode (print-only)*.
  The dialog shows what will stop working, takes an optional admin IP/CIDR and, when turning
  it off, the PIN.
- **Admin → Settings → Lockdown mode**: same switch, plus the admin IP list, the SSH toggle and
  the PIN change. When no admin IPs are set the admin console is unreachable from the network
  once lockdown is on; only the hub's console can turn it off.

Turning lockdown **off always needs the lockdown PIN** (default `1234`, 4–8 digits, changeable
in Settings; stored as a salted scrypt hash in `/etc/mantaprint/lockdown.json`). Turning it on
needs an admin session or the console.

## Files and services

| Path | Role |
|---|---|
| `src/web/server/lockdown.mjs` | ruleset generator (`buildRuleset`, pure), PIN hashing, enable/disable/config, status (`nft list table`, drop counters) |
| `/etc/mantaprint/lockdown.json` | state: `enabled`, `admin_ips`, `ssh_from_admin`, `pin_hash`, `enabled_at`, `enabled_by` |
| `/etc/mantaprint/lockdown.nft` | the generated ruleset (`table inet mantaprint_lockdown`) |
| `system/bin/mantaprint-lockdown` | `apply` / `clear` / `status` from a shell; used at boot |
| `systemd/mantaprint-lockdown.service` | re-applies the ruleset at boot when enabled (before network/cups/web) |
| `/api/lockdown` (GET), `/api/lockdown/enable`, `/api/lockdown/disable`, `/api/lockdown/config` | console (loopback) or admin session; config needs an admin session |

`/api/status` carries a `lockdown` summary; the admin header shows a red **LOCKDOWN** pill and
Overview lists it under *Needs attention*; the TUI header shows `[LOCKDOWN]`.

## Recovering from a shell

If you are locked out of the web and the console is not at hand but you still have a root
shell (an SSH session that was open before lockdown survives; new ones are refused unless
allowed):

```bash
mantaprint-lockdown clear                       # remove the ruleset now
sed -i 's/"enabled": true/"enabled": false/' /etc/mantaprint/lockdown.json   # keep it off after reboot
```

## What it does not do

- It does not encrypt printing (IPP stays plain; `ipps://` would need a certificate story).
- It does not authenticate print jobs: anyone on the allowed network can print.
- It does not protect against physical access (USB, SD card, console).
- `cupsd` itself stays exposed on 631 and must be kept patched.

See `docs/KNOWN-LIMITATIONS.md`; lockdown is the strongest interim mitigation the hub offers,
not a replacement for the managed-mode design discussed for regulated deployments.
