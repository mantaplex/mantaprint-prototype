# Review & merge plan for `fix/core-stability-and-cleanup`

**Reviewer:** maintainer session (MantaPush One), 2026-10-03.
> **History rewrite notice (2026-10-08).** Every branch and tag of this repository was rewritten to
> remove private device addresses, SSH aliases and a user name from all commits. Commit SHAs changed;
> the ones in this document are the new ones. **Delete your old clone and clone again** (`git pull`
> would merge the old history back in): `git clone -b fix/core-stability-and-cleanup
> https://github.com/mantaplex/mantaprint-prototype.git`. Never commit device addresses, aliases or
> credentials; `AGENTS.md` now explains where they live instead.

**Reviewed:** 9 commits `843cf0b..7abbd46` on top of `v0.3.14` (`2584e80`), 213 files, +2 571 / −34 451 lines.
**Verdict:** *do not merge as-is.* The engineering is mostly good and several fixes are important,
but the branch mixes a product decision (dropping MantaPool, the fleet agent, the Scanner PWA and
legacy code), low-risk security fixes, and behaviour changes that need hardware verification, in
two very large commits. It also ships one visible regression (the hub logo disappears) and no
changelog/version/README updates. The plan below splits it into three releases, each with its own
checklist. Please work **in this branch** following the numbered tasks; the maintainer merges each
release to `main` with the usual version bump + tag + GitHub Release.

> Ringkasan (ID): branch ini belum bisa di-merge utuh. Perbaikan keamanan dan kebocoran resource-nya
> bagus dan akan diambil lebih dulu (0.3.15). Deprecation MantaPool / agent / Scanner PWA disetujui
> pemilik produk, tapi harus lengkap dengan dokumen (0.3.16). Perubahan memori, systemd, udev, dan
> Avahi butuh uji di STB sebelum rilis (0.3.17). Ada satu regresi yang harus diperbaiki sekarang:
> logo hub hilang karena `mantaprint.png` dihapus tapi masih dipakai. Detail tiap item ada di bawah.

---

## 0. Decisions already taken by the product owner

| Topic | Decision |
|---|---|
| MantaPool (`apps/mantaman`), fleet agent (`src/agent`, `mantaprint-agent.service`), `console/`, `src/legacy` | **Deprecate and remove.** Approved. |
| Scanner PWA (`apps/scanner-pwa`, `/scanner`, pairing API, `/api/scanner/stream`) | **Deprecate and remove.** Approved. MantaPage Scan Studio at `/scan` is the only scanner client. |
| `mantaprint-web.service` heap 64 → 128 MB, `MemoryMax` 200 → 256 MB | **Allowed** (hubs ship with ≥ 2 GB RAM), but measured on the STB before release (see 3.1). |
| Release numbering | Stays on **0.3.x** (prototype). Every release = CHANGELOG section + `version.json` + tag + GitHub Release (auto from the workflow on push to `main`). |

---

## 1. Blocking issues (fix first, in this branch)

### 1.1 Hub logo disappears (regression)
`frontend/public/mantaprint.png` and `src/web/dist/mantaprint.png` were deleted in `74077c8`, but
`frontend/src/hub/Home.jsx:55` and `frontend/src/shell/AppHeader.jsx:17` still render
`<img src="/mantaprint.png">`. On this branch the homepage hero and every header show a broken
image. **Fix:** restore the file (`git checkout main -- frontend/public/mantaprint.png`) or point
both components at `/icon-512.png`. Verify with a Playwright screenshot of `/` and `/admin`.

### 1.2 Oversized, unexplained commits
`f92e08f` ("harden backend security, scan studio reliability, and admin console state") and
`7abbd46` ("harden printer provisioning, storage mounts, proxies, and driver workflows") each bundle
10–20 unrelated changes with a one-line message. We cannot bisect a regression through that.
**Fix:** rewrite the branch history into topic commits (one bug = one commit, message = *what was
wrong → what changed → how it was verified*). Suggested split in §2–§4. `git rebase -i` on your
own branch is fine; the maintainer has not merged any of it.

### 1.3 No release bookkeeping
The branch does not touch `CHANGELOG.md`, `version.json`, `package.json`, `frontend/public/sw.js`
(cache name), `README.md`, `docs/KNOWN-LIMITATIONS.md`, `docs/13-driver-center.md` or
`docs/14-lockdown-mode.md`, yet it removes products those files describe. Every release below lists
the docs it must update. Convention: see the `[0.3.14]` section of `CHANGELOG.md` for tone and
detail level (name the bug, the cause, the fix, how it was found).

### 1.4 Committed `dist/`
`0a71853` rebuilds `src/web/dist`. Do not commit dist from a feature branch; the maintainer
rebuilds it at release time (`npm run build:frontend`). Drop that commit from the rebase.

---

## 2. Release 0.3.15 — security fixes and resource leaks (low risk, merge first)

All of these were reviewed line by line and are **accepted** as they are, unless a note says
otherwise. Each bullet should become its own commit.

| # | Change | Review note | Commit title suggestion |
|---|---|---|---|
| 2.1 | `GET /api/system/settings` now requires admin auth and returns `redactConfigForClient()` (`843cf0b`) | Correct and important: the raw config (admin password hash, tokens) was readable by anyone on the LAN. Add a unit test for `redactConfigForClient` (admin/lockdown/secret/token/password keys removed, nested objects cloned). | `fix(api): require admin for /api/system/settings and redact secrets` |
| 2.2 | `/cups/*` proxy admin-or-local only, token headers stripped, 30 s upstream timeout, cleanup on client close | Correct. Previously the CUPS admin UI (`/cups/admin`) was reachable without auth through port 80, which also bypassed Lockdown's intent. Mention this in `docs/14-lockdown-mode.md` ("the CUPS web UI proxy is admin-only"). | `fix(proxy): CUPS web UI proxy requires admin, no header leak, timeouts` |
| 2.3 | `/eSCL/*` proxy honours `portal_enabled`, strips auth headers, timeouts | Correct. | `fix(proxy): eSCL proxy respects portal toggle and cleans up on close` |
| 2.4 | IR remote wizard routes (`/api/hdmi/remote/wizard/*`) require admin-or-local | Correct. | `fix(api): IR wizard routes require admin` |
| 2.5 | `/api/scanner/wipe-session` requires admin-or-local and uses `secureShredFile` | Correct. | `fix(api): wipe-session is admin-only and shreds` |
| 2.6 | `nmcli` Wi-Fi connect built with argv (`runCmdFile`) instead of a shell string; SSID/password escaping for netplan; VLAN parent iface validated; netplan file mode 0600 | Correct; the old code was a shell-injection via SSID/password. **Add a test** in `test/hdmi-network.test.mjs` (create it) that a password containing `"; reboot; "` never reaches a shell: assert `runCmdFile` args. | `fix(network): no shell interpolation for nmcli/netplan, validate VLAN parent` |
| 2.7 | `validateEthernetConfig` accepts `dns` as array or comma list | Fine. | fold into 2.6 |
| 2.8 | Updater: snapshot id validated (`^snapshot-[A-Za-z0-9._-]+$`, resolved path must stay under the backup root); preflight storage check via `statfsSync`; `COMPLETED`/`FAILED` states can start a new check/update/rollback; `compareSemver` delegates to the module function | Correct. Rollback id was a path-traversal. **Test:** `rollbackToSnapshot('../../etc')` rejects without touching the filesystem (mock `fs`). | `fix(updater): validate snapshot ids, statfs preflight, allow retry after COMPLETED/FAILED` |
| 2.9 | New `src/web/server/lib/http-guards.mjs` (SSE client cap 32 + 256 KB buffer eviction, `streamToFileWithLimit`, `sliceFileRange`, `streamFileResponse`, `resolveStaticAsset` with ETag/304 and cache policy) + `test/http-guards.test.mjs` | Good extraction, tests pass. Two asks: (a) `resolveStaticAsset` must keep the SPA fallbacks for `/hdmi` (kiosk) — add a test; (b) `sw.js`, `manifest.json`, `index.html` must stay `no-store` — add a test. | `refactor(server): http-guards module for SSE, uploads, downloads, static assets` |
| 2.10 | `readBody` removes listeners on settle, handles `aborted` | Correct. | `fix(server): readBody no longer leaks listeners on oversized/aborted bodies` |
| 2.11 | Print upload rewritten on `streamToFileWithLimit`, multipart slice via `sliceFileRange`, raw upload renamed instead of copied, page-ranges regex tightened | Correct and lighter on tmpfs. **Test:** a 26 MB body returns 413 and leaves no file in the spool temp dir. | `fix(print): streaming upload with size cap, no 25 MB copy on tmpfs` |
| 2.12 | Test page PDFs get unique names and are deleted after `lp`; `testPageGeneratorScript()` / `printerManagerScript()` / `resolveImageProcessorPath()` helpers | Correct (two admins printing test pages at once used to clobber one file). | `fix(print): per-request test page files, resolved script paths` |
| 2.13 | `ConfigManager`: corrupt `config.json` is backed up as `.corrupt-<ts>` and recovered from `.bak`; `.bak` written on every save; deep-merge of `ntp/admin/scanner/updates`; `MANTAPRINT_STATE_DIR` override | Correct; this closes audit item "power loss truncates config → factory reset" in `docs/06`. **Use `MANTAPRINT_STATE_DIR` in `test/config-telemetry.test.mjs`** so the suite stops reading the developer machine's `/etc/mantaprint/config.json` (that is why two tests have been failing for weeks: the dev box has admin `mimin`). Make the suite green. | `fix(config): recover from corrupt config.json, keep .bak, state dir override` |
| 2.14 | `PrintJobTracker`: per-printer state from `lpstat -p`, no completion when `lpstat` itself fails, `attention` counts as active, eviction prefers finished jobs, `syncing` re-entrancy guard, job printer parsed with `/-\d+$/` | Correct; one stopped printer no longer marks every job on other queues as failed. Add a unit test by extracting `parseLpstatPrinters(stdout)` into a pure function. | `fix(jobs): track printer state per queue, never complete jobs when CUPS is down` |
| 2.15 | USB printer declared offline only after 3 failed IPP probes (never while printing), `cupsenable` when a reachable queue is stopped, `is_published` override respected | Correct. | `fix(printers): debounce USB offline detection, re-enable stopped reachable queues` |
| 2.16 | Avahi auto-restart only when `systemctl is-active` says `failed`, exponential backoff 15 s → 5 min | Correct; the old code restarted avahi on every probe while it was `activating`, which is why mDNS flapped after boot. | `fix(mdns): restart avahi only when failed, with backoff` |
| 2.17 | Avahi service files: exact-name cleanup instead of `*queue*` globs; `mantaprint_web.service` never pruned; XML escaping (`escapeXml` in JS, `_xml_escape` in Python) | Correct; the glob deleted `Queue_2` when `Queue` was rewritten. | `fix(mdns): escape XML and stop deleting sibling queues' service files` |
| 2.18 | `printer_manager.py`: `_disambiguate_queue_name` (serial suffix / counter), IPP-vs-USB dedupe by serial, `LC_ALL=C` for subprocesses, HP firmware looked up in system dirs too | Correct. **Test:** add `src/core/test_printer_manager.py` (pytest or unittest) for `_disambiguate_queue_name`: two identical models → `Name`, `Name_<serial6>`; no serial → `Name_2`. | `fix(core): unique queue names for identical printers, locale-stable lpstat parsing` |
| 2.19 | `image_processor.py`: `fillcolor` matches image mode (grayscale deskew crashed), `qpdf` merge with `pdfunite` fallback and 30 s timeout, context-managed `Image.open`, blank-detect guards for tiny images | Correct. | `fix(core): grayscale deskew, qpdf merge, image handle leaks` |
| 2.20 | `driver-center.mjs`: `installDeb` verifies `dpkg-query` state after `apt-get -f install`; `/lib/firmware/hp` added to firmware dirs | Correct; `apt-get -f` can *remove* the half-installed package and still exit 0. Add a `driver-center.test.mjs` case with a stubbed `run`. | `fix(drivers): fail .deb install when dpkg state is not installed` |
| 2.21 | `hplip-plugin.mjs`: `findModelEntry` no longer matches `m130` to `m1300`; `runWithTty` falls back to a Python pty when `/usr/bin/script` is missing | Correct. Add the `m130`/`m1300` case to `test/hplip-plugin.test.mjs`. | `fix(hplip): exact model prefix match, pty fallback without util-linux script` |
| 2.22 | `lockdown.mjs`: default PIN hash cached (scrypt was recomputed on every `loadConfig`), mtime-keyed config cache | Correct; `/api/status` called `hashPin` on each request. | `perf(lockdown): cache default PIN hash and parsed config` |
| 2.23 | `scanner-firmware.mjs` `receiveUpload` deletes the partial file on error | Correct. | `fix(scanner): remove partial firmware upload on error` |
| 2.24 | `/api/*` unmatched → JSON 404 (`c2fa512`) | Correct. | keep as is |
| 2.25 | Frontend: `adminFetch` clears the token and emits `mantaprint:unauthorized` on 401, App logs out on that event; toast timer ref; SSE merge of partial payloads and native reconnect; `copyTextToClipboard` HTTP fallback; `Drivers.jsx` XHR 401/abort/timeout handling; `useApplianceUpdater` and `Updates.jsx` tweaks; `Settings.jsx` Lockdown PIN field no longer shared between enable/disable dialogs | All fine. Keep `Scanner.jsx` pairing removal for 0.3.16 (it belongs to the deprecation). | `fix(admin): logout on 401, toast timer, SSE partial merge, clipboard fallback` |
| 2.26 | Scan Studio: `useStudioDocument` thumbnail merge, pending-write flush on pagehide/visibility/unmount, single-transaction `refreshCover`/orphan purge, undo fixes (`8b8191b`) + `useStudioDocument.test.js`; `studioDb`, `renderClient`, `pdfExport`, `fileSave`, `annotations`, `Stage`, `ExportSheet`, `DocumentView`, `documentProcessor` follow-ups | Good; commit `8b8191b` is the model for how every other commit should be written. Keep `frontend/package.json` test glob change. | keep `8b8191b`; split the follow-ups into one `fix(studio): …` commit with a message |
| 2.27 | `sw.js`: cache-first for `/assets/` and `/ocr/`, keep same-version cache, never intercept `/cups/`, `/eSCL/`, cross-origin | Fine. The cache name is bumped by the maintainer at release time (`mantaprint-app-v0.3.15`). | `fix(pwa): cache-first for hashed assets and OCR models` |
| 2.28 | `.github/workflows/ci.yml`: runs `npm test` at the root and `npm run lint`; python glob fixed (`0f47447`) | Fine, but CI will stay red until 2.13 makes the backend suite green. | keep |

**Docs for 0.3.15:** `CHANGELOG.md` `[0.3.15]` (Fixed: one bullet per row above that a user can
notice), `docs/14-lockdown-mode.md` (CUPS proxy note), `docs/KNOWN-LIMITATIONS.md` (close the
items this fixes: config corruption, CUPS UI exposure; add nothing new).

**Verification before handing over:** `node --test test/*.test.mjs` green (no "two known
failures" any more), `npm test --prefix frontend` green, `npm run lint`, `npm run build:frontend`
succeeds, Playwright screenshots of `/`, `/admin` (Overview, Printers, Scanner, Settings), `/scan`.

---

## 3. Release 0.3.16 — deprecation of MantaPool, fleet agent, Scanner PWA, legacy

Approved by the product owner. Do it as **one commit for the deletions** and **one commit for the
docs**, so the diff is reviewable.

### 3.1 Code removal (already in the branch, keep)
- `apps/mantaman/**`, `apps/scanner-pwa/**`, `console/**`, `src/agent/**`, `src/legacy/**`,
  `src/web/image_processor.py` (duplicate of `src/core`), `src/web/public/**` (stale dist),
  `system/reference/**`, `system/systemd/heykprint-*.service`, `system/bin/heykprint-*`,
  `system/tui/app.mjs` (duplicate of `src/tui`), `qa/verify_security_hardening.mjs`,
  `docs/07-*`, `docs/08-*`, `systemd/mantaprint-agent.service`, `test/scanner-pairing.test.mjs`.
- `install.sh`, `scripts/*.sh`, `package.json`, `updater.mjs`: agent references removed (keep).
- Server: pairing/clients/stream routes answer **410 Gone** with `Deprecation: true`
  (keep; good), `remote_pwa_api_enabled` removed from config/API (keep), `/api/scanner/probe`
  without `hub_uuid`/`pwa_api_enabled` (keep).
- `scanner-pairing-manager.mjs` reduced to `scannerHardwareLock` (keep; consider renaming the file
  to `scanner-lock.mjs` in the same commit and updating the import).
- `Scanner.jsx`: pairing modal and "Pair a device" removed, `remote_pwa_api_enabled` switch
  removed (keep). Also remove the now-dead i18n keys `adm.scanner.pair*`, `adm.scanner.pwaApi*`,
  `adm.scanner.clients*` from `frontend/src/i18n/ui.js` **in both `admEn` and `admId`** and run the
  parity check (`walk(admEn)` vs `walk(admId)` must be identical; see `docs/13-driver-center.md`
  for the one-liner the maintainer uses).

### 3.2 Things the branch forgot
- **Upgrade path on existing hubs.** The updater only rsyncs `src/core` and `src/web`; it never
  disables `mantaprint-agent.service`, so updated hubs keep a failing unit (`agent.mjs` no longer
  exists). Add to `install.sh` **and** to `updater.mjs` post-install: `systemctl disable --now
  mantaprint-agent.service 2>/dev/null; rm -f /etc/systemd/system/mantaprint-agent.service
  /etc/systemd/system/heykprint-*.service; systemctl daemon-reload; rm -rf /opt/mantaprint/agent`.
- `src/web/dist/scanner/**` must be deleted from the repo (the branch deletes it, keep), and the
  server must not 404-loop on `/scanner`: return a small HTML page saying the app was retired and
  linking to `/scan` (SPA fallback currently serves `index.html`, which is confusing).
- `AGENTS.md` still lists `mantaprint-agent.service` and the agent memory budget: update it.
- `README.md`: remove MantaPool/agent/PWA sections and the `/scanner` mention; keep the prototype
  banner. `docs/KNOWN-LIMITATIONS.md`: delete section 3 (MantaPool) and S4 (PWA pairing tokens),
  add a line under "Deprecated" listing the removed products and the 410 endpoints.
  `docs/PROTOTYPE-NOTICE.txt` is unaffected. `docs/13-driver-center.md` is unaffected.
- `CHANGELOG.md` `[0.3.16]` → **Removed** section: products, units, endpoints (with 410), config
  keys; **Changed**: `/scanner` retirement page; **Upgrade notes**: what the updater cleans up.
- `version.json` `components`: drop nothing yet (fields are `core/web/frontend`), but remove the
  `smart_usb_backend`/`captdriver` lines only if those also go — they do not.

### 3.3 Verification
Fresh install on the Pi 3 (`./install.sh` from this branch), then OTA update from 0.3.15 on the
STB: `systemctl list-units 'mantaprint-*'` must show no `agent`, `/scanner` shows the retirement
page, `/api/scanner/pairing/generate` → 410, Admin → Scanner has no pairing UI, logo visible.

---

## 4. Release 0.3.17 — behaviour changes that need hardware evidence

Keep these out of 0.3.15/0.3.16. Each is probably right; none is proven on the S905X.

| # | Change | Recommendation | Evidence to attach to the PR/commit |
|---|---|---|---|
| 4.1 | `mantaprint-web.service`: `--max-old-space-size=128 --max-semi-space-size=4`, `MemoryHigh=180M`, `MemoryMax=256M`, `Nice=-5`, IO priority | Accepted in principle (≥ 2 GB hubs). Keep `Nice=-5` out unless there is a measured reason; it starves CUPS filters on a 4-core S905X. Update `AGENTS.md` memory section to the new numbers. | `./scripts/status.sh` before/after on the STB; `systemctl show mantaprint-web -p MemoryCurrent` idle, during a 300 dpi colour scan, and during a 20 MB PDF print; no OOM in `journalctl -k`. |
| 4.2 | Removal of the 60 s `global.gc()` interval | Only together with 4.1. With a 128 MB heap V8's own GC is enough; with the old 64 MB heap the interval was load-bearing. | Same measurement as 4.1 over 30 minutes idle: RSS must plateau, not climb. |
| 4.3 | `ProtectControlGroups` / `ProtectKernelTunables` dropped from the three storage units | **Accepted, and both must go** (not one): any `Protect*` option gives the unit a private mount namespace, so `mount /mnt/data` and the CUPS spool bind-mount done by `mantaprint-storage-manager.sh` were invisible to CUPS and the web service on the host. That is the real bug; say so in the unit file as a comment and in the commit message. Keep `NoNewPrivileges=yes`. | On the STB after reboot: `findmnt /mnt/data /var/spool/cups` from a host shell shows both mounts; `systemctl status mantaprint-storage-init` clean. |
| 4.4 | udev unplug rules use `RUN+="/usr/bin/systemctl --no-block start …"` instead of `SYSTEMD_WANTS` | Accepted (udev ignores `SYSTEMD_WANTS` on `remove`). `--no-block` is required (udev kills RUN programs after ~30 s). | Pull the MicroSD while idle: `journalctl -u 'mantaprint-storage-unplug@*'` shows the run, `findmnt /var/spool/cups` shows the 128 MB tmpfs fallback, CUPS still accepts a job. Re-insert: hotplug re-mounts. |
| 4.5 | avahi `allow-interfaces=<iface>,lo` | Accepted (`mantaprint.local` resolution from the hub itself and the Network page diagnostics need `lo`). | From a laptop: `avahi-browse -art` shows exactly one `_ipp._tcp` entry per queue (no duplicates via `lo`), AirPrint still lists the printer on iOS. |
| 4.6 | `storage-hotplug` / `storage-unplug` units lose `Protect*` | Same as 4.3. | Same as 4.4. |
| 4.7 | `hp-plugin` Python-pty fallback (part of 2.21) | Needs one real run where `/usr/bin/script` is absent (e.g. `mv` it aside on the Pi 3) to prove prompts are still answered. | Job log from Drivers & devices showing both `y` answers and `Plugin … installed`. |

**Docs for 0.3.17:** `CHANGELOG.md` `[0.3.17]` Changed/Fixed with the measurements, `AGENTS.md`
memory numbers, `docs/KNOWN-LIMITATIONS.md` (remove the "storage units run in a private mount
namespace" symptom if it is listed anywhere; it is the root cause of the "spool on eMMC after
boot" reports).

---

## 5. Test and tooling requests (apply across the three releases)

1. Backend suite must be green: fix `test/config-telemetry.test.mjs` with `MANTAPRINT_STATE_DIR`
   (2.13). No more "two known failures".
2. New unit tests listed in §2: `redactConfigForClient`, nmcli argv, rollback id validation,
   `parseLpstatPrinters`, `installDeb` dpkg state, `findModelEntry` prefix, `resolveStaticAsset`
   fallbacks and no-store headers, Python `_disambiguate_queue_name`.
3. Keep `test/http-guards.test.mjs` and `frontend/src/scan/hooks/useStudioDocument.test.js`.
4. Every commit message: *symptom → cause → fix → how verified*. Commit `8b8191b` is the template.
5. Do not commit `src/web/dist`. Do not bump versions; the maintainer does that at release time.
6. Run `npm run lint` (installer bash syntax + python compile) before pushing.

---

## 6. Order of work (what to do next)

1. **Now, in this branch:** fix 1.1 (logo), rebase into topic commits (1.2, 1.4), make the test
   suite green (2.13 + 5.1), add the tests in §5.2, write the 0.3.15 CHANGELOG section and the
   small doc edits from §2. Push. Ping the maintainer → **0.3.15** goes to `main`.
2. **Then:** the deprecation commit pair from §3, including the upgrade cleanup in `install.sh` and
   `updater.mjs`, the `/scanner` retirement page, README/AGENTS/KNOWN-LIMITATIONS/CHANGELOG. Verify
   on the Pi 3 (fresh) and STB (OTA). → **0.3.16**.
3. **Last:** §4 items as separate commits, each with the measurement in its message. The product
   owner runs the STB checklist from the table and pastes the results. → **0.3.17**.
4. After 0.3.17, re-open `docs/KNOWN-LIMITATIONS.md` and strike everything the three releases
   closed; add the memory budget and the new unit sandbox posture to `AGENTS.md`.

Questions go in this file (append a "Discussion" section) or in the commit message; the maintainer
re-reads this branch before every merge.
