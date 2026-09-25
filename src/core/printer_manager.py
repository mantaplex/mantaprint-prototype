#!/usr/bin/env python3
"""
MantaPrint Universal Printer Management & Hardware Synchronization Engine
- Zero-delay udev event handling and hotplug provisioning
- Dynamic driver resolution (Gutenprint, escpr, foo2zjs, brlaser, hplip, generic, raw)
- Multi-printer Avahi mDNS publication with full AirPrint & ChromeOS TXT metadata
- Thread-safe, secure subprocess execution (no shell=True injection risks)
"""

import os
import sys
import re
import json
import time
import uuid
import socket
import glob
import threading
import subprocess

try:
    from test_page_generator import generate_mantaprint_test_page
except ImportError:
    try:
        from core.test_page_generator import generate_mantaprint_test_page
    except ImportError:
        generate_mantaprint_test_page = None

CACHE_FILE = "/var/cache/cups/mantaprint_drivers.json"
# Bump whenever rebuild_index() changes what it indexes, so cached indexes get rebuilt.
DRIVER_INDEX_VERSION = 2
# Package installs/removals touch these directories' mtimes.
DRIVER_SOURCE_DIRS = ("/usr/lib/cups/driver", "/usr/share/cups/drv", "/usr/share/cups/model", "/usr/share/ppd", "/opt/mantaprint/drivers")
READINESS_FILE = "/var/cache/cups/mantaprint_readiness.json"
AVAHI_SERVICE_DIR = "/etc/avahi/services"
PRINTERS_CONF = "/etc/cups/printers.conf"

# Generic (unbranded/no real CUPS driver) receipt printers -> raw ESC/POS passthrough.
# Deliberately excludes "zebra"/"label"/"barcode"-family words: those are handled by
# LABEL_BARCODE_KEYWORDS instead, and only as a last resort after the driver-matching loop
# below has had a chance to find a real, branded driver (dymo/ptouch both ship real CUPS
# drivers with real PPDs — routing "LabelWriter"/"QL-800"/"PT-P700" into "raw" here, as an
# earlier version of this list briefly did, would silently throw away a working driver).
RECEIPT_RAW_KEYWORDS = (
    "tmt82", "t82x", "pos80", "pos58", "pos-80", "pos-58", "pos ", " pos",
    "thermal", "receipt", "tm20", "tm-t", "xprinter", "xp-", "xp58", "xp80",
    "xp365", "dtc1250", "rp80", "rp58", "gprinter", "hprt"
)

# Generic (unbranded) label/barcode printers -> the sample.drv Zebra EPL2 PPD fallback.
LABEL_BARCODE_KEYWORDS = (
    "zebra", "zd230", "gk420", "gk410", "gx420", "zpl", "epl", "label", "barcode", "tsc"
)

# Union of both, for is_roll_or_thermal_printer()'s "don't force A4 / fit-to-page" decision:
# that check runs AFTER a driver has already been picked (branded or generic), so it can safely
# use the broad word list without the early-return-order problem match() has to avoid above.
THERMAL_LABEL_KEYWORDS = RECEIPT_RAW_KEYWORDS + LABEL_BARCODE_KEYWORDS

_lock = threading.RLock()

def exec_cmd(args, timeout=10):
    """Executes a command without shell=True to prevent injection vulnerabilities."""
    try:
        res = subprocess.run(
            args,
            shell=False,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", f"Command timed out after {timeout}s: {' '.join(args)}"
    except Exception as e:
        return -1, "", str(e)

def parse_1284_device_id(devid_str):
    """Parses IEEE 1284 Device ID key-value pairs."""
    data = {}
    if not devid_str:
        return data
    for token in devid_str.split(";"):
        token = token.strip()
        if ":" in token:
            k, v = token.split(":", 1)
            data[k.strip().upper()] = v.strip()
    return data

def normalize(text):
    """Normalize text for fuzzy matching (lowercase alphanumeric only)."""
    return re.sub(r"[^a-z0-9]", "", text.lower()) if text else ""

def contains_as_model(needle, hay):
    """True if `needle` occurs in `hay` as a model name, not just as a text fragment.
    normalize() strips every separator, so plain "in" containment can't tell "LBP6018"
    apart from "LBP6018L" or "6018" apart from "60180dpi" — model-number suffix letters
    (L/w/dn/x/...) and extra trailing digits butt right up against the match with nothing
    between them. Reject a hit whose very next character in `hay` is itself alphanumeric,
    since that means `needle` is only a prefix of a longer, different model token.
    Deliberately checks only the trailing boundary: a vendor name or "hp"/"canon" prefix
    running straight into the model digits (e.g. "canoninclbp6018") is normal and wanted, so
    the leading boundary is intentionally left unchecked here — callers with a case where the
    letter right before the digits is itself a meaningful model-family letter (HP's "P"-series
    vs. its bare numeric models, see needs_hp_firmware()) need their own, narrower check."""
    idx = hay.find(needle)
    if idx == -1:
        return False
    end = idx + len(needle)
    return end >= len(hay) or not hay[end].isalnum()

class DriverEngine:
    def __init__(self):
        self.drivers = []
        self._load_or_build_index()

    def _load_or_build_index(self):
        # The cache is only reused when it was built by this version of the indexer and after
        # the last driver package change. Previously any existing cache was reused forever, so
        # an in-place update that improved indexing (or a newly installed driver package) never
        # took effect until someone re-ran install.sh.
        if os.path.exists(CACHE_FILE):
            try:
                cache_mtime = os.path.getmtime(CACHE_FILE)
                newest_driver = max((os.path.getmtime(d) for d in DRIVER_SOURCE_DIRS if os.path.exists(d)), default=0)
                with open(CACHE_FILE, "r") as f:
                    cached = json.load(f)
                if (isinstance(cached, dict) and cached.get("version") == DRIVER_INDEX_VERSION
                        and cached.get("drivers") and cache_mtime >= newest_driver):
                    self.drivers = cached["drivers"]
                    return
            except Exception:
                pass
        self.rebuild_index()

    def rebuild_index(self):
        """Indexes installed printer drivers in ~1.5 seconds."""
        drivers = []

        # 1. Query helper driver binaries
        driver_bins = [
            ("escpr", "/usr/lib/cups/driver/escpr"),
            ("foo2zjs", "/usr/lib/cups/driver/foo2zjs"),
            ("gutenprint", "/usr/lib/cups/driver/gutenprint.5.3"),
            ("hplip", "/usr/lib/cups/driver/hplip"),
            ("dymo", "/usr/lib/cups/driver/dymo"),
            ("fujixerox", "/usr/lib/cups/driver/fujixerox"),
            ("ptouch", "/usr/lib/cups/driver/ptouch"),
            # HP's own PostScript PPDs (printer-driver-postscript-hp), one entry per SKU: the
            # only driver installed for many PostScript-capable network LaserJets (e.g. the
            # LaserJet 400 M401 family), which previously fell to an unrelated fuzzy match.
            ("postscript-hp", "/usr/lib/cups/driver/postscript-hp"),
        ]
        for name, bin_path in driver_bins:
            if not os.path.exists(bin_path):
                continue
            code, out, _ = exec_cmd([bin_path, "list"], timeout=15)
            if code != 0 or not out:
                continue
            for line in out.splitlines():
                # Line format: "uri" lang "mfg" "make model" "1284DeviceID"
                parts = [p.strip() for p in re.findall(r'"([^"]*)"', line)]
                if len(parts) >= 3:
                    uri = parts[0]
                    raw_mfg = parts[1]
                    make_model = parts[2]
                    devid = parts[3] if len(parts) > 3 else ""
                    parsed = parse_1284_device_id(devid)
                    mfg = parsed.get("MFG") or raw_mfg or (make_model.split()[0] if make_model else "")
                    mdl = parsed.get("MDL") or make_model
                    if normalize(mdl).isdigit():
                        # e.g. ptouch's "MDL:2300" for the P-touch PT-2300: a bare number would
                        # substring-match any model containing it (HL-L2300D...), so index the
                        # spelled-out name instead.
                        mdl = re.sub(r"\s+Foomatic/.*$", "", make_model)
                    drivers.append({
                        "uri": uri,
                        "driver": name,
                        "make_model": make_model,
                        "mfg": mfg,
                        "mdl": mdl,
                        "raw_devid": devid
                    })

        # 2. Parse all .drv files (brlaser, hpijs, hpcups, splix, sample, etc.)
        drv_dir = "/usr/share/cups/drv"
        if os.path.exists(drv_dir):
            for drv_file in glob.glob(os.path.join(drv_dir, "*.drv")):
                drv_base = os.path.basename(drv_file)
                drv_name = drv_base.replace(".drv", "")
                default_mfg = "Generic"
                if "brlaser" in drv_name: default_mfg = "Brother"
                elif "hp" in drv_name: default_mfg = "HP"
                elif "splix-samsung" in drv_name: default_mfg = "Samsung"
                elif "splix-xerox" in drv_name: default_mfg = "Xerox"
                elif "splix-dell" in drv_name: default_mfg = "Dell"
                elif "splix-lexmark" in drv_name: default_mfg = "Lexmark"
                elif "sample" in drv_name: default_mfg = "Generic"

                try:
                    with open(drv_file, "r", errors="ignore") as f:
                        content = f.read()
                    for block in content.split("}"):
                        m_model = re.search(r'ModelName\s+"([^"]+)"', block)
                        m_file = re.search(r'PCFileName\s+"([^"]+)"', block)
                        m_devid = re.search(r'Attribute\s+"1284DeviceID"\s+""\s+"([^"]+)"', block)
                        # Vendors ship many rebrands/SKUs of the same engine under one PPD block,
                        # spelled out as "Attribute "Product" "" "(HP LaserJet m102a)"" lines. These
                        # were previously ignored entirely, so a query for e.g. "HP LaserJet Pro M102a"
                        # never matched the (correct, already-installed) "HP LaserJet m101-m106" PPD and
                        # fell back to an unrelated model instead.
                        aliases = [a.strip("() ") for a in re.findall(r'Attribute\s+"Product"\s+"[^"]*"\s+"([^"]+)"', block)]
                        if m_file:
                            uri = f"drv:///{drv_base}/{m_file.group(1)}"
                            name = m_model.group(1) if m_model else m_file.group(1)
                            devid = m_devid.group(1) if m_devid else ""
                            parsed = parse_1284_device_id(devid)
                            drivers.append({
                                "uri": uri,
                                "driver": drv_name,
                                "make_model": name,
                                "mfg": parsed.get("MFG", default_mfg),
                                "mdl": parsed.get("MDL", name),
                                "raw_devid": devid,
                                "aliases": aliases
                            })
                except Exception:
                    pass

        # 3. Static PPDs in /usr/share/cups/model/, /usr/share/ppd/, and /opt/mantaprint/drivers/
        ppd_search_dirs = [
            "/usr/share/cups/model",
            "/usr/share/ppd",
            "/opt/mantaprint/drivers/ppd",
            "/opt/mantaprint/drivers"
        ]
        for base_dir in ppd_search_dirs:
            if not os.path.exists(base_dir):
                continue
            for root, _, files in os.walk(base_dir):
                for f in files:
                    if f.endswith(".ppd") or f.endswith(".ppd.gz"):
                        full_p = os.path.join(root, f)
                        nick = f.replace(".ppd.gz", "").replace(".ppd", "")
                        try:
                            short_nick = None
                            with open(full_p, "r", errors="ignore") as pf:
                                for line in pf:
                                    if line.startswith("*NickName:"):
                                        nick = line.split(":", 1)[1].strip().strip('"')
                                    elif line.startswith("*ShortNickName:"):
                                        short_nick = line.split(":", 1)[1].strip().strip('"')
                            # *ShortNickName is the vendor's own revision-free identifier (e.g.
                            # "Canon Inc LBP3010/LBP3018/LBP3050 r2c" instead of *NickName's
                            # "..., 0.1.4"). Even ShortNickName can carry its own trailing revision
                            # tag ("r2c"), stripped below — but starting from it avoids having to
                            # separately guess at every vendor's version-suffix convention.
                            if short_nick:
                                nick = short_nick
                        except Exception:
                            pass

                        # Strip a trailing ", 0.1.4"-style driver-version suffix, and a trailing
                        # short revision-code word (e.g. "r2c") some vendors also append, before
                        # matching or
                        # expanding slash-separated model lists. Without this, a nickname like
                        # "Canon Inc LBP6000/LBP6018, 0.1.4" expands its second submodel to the mangled
                        # "LBP LBP6018, 0.1.4" instead of clean "LBP6018" — it then only ever scores a
                        # fuzzy substring match instead of an exact one, so a genuinely exact query for
                        # "LBP6018" can lose a tie (decided by incidental filesystem order) to the
                        # unrelated "LBP6018L" UFR II LT model from a different PPD.
                        nick = re.sub(r',\s*[\d][\d.]*\s*$', '', nick).strip()
                        nick = re.sub(r'\s+[Rr]\d[a-zA-Z]?\s*$', '', nick).strip()
                        nick_l = nick.lower()
                        root_l = root.lower()
                        f_l = f.lower()

                        if "canon" in nick_l or "cnrcups" in f_l:
                            mfg = "Canon"
                        elif "samsung" in nick_l or "samsung" in root_l or "ml-" in f_l or "scx-" in f_l:
                            mfg = "Samsung"
                        elif "xerox" in nick_l or "xerox" in root_l or "phaser" in f_l:
                            mfg = "Xerox"
                        elif "epson" in nick_l:
                            mfg = "Epson"
                        elif "hp" in nick_l or "laserjet" in nick_l:
                            mfg = "HP"
                        elif "brother" in nick_l:
                            mfg = "Brother"
                        else:
                            mfg = "Generic"

                        drivers.append({
                            "uri": full_p,
                            "driver": "static",
                            "make_model": nick,
                            "mfg": mfg,
                            "mdl": nick,
                            "raw_devid": ""
                        })
                        # If model has slash variants like LBP6030/6040/6018L, expand submodels
                        if "/" in nick:
                            prefix = nick.split("/")[0]
                            # Two nickname shapes need different reassembly:
                            #  "LBP6030/6040/6018L"           -> later parts are bare numbers that
                            #                                     need the "LBP" marker re-attached
                            #  "Canon Inc LBP6000/LBP6018"    -> later parts already spell out their
                            #                                     own marker+number, only the vendor
                            #                                     prefix (if any) should be prepended
                            # Using one flat "lead_word" for both (as before) double-prefixes the
                            # second shape into "Canon Inc LBP LBP6018".
                            m_lead = re.match(r'^(.*?)\b(LBP|iR|MF)?\s*(\d.*)$', prefix)
                            lead_prefix = m_lead.group(1).strip() if m_lead else ""
                            marker = (m_lead.group(2) or "LBP") if m_lead else "LBP"
                            # Also index the first (prefix) model on its own, e.g. "LBP6030" out of
                            # "LBP6030/6040/6018L". Without this, the only place "LBP6030" appears is
                            # inside the base entry's fully-joined "canonlbp603060406018l" string once
                            # normalize() removes the slashes — indistinguishable there from "LBP6040"
                            # or "LBP6018L" by any boundary-aware substring check.
                            drivers.append({
                                "uri": full_p,
                                "driver": "static",
                                "make_model": prefix,
                                "mfg": mfg,
                                "mdl": prefix,
                                "raw_devid": ""
                            })
                            for part in nick.split("/")[1:]:
                                part = re.sub(r',.*$', '', part).strip()
                                if part.lower().startswith(marker.lower()):
                                    sub_name = f"{lead_prefix} {part}".strip()
                                else:
                                    sub_name = f"{lead_prefix} {marker} {part}".strip()
                                drivers.append({
                                    "uri": full_p,
                                    "driver": "static",
                                    "make_model": sub_name,
                                    "mfg": mfg,
                                    "mdl": sub_name,
                                    "raw_devid": ""
                                })

        self.drivers = drivers
        try:
            os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
            with open(CACHE_FILE, "w") as f:
                json.dump({"version": DRIVER_INDEX_VERSION, "drivers": drivers}, f)
        except Exception:
            pass

    def match(self, mfg, mdl, cmd="", des=""):
        """Resolves the best PPD URI based on IEEE 1284 metadata. Thin wrapper around
        resolve_driver() kept for backward compatibility (sync_all_printers() and older
        callers only want the (uri, desc) pair, not the confidence details)."""
        result = self.resolve_driver(mfg, mdl, cmd, des)
        return result["uri"], result["desc"]

    def resolve_driver(self, mfg, mdl, cmd="", des=""):
        """Resolves the best PPD URI based on IEEE 1284 metadata, plus how much that
        resolution should be trusted. Returns a dict:
          uri, desc      - as returned by the old match()
          confidence     - "exact" (the printer's own reported model, or an explicitly
                            curated vendor alias, matched a real installed driver exactly),
                            "fuzzy" (only a substring/heuristic match was found — usable,
                            but should be flagged for a human to confirm it actually prints
                            correctly), or "none" (no real driver found; `uri` is one of the
                            last-resort command-set fallbacks and should NOT be treated as a
                            working match, let alone published over AirPrint)
          raw_score      - the internal score, for debugging/tests only
        """
        mfg_norm = normalize(mfg)
        # Retail marketing names often insert a qualifier word ("Pro", "Plus") that the vendor's
        # own driver database/1284 DeviceID string omits (e.g. HP sells the "M102a" engine as the
        # "HP LaserJet Pro M102a", but HPLIP's own compatibility DB and most 1284 IDs just say
        # "LaserJet M102a"). Stripped as a whole word (not a bare substring) so it can't eat
        # letters out of an unrelated token.
        mdl_no_qualifier = re.sub(r'\b(pro|plus)\b', ' ', mdl, flags=re.IGNORECASE)
        mdl_norm = normalize(mdl)
        mdl_norm_nq = normalize(mdl_no_qualifier)
        des_norm = normalize(des)
        cmd_upper = cmd.upper() if cmd else ""

        # 1. Generic POS thermal receipt clones -> raw ESC/POS passthrough. Narrower than
        # is_roll_or_thermal_printer()'s list on purpose (see RECEIPT_RAW_KEYWORDS): it must not
        # catch "label"/"zebra"/"barcode" models, which get a real chance at a branded driver
        # (dymo, ptouch) in the scoring loop below before falling back to a generic label PPD.
        if any(normalize(k) in mdl_norm for k in RECEIPT_RAW_KEYWORDS) or "receipt" in des_norm:
            return {"uri": "raw", "desc": "POS / Thermal Raw", "confidence": "exact", "raw_score": None}

        # 2. Dot Matrix printers (9-pin / 24-pin)
        if any(k in mdl_norm for k in ["lx300", "lx310", "lq300", "lq310", "fx890", "fx2190", "lx800"]) or "dotmatrix" in des_norm or ("escp" in cmd_upper and not "escpr" in cmd_upper):
            return {"uri": "drv:///sample.drv/epson9.ppd", "desc": "Generic ESC/P 9-pin Dot Matrix (sample.drv)", "confidence": "exact", "raw_score": None}

        # 4. Model variants (e.g. G3030 -> G3000 series, L3210 -> L3250, P1102 -> P1100 series, HL-1210W -> HL-1200 series)
        # Each variant carries a priority: 0 = the printer's own reported name (most trusted),
        # 1..N = a vendor-curated alias in the order we listed it (our best guess at which
        # sibling model shares the closest engine), 100 = a purely heuristic digit-family guess
        # (e.g. "assume x030 uses the same filter as x000"), least trusted of the three.
        base_mdl = re.sub(r'[wdn]+$', '', re.sub(r'series$', '', mdl_norm))
        variants = [(mdl_norm, 0), (base_mdl, 0), (base_mdl + "series", 0)]
        if mdl_norm_nq != mdl_norm:
            base_mdl_nq = re.sub(r'[wdn]+$', '', re.sub(r'series$', '', mdl_norm_nq))
            variants.extend([(mdl_norm_nq, 0), (base_mdl_nq, 0), (base_mdl_nq + "series", 0)])

        # Vendor-specific known alias mapping (e.g. L3210 uses L3250 ESC/P-R filter). List order
        # matters: it's our stated preference, and is now honored via the priority tie-break below
        # instead of being decided by incidental driver-list iteration order.
        if mfg_norm == "epson":
            epson_aliases = {
                "l120": ["l110", "l210", "l310"],
                "l220": ["l210", "l310"],
                "l3210": ["l3250", "l3110", "l3100"],
                "l3216": ["l3250", "l3110"],
                "l3200": ["l3250", "l3100"],
                "l360": ["l310", "l210"],
                "l380": ["l310", "l210"],
                "l385": ["l310", "l210"],
            }
            for rank, alt in enumerate(epson_aliases.get(base_mdl, []), start=1):
                variants.extend([(alt, rank), (alt + "series", rank), (f"epson {alt}", rank)])

        # Canon sells the same UFR II LT engine under sibling SKUs whose suffix letter our own
        # base_mdl stripping (trailing w/d/n) makes indistinguishable from the unrelated legacy
        # CAPT-only "LBP6018" (no suffix at all). Documented together as one UFR II LT family in
        # docs/SUPPORTED_DEVICES.md, so treat them as aliases rather than leaving it to a coin flip.
        if mfg_norm == "canon":
            canon_ufr2_aliases = {"lbp6018w": ["lbp6018l"]}
            for rank, alt in enumerate(canon_ufr2_aliases.get(mdl_norm, []), start=1):
                variants.append((alt, rank))

        nums = re.findall(r"\d+", base_mdl)
        for n in nums:
            if len(n) == 4 and (n.endswith("30") or n.endswith("20") or n.endswith("10")):
                base = n[:2] + "00"
                v_b = base_mdl.replace(n, base)
                variants.extend([(v_b, 100), (v_b + "series", 100)])
            elif len(n) == 4 and not n.endswith("00"):
                base = n[:2] + "00"
                v_b = base_mdl.replace(n, base)
                variants.extend([(v_b, 100), (v_b + "series", 100)])
            elif len(n) == 3 and n.endswith("5"):
                base = n[:2] + "0"
                v_b = base_mdl.replace(n, base)
                variants.extend([(v_b, 100), (v_b + "series", 100)])
        seen_v = set()
        deduped = []
        for v, prio in variants:
            if v and v not in seen_v:
                seen_v.add(v)
                deduped.append((v, prio))
        variants = deduped

        # Canon CAPT Laser check vs Inkjet
        is_canon_capt = (mfg_norm == "canon") and any(k in mdl_norm for k in ["lbp", "capt", "laser", "lasershot"])

        best_match = None
        best_score = 0
        best_exact = False

        for item in self.drivers:
            i_drv = item.get("driver", "")
            # Skip static Canon CAPT drivers if model is not CAPT laser
            if i_drv == "static" and "canon" in normalize(item.get("mfg", "")) and not is_canon_capt:
                continue

            i_mfg = normalize(item.get("mfg", ""))
            i_mdl = normalize(item.get("mdl", ""))
            i_mm = normalize(item.get("make_model", ""))
            i_aliases = [normalize(a) for a in item.get("aliases", []) if a]

            score = 0
            # Vendor check
            vendor_match = False
            if mfg_norm in ["hp", "hewlettpackard"] and i_mfg in ["hp", "hewlettpackard"]:
                vendor_match = True
            elif mfg_norm and (mfg_norm in i_mfg or i_mfg in mfg_norm or mfg_norm in i_mm):
                vendor_match = True

            if vendor_match:
                score += 30
            elif not mfg_norm:
                score += 5
            else:
                continue

            # Model exact or variant match. Candidates are checked in the same order variants
            # are listed (own name -> curated aliases by rank -> heuristic guesses), so the first
            # hit is already the best-trusted one for this item; a small tie-break bonus (biggest
            # for rank 0, shrinking per alias rank, zero for heuristic guesses) then decides which
            # ITEM wins when two different items both get an equally-scored exact/substring hit.
            matched_model = False
            matched_exact = False
            candidates = [i_mdl, i_mm] + i_aliases
            for v, v_prio in variants:
                if not v:
                    continue
                hit = None
                for cand in candidates:
                    if not cand:
                        continue
                    if v == cand:
                        hit = 60
                        matched_exact = True
                        break
                    elif v_prio >= 100:
                        # Heuristic digit-family guess (e.g. "assume x030 uses the x000 filter").
                        # The whole point of this tier is guessing across trailing suffix letters
                        # (D/W/DW/N and similar duplex/wireless flags), so the strict model-boundary
                        # check below would defeat it — plain containment is what we actually want.
                        if (v in cand and not ("m" + v in cand)) or (cand in v and not cand.isdigit()):
                            hit = 50
                            break
                    elif (contains_as_model(v, cand) and not ("m" + v in cand)) or (contains_as_model(cand, v) and not cand.isdigit()):
                        # The printer's own reported name, or a curated vendor alias: trust it
                        # enough to require a real model-boundary match (see contains_as_model),
                        # so e.g. "LBP6018" doesn't casually match the unrelated "LBP6018L".
                        hit = 50
                        break
                if hit is not None:
                    score += hit + max(0, 5 - v_prio)
                    matched_model = True
                    break

            # Exact number match bonus: e.g. 1020 matches 1020 over 1000
            num_candidates = candidates
            if nums and any(n in c for n in nums for c in num_candidates):
                if all(any(n in c for c in num_candidates) for n in nums):
                    score += 25
                else:
                    score += 10
                matched_model = True

            if not matched_model:
                continue

            # Driver family priority
            drv_prio = {
                "static": 30 if is_canon_capt else 5,
                "foo2zjs": 25,
                "brlaser": 25,
                "escpr": 25,
                "splix-samsung": 25,
                "splix-xerox": 25,
                "hpcups": 24,
                "hpijs": 22,
                "dymo": 22,
                "ptouch": 22,
                "gutenprint": 20,
                "fujixerox": 20,
                "postscript-hp": 20,
                "hplip": 15
            }
            score += drv_prio.get(i_drv, 0)

            if score > best_score:
                best_score = score
                best_match = item
                best_exact = matched_exact

        if best_match and best_score >= 60:
            return {
                "uri": best_match["uri"],
                "desc": f"{best_match['make_model']} (Score: {best_score})",
                "confidence": "exact" if best_exact else "fuzzy",
                "raw_score": best_score
            }

        # No branded driver matched (dymo/ptouch/any real Zebra .drv would have won above if
        # installed and applicable) — only now fall back to the generic Zebra EPL2/ZPL PPD for an
        # unbranded label/barcode clone.
        if any(k in mdl_norm for k in LABEL_BARCODE_KEYWORDS) or "zpl" in cmd_upper or "epl" in cmd_upper:
            return {"uri": "drv:///sample.drv/zebraep2.ppd", "desc": "Zebra Label (sample.drv, unverified)", "confidence": "fuzzy", "raw_score": best_score}

        # Fallback based on Command Set: no real driver was found. These generic PPDs are a
        # last resort so a queue can still be created and an admin can inspect it, but they are
        # NOT a working match — callers must treat confidence="none" as "do not publish this
        # queue over AirPrint, and flag it for a human", not as success.
        if "PCL" in cmd_upper or "PCL6" in cmd_upper or "PCL5" in cmd_upper:
            return {"uri": "drv:///sample.drv/generpcl.ppd", "desc": "Generic PCL Laser (unverified)", "confidence": "none", "raw_score": best_score}
        if "POSTSCRIPT" in cmd_upper or "PS" in cmd_upper:
            return {"uri": "drv:///sample.drv/generic.ppd", "desc": "Generic PostScript (unverified)", "confidence": "none", "raw_score": best_score}
        if "ESCP" in cmd_upper or "ESC/P" in cmd_upper:
            return {"uri": "drv:///sample.drv/epson9.ppd", "desc": "Generic ESC/P 9-pin Dot Matrix (unverified)", "confidence": "none", "raw_score": best_score}

        return {"uri": "drv:///sample.drv/generpcl.ppd", "desc": "Fallback Generic PCL (unverified)", "confidence": "none", "raw_score": best_score}

    def match_driver(self, mfg, mdl, cmd="", des=""):
        """Alias for match() for compatibility with automated QA matrices."""
        return self.match(mfg, mdl, cmd, des)

_driver_engine = None

def get_driver_engine():
    global _driver_engine
    if _driver_engine is None:
        with _lock:
            if _driver_engine is None:
                _driver_engine = DriverEngine()
    return _driver_engine

def probe_hardware_printers():
    """
    Detects ALL connected physical printers (both modern IPP-over-USB and classic USB).
    Returns a list of dicts: [ {uri, is_ipp, vendor, model, display_name, serial, 1284_id, ...} ]
    """
    printers = []
    seen_uris = set()
    seen_devices = set()

    # Step 1: Probe IPP-over-USB endpoints (Modern printers: Canon, HP, Epson, Brother ~2015+)
    # ipp-usb daemon binds loopback TCP ports starting at 60000 (60000..60005)
    for port in range(60000, 60006):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.2)
            res = s.connect_ex(("127.0.0.1", port))
            s.close()
            if res != 0:
                continue

            # Query IPP attributes directly via ipptool
            ipp_uri = f"ipp://localhost:{port}/ipp/print"
            code, stdout, _ = exec_cmd([
                "ipptool", "-v", "-t", ipp_uri, "get-printer-attributes.test"
            ], timeout=3)
            if code != 0 or not stdout:
                continue

            m_make_model = re.search(r'printer-make-and-model\s+\([^)]+\)\s*=\s*(.+)', stdout)
            m_devid = re.search(r'printer-device-id\s+\([^)]+\)\s*=\s*(.+)', stdout)
            m_uuid = re.search(r'printer-uuid\s+\([^)]+\)\s*=\s*(.+)', stdout)
            m_color = re.search(r'color-supported\s+\([^)]+\)\s*=\s*(.+)', stdout)
            m_name = re.search(r'printer-name\s+\([^)]+\)\s*=\s*(.+)', stdout)

            devid_raw = m_devid.group(1).strip() if m_devid else ""
            parsed_1284 = parse_1284_device_id(devid_raw)

            make_model_str = m_make_model.group(1).strip() if m_make_model else (m_name.group(1).strip() if m_name else "IPP Printer")
            mfg = parsed_1284.get("MFG") or (make_model_str.split()[0] if make_model_str else "Generic")
            mdl = parsed_1284.get("MDL") or (" ".join(make_model_str.split()[1:]) if len(make_model_str.split()) > 1 else make_model_str)
            cmd = parsed_1284.get("CMD", "")
            des = parsed_1284.get("DES", make_model_str)
            raw_uuid = m_uuid.group(1).strip().replace("urn:uuid:", "") if m_uuid else ""
            is_color = m_color.group(1).strip().lower() == "true" if m_color else True

            # Derive clean queue name e.g. Canon_G3030_series
            clean_name = re.sub(r'[^a-zA-Z0-9_-]', '_', f"{mfg}_{mdl}").strip('_')

            serial = parsed_1284.get("SN") or parsed_1284.get("SERN") or ""
            if not serial and "serial=" in devid_raw:
                m_sn = re.search(r'serial=([^&;]+)', devid_raw)
                if m_sn:
                    serial = m_sn.group(1)

            seen_uris.add(ipp_uri)
            seen_devices.add(normalize(f"{mfg}_{mdl}"))
            if serial:
                seen_devices.add(normalize(serial))

            printers.append({
                "uri": ipp_uri,
                "is_ipp": True,
                "display_name": make_model_str,
                "vendor": mfg,
                "model": mdl,
                "cmd": cmd,
                "des": des,
                "serial": serial,
                "device_id": devid_raw,
                "queue_name": clean_name,
                "uuid": raw_uuid,
                "is_color": is_color
            })
        except Exception:
            pass

    # Step 2: Probe Classic USB backend (Epson L120, HP 1020, Brother HL-1200, POS Thermal, Dot Matrix, etc.)
    code, stdout, _ = exec_cmd(["/usr/lib/cups/backend/usb"], timeout=10)
    if code == 0 and stdout:
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("direct usb://"):
                parts = line.split(maxsplit=4)
                uri = parts[1]
                if uri in seen_uris:
                    continue

                matches = re.findall(r'"([^"]*)"', line)
                display_name = matches[0] if len(matches) > 0 and matches[0] else "USB Printer"
                devid = matches[2] if len(matches) > 2 else ""

                parsed_1284 = parse_1284_device_id(devid)
                mfg = parsed_1284.get("MFG") or (display_name.split()[0] if display_name else "Generic")
                mdl = parsed_1284.get("MDL") or (" ".join(display_name.split()[1:]) if len(display_name.split()) > 1 else display_name)
                cmd = parsed_1284.get("CMD", "")
                des = parsed_1284.get("DES", display_name)

                m_serial = re.search(r'serial=([^&]+)', uri)
                serial = m_serial.group(1) if m_serial else ""

                # Skip if already captured via IPP-over-USB
                norm_key = normalize(f"{mfg}_{mdl}")
                if norm_key in seen_devices or (serial and normalize(serial) in seen_devices):
                    continue

                seen_uris.add(uri)
                clean_name = re.sub(r'[^a-zA-Z0-9_-]', '_', f"{mfg}_{mdl}").strip('_')
                is_color = not any(k in mdl.lower() for k in ["laser", "hl-", "lbp", "m1132", "p1102", "1020"])

                printers.append({
                    "uri": uri,
                    "is_ipp": False,
                    "display_name": display_name,
                    "vendor": mfg,
                    "model": mdl,
                    "cmd": cmd,
                    "des": des,
                    "serial": serial,
                    "device_id": devid,
                    "queue_name": clean_name,
                    "uuid": None,
                    "is_color": is_color
                })

    # Step 3: Fallback to lpinfo -v if nothing found
    if not printers:
        code, stdout, _ = exec_cmd(["lpinfo", "-v"], timeout=10)
        if code == 0 and stdout:
            for line in stdout.splitlines():
                line = line.strip()
                if line.startswith("direct usb://"):
                    parts = line.split(maxsplit=2)
                    uri = parts[1]
                    if uri in seen_uris:
                        continue
                    seen_uris.add(uri)

                    uri_clean = uri.replace("usb://", "")
                    uri_parts = uri_clean.split("/")
                    vendor = uri_parts[0] if len(uri_parts) > 0 else "Generic"
                    model_str = uri_parts[1].split("?")[0].replace("%20", " ") if len(uri_parts) > 1 else "Printer"
                    display_name = f"{vendor} {model_str}"
                    clean_name = re.sub(r'[^a-zA-Z0-9_-]', '_', display_name).strip('_')

                    m_serial = re.search(r'serial=([^&]+)', uri)
                    serial = m_serial.group(1) if m_serial else ""

                    printers.append({
                        "uri": uri,
                        "is_ipp": False,
                        "display_name": display_name,
                        "vendor": vendor,
                        "model": model_str,
                        "cmd": "",
                        "des": display_name,
                        "serial": serial,
                        "device_id": "",
                        "queue_name": clean_name,
                        "uuid": None,
                        "is_color": True
                    })

    return printers

def is_device_connected_sysfs(uri):
    """Checks /sys/bus/usb/devices to determine if USB printer hardware is physically plugged in."""
    if not uri or not uri.startswith("usb://"):
        return False
    m_serial = re.search(r'serial=([^&]+)', uri)
    target_serial = m_serial.group(1).strip().lower() if m_serial else None

    usb_base = "/sys/bus/usb/devices"
    if not os.path.exists(usb_base):
        return False
    try:
        for d in os.listdir(usb_base):
            dev_path = os.path.join(usb_base, d)
            is_printer = False
            try:
                for s in os.listdir(dev_path):
                    if s.startswith(d + ":"):
                        if_class = os.path.join(dev_path, s, "bInterfaceClass")
                        if os.path.exists(if_class):
                            with open(if_class, "r") as f:
                                if f.read().strip() == "07":
                                    is_printer = True
                                    break
            except Exception:
                pass
            if is_printer:
                if not target_serial:
                    return True
                serial_path = os.path.join(dev_path, "serial")
                if os.path.exists(serial_path):
                    try:
                        with open(serial_path, "r") as f:
                            if f.read().strip().lower() == target_serial:
                                return True
                    except Exception:
                        pass
    except Exception:
        pass
    return False

def get_cups_printers():
    """Returns detailed mapping of current CUPS print queues and default queue."""
    code, stdout, _ = exec_cmd(["lpstat", "-p", "-d", "-v"], timeout=5)
    printers = {}
    default_printer = None

    if code == 0 and stdout:
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("printer "):
                parts = line.split()
                p_name = parts[1]
                state = "idle" if "is idle" in line else ("printing" if "printing" in line else "stopped")
                if p_name not in printers:
                    printers[p_name] = {"name": p_name, "state": state, "uri": "", "is_default": False}
                else:
                    printers[p_name]["state"] = state
            elif line.startswith("system default destination:"):
                default_printer = line.split(":")[-1].strip()
            elif line.startswith("device for "):
                parts = line.split(":", 1)
                p_name = parts[0].replace("device for ", "").strip()
                uri = parts[1].strip() if len(parts) > 1 else ""
                if p_name not in printers:
                    printers[p_name] = {"name": p_name, "state": "unknown", "uri": uri, "is_default": False}
                else:
                    printers[p_name]["uri"] = uri

    # Read UUIDs from /etc/cups/printers.conf
    if os.path.exists(PRINTERS_CONF):
        try:
            with open(PRINTERS_CONF, "r") as f:
                cur_p = None
                for line in f:
                    line = line.strip()
                    m_p = re.match(r'<(?:Default)?Printer\s+([^>]+)>', line)
                    if m_p:
                        cur_p = m_p.group(1)
                    elif line.startswith("UUID urn:uuid:") and cur_p and cur_p in printers:
                        printers[cur_p]["uuid"] = line.replace("UUID urn:uuid:", "").strip()
                    elif line == "</Printer>" or line == "</DefaultPrinter>":
                        cur_p = None
        except Exception:
            pass

    # Read PPD NickNames from /etc/cups/ppd/
    for p_name in printers:
        ppd_path = f"/etc/cups/ppd/{p_name}.ppd"
        if os.path.exists(ppd_path):
            try:
                with open(ppd_path, "r", errors="ignore") as f:
                    for line in f:
                        if line.startswith("*NickName:"):
                            printers[p_name]["ppd_nickname"] = line.split(":", 1)[1].strip().strip('"')
                            break
            except Exception:
                pass

    if default_printer and default_printer in printers:
        printers[default_printer]["is_default"] = True

    return printers, default_printer

def get_local_ip():
    """
    Retrieves primary outbound IPv4 address dynamically.
    Resilient to link flaps, isolated LANs without internet, and DHCP re-leases.
    """
    # 1. Standard UDP routing lookup (fast, kernel route check, no packet sent)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    # 2. Kernel default routing interface from /proc/net/route
    try:
        if os.path.exists("/proc/net/route"):
            with open("/proc/net/route", "r") as f:
                for line in f.readlines()[1:]:
                    parts = line.strip().split()
                    if len(parts) >= 2 and parts[1] == "00000000":
                        iface = parts[0]
                        res = subprocess.run(["ip", "-4", "-o", "addr", "show", "dev", iface], capture_output=True, text=True, timeout=2)
                        if res.returncode == 0 and res.stdout.strip():
                            candidate = res.stdout.strip().split()[3].split("/")[0]
                            if candidate and not candidate.startswith("127."):
                                return candidate
    except Exception:
        pass

    # 3. Query kernel via iproute2 for global scope IPv4 (Ethernet first, then Wi-Fi)
    try:
        res = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=2)
        if res.returncode == 0 and res.stdout.strip():
            lines = res.stdout.strip().split("\n")
            for preferred in ["eth", "end", "enp", "wlan", "wlp"]:
                for line in lines:
                    parts = line.split()
                    if len(parts) >= 4 and preferred in parts[1]:
                        candidate = parts[3].split("/")[0]
                        if candidate and not candidate.startswith("127."):
                            return candidate
            first_line = lines[0].split()
            if len(first_line) >= 4:
                candidate = first_line[3].split("/")[0]
                if candidate and not candidate.startswith("127."):
                    return candidate
    except Exception:
        pass

    # 4. Hostname lookup fallback
    try:
        host_ip = socket.gethostbyname(socket.gethostname())
        if host_ip and not host_ip.startswith("127."):
            return host_ip
    except Exception:
        pass

    return "127.0.0.1"

def get_active_broadcast_network():
    """
    Evaluates Ethernet vs WiFi with strict priority rule:
    Jalur broadcast wifi hanya berlaku jika eth tidak aktif.
    Jika eth aktif, maka hanya jalur eth saja yang di broadcast mdns.
    
    Returns:
        dict: {
            "iface": "eth0" or "wlan0",
            "type": "eth" or "wifi",
            "ip": "192.168.1.xxx",
            "last_octet": "xxx"
        }
    """
    try:
        res = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=2)
        if res.returncode == 0 and res.stdout.strip():
            lines = res.stdout.strip().split("\n")
            eth_candidates = []
            wifi_candidates = []
            for line in lines:
                parts = line.split()
                if len(parts) >= 4:
                    iface_name = parts[1]
                    ip = parts[3].split("/")[0]
                    if ip and not ip.startswith("127."):
                        if iface_name.startswith(("eth", "end", "enp", "eno")):
                            carrier_path = f"/sys/class/net/{iface_name}/carrier"
                            operstate_path = f"/sys/class/net/{iface_name}/operstate"
                            is_up = True
                            try:
                                if os.path.exists(carrier_path):
                                    with open(carrier_path, "r") as f:
                                        is_up = (f.read().strip() == "1")
                                elif os.path.exists(operstate_path):
                                    with open(operstate_path, "r") as f:
                                        is_up = (f.read().strip() != "down")
                            except Exception:
                                is_up = True
                            if is_up:
                                eth_candidates.append((iface_name, ip))
                        elif iface_name.startswith(("wlan", "wlp", "wls", "ra", "wl")):
                            wifi_candidates.append((iface_name, ip))

            # Priority 1: Ethernet if active
            if eth_candidates:
                iface, ip = eth_candidates[0]
                last_octet = ip.split(".")[-1]
                return {
                    "iface": iface,
                    "type": "eth",
                    "ip": ip,
                    "last_octet": last_octet
                }

            # Priority 2: WiFi only if Ethernet is NOT active
            if wifi_candidates:
                iface, ip = wifi_candidates[0]
                last_octet = ip.split(".")[-1]
                return {
                    "iface": iface,
                    "type": "wifi",
                    "ip": ip,
                    "last_octet": last_octet
                }
    except Exception:
        pass

    local_ip = get_local_ip()
    last_octet = local_ip.split(".")[-1] if local_ip else "1"
    return {
        "iface": "eth0",
        "type": "eth",
        "ip": local_ip or "127.0.0.1",
        "last_octet": last_octet
    }

def format_structured_mdns_name(display_name, model=None, queue_name=None, network_info=None):
    """
    Standardizes mDNS broadcast name into structured format:
    (MEREK)-(tipe)-(eth/wifi)((ip belakangnya aja xxx))
    e.g. CANON-lbp6030-eth(114) or CANON-g3030-eth(238)
    """
    if not network_info:
        network_info = get_active_broadcast_network()

    iface_type = network_info.get("type", "eth")  # 'eth' or 'wifi'
    last_octet = network_info.get("last_octet", "1")

    raw_text = f"{display_name or ''} {model or ''} {queue_name or ''}".strip()
    
    known_brands = [
        "CANON", "EPSON", "HP", "BROTHER", "SAMSUNG", "XEROX", 
        "FUJIXEROX", "RICOH", "PANASONIC", "KYOCERA", "LEXMARK", "DYMO"
    ]
    
    brand = None
    for b in known_brands:
        if re.search(rf"\b{b}\b", raw_text, re.IGNORECASE):
            brand = b
            break
            
    if not brand:
        tokens = re.findall(r"[A-Za-z0-9]+", raw_text)
        brand = tokens[0].upper() if tokens else "PRINTER"

    clean_model = re.sub(rf"(?i)\b{brand}\b", "", raw_text)
    clean_model = re.sub(r"(?i)\b(series|professional|hub|mantaprint|heykprint|printer|scanner)\b", "", clean_model)
    clean_model = re.sub(r"(?i)\b(pixma|laserjet|deskjet|stylus|ecotank|workforce|imageclass|imagerunner)\b", "", clean_model)
    
    if "/" in clean_model:
        clean_model = clean_model.split("/")[0]

    model_tokens = re.findall(r"[A-Za-z0-9_-]+", clean_model)
    chosen_token = ""
    for t in model_tokens:
        t_clean = re.sub(r"[^a-zA-Z0-9]", "", t).lower()
        if any(c.isdigit() for c in t_clean):
            chosen_token = t_clean
            break
    if not chosen_token and model_tokens:
        chosen_token = re.sub(r"[^a-zA-Z0-9]", "", model_tokens[0]).lower()
        
    if not chosen_token:
        chosen_token = "device"

    return f"{brand}-{chosen_token}-{iface_type}({last_octet})"

def clean_mdns_display_name(display_name, ip_address=None, model=None, queue_name=None):
    """Compatibility wrapper that outputs the standardized structured name."""
    return format_structured_mdns_name(display_name, model=model, queue_name=queue_name)


def get_all_local_ips():
    """Returns list of unique IPv4 addresses on local interfaces excluding loopback."""
    ips = []
    try:
        res = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=2)
        if res.returncode == 0 and res.stdout.strip():
            for line in res.stdout.strip().split("\n"):
                parts = line.split()
                if len(parts) >= 4:
                    ip = parts[3].split("/")[0]
                    if ip and not ip.startswith("127.") and ip not in ips:
                        ips.append(ip)
    except Exception:
        pass
    primary = get_local_ip()
    if primary and primary not in ips:
        ips.insert(0, primary)
    return ips

def _generate_avahi_xml(service_name, queue_name, clean_type_name, model, uuid_str, ip_addr, is_color, is_duplex, is_online):
    pdl_str = "image/urf,image/pwg-raster,application/pdf"
    urf_str = "V1.4,W8,SRGB24,CP1,RS300-600"
    color_str = "T" if is_color else "F"
    duplex_str = "T" if is_duplex else "F"
    printer_state = "3" if is_online else "5"
    printer_state_reasons = "none" if is_online else "offline-report"

    if is_color:
        marker_levels_str = "100,100,100,100" if is_online else "0,0,0,0"
        marker_names_str = "Black,Cyan,Magenta,Yellow"
        marker_types_str = "ink,ink,ink,ink"
        marker_colors_str = "#000000,#00FFFF,#FF00FF,#FFFF00"
    else:
        marker_levels_str = "100" if is_online else "0"
        marker_names_str = "Canon Cartridge 325 (Black Toner)" if ("LBP6030" in model or "Canon" in model) else "Black Toner"
        marker_types_str = "toner"
        marker_colors_str = "#000000"

    return f"""<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service-group.dtd">
<service-group>
  <name replace-wildcards="yes">{service_name}</name>
  <service>
    <type>_ipp._tcp</type>
    <subtype>_universal._sub._ipp._tcp</subtype>
    <subtype>_print._sub._ipp._tcp</subtype>
    <port>631</port>
    <txt-record>txtvers=1</txt-record>
    <txt-record>qtotal=1</txt-record>
    <txt-record>rp=printers/{queue_name}</txt-record>
    <txt-record>ty={clean_type_name}</txt-record>
    <txt-record>product=({model})</txt-record>
    <txt-record>UUID={uuid_str}</txt-record>
    <txt-record>adminurl=http://{ip_addr}:631/printers/{queue_name}</txt-record>
    <txt-record>priority=0</txt-record>
    <txt-record>printer-state={printer_state}</txt-record>
    <txt-record>printer-state-reasons={printer_state_reasons}</txt-record>
    <txt-record>printer-type=0x801046</txt-record>
    <txt-record>Transparent=T</txt-record>
    <txt-record>Color={color_str}</txt-record>
    <txt-record>Duplex={duplex_str}</txt-record>
    <txt-record>pdl={pdl_str}</txt-record>
    <txt-record>URF={urf_str}</txt-record>
    <txt-record>mopria-certified=1.3</txt-record>
    <txt-record>TLS=1.2,1.3</txt-record>
    <txt-record>note=Universal Network Printer</txt-record>
    <txt-record>marker-levels={marker_levels_str}</txt-record>
    <txt-record>marker-names={marker_names_str}</txt-record>
    <txt-record>marker-types={marker_types_str}</txt-record>
    <txt-record>marker-colors={marker_colors_str}</txt-record>
  </service>
  <service>
    <type>_ipps._tcp</type>
    <subtype>_universal._sub._ipps._tcp</subtype>
    <subtype>_print._sub._ipps._tcp</subtype>
    <port>631</port>
    <txt-record>txtvers=1</txt-record>
    <txt-record>qtotal=1</txt-record>
    <txt-record>rp=printers/{queue_name}</txt-record>
    <txt-record>ty={clean_type_name}</txt-record>
    <txt-record>product=({model})</txt-record>
    <txt-record>UUID={uuid_str}</txt-record>
    <txt-record>adminurl=https://{ip_addr}:631/printers/{queue_name}</txt-record>
    <txt-record>priority=0</txt-record>
    <txt-record>printer-state={printer_state}</txt-record>
    <txt-record>printer-state-reasons={printer_state_reasons}</txt-record>
    <txt-record>printer-type=0x801046</txt-record>
    <txt-record>Transparent=T</txt-record>
    <txt-record>Color={color_str}</txt-record>
    <txt-record>Duplex={duplex_str}</txt-record>
    <txt-record>pdl={pdl_str}</txt-record>
    <txt-record>URF={urf_str}</txt-record>
    <txt-record>mopria-certified=1.3</txt-record>
    <txt-record>TLS=1.2,1.3</txt-record>
    <txt-record>note=Universal Network Printer</txt-record>
    <txt-record>marker-levels={marker_levels_str}</txt-record>
    <txt-record>marker-names={marker_names_str}</txt-record>
    <txt-record>marker-types={marker_types_str}</txt-record>
    <txt-record>marker-colors={marker_colors_str}</txt-record>
  </service>
</service-group>
"""

def sync_avahi_interface_binding(active_iface):
    """
    Updates /etc/avahi/avahi-daemon.conf to strictly allow only the active interface:
    'allow-interfaces=eth0' or 'allow-interfaces=wlan0'.
    Enforces rule: Wi-Fi broadcast only applies if Ethernet is NOT active.
    """
    conf_path = "/etc/avahi/avahi-daemon.conf"
    if not os.path.exists(conf_path):
        return
    try:
        with open(conf_path, "r") as f:
            content = f.read()
        
        target_line = f"allow-interfaces={active_iface},lo"
        if re.search(r"^\s*allow-interfaces\s*=", content, re.MULTILINE):
            new_content = re.sub(r"^\s*allow-interfaces\s*=.*$", target_line, content, flags=re.MULTILINE)
        elif re.search(r"^\s*#\s*allow-interfaces\s*=", content, re.MULTILINE):
            new_content = re.sub(r"^\s*#\s*allow-interfaces\s*=.*$", target_line, content, flags=re.MULTILINE)
        else:
            new_content = re.sub(r"\[server\]", f"[server]\n{target_line}", content, count=1)

        if new_content != content:
            with open(conf_path, "w") as f:
                f.write(new_content)
            exec_cmd(["systemctl", "restart", "avahi-daemon"])
    except Exception as e:
        print(f"[!] Error updating avahi-daemon.conf allow-interfaces: {e}")

def write_avahi_service(queue_name, display_name, model, uuid_str, is_color=True, is_duplex=False, is_online=True):
    """
    Generates a single, standardized Avahi DNS-SD XML service file for a printer queue.
    Format: (MEREK)-(tipe)-(eth/wifi)((ip belakangnya aja xxx))
    e.g. CANON-lbp6030-eth(114) or CANON-g3030-eth(238)
    Strictly binds to the active interface (Ethernet prioritized over Wi-Fi).
    """
    net = get_active_broadcast_network()
    ip_addr = net["ip"]
    mdns_service_name = format_structured_mdns_name(display_name, model=model, queue_name=queue_name, network_info=net)
    clean_type_name = mdns_service_name

    # Set CUPS printer description to match structured name
    try:
        exec_cmd(["lpadmin", "-p", queue_name, "-D", mdns_service_name])
    except Exception:
        pass

    # Ensure avahi-daemon interface exclusivity
    sync_avahi_interface_binding(net["iface"])

    # Clean up duplicate alias service files to prevent multiple ghost printers
    import glob
    target_filename = f"mantaprint_{queue_name}.service"
    target_path = os.path.join(AVAHI_SERVICE_DIR, target_filename)
    for old_file in glob.glob(os.path.join(AVAHI_SERVICE_DIR, f"*{queue_name}*.service")):
        if old_file != target_path:
            try:
                os.remove(old_file)
            except Exception:
                pass

    content = _generate_avahi_xml(mdns_service_name, queue_name, clean_type_name, model, uuid_str, ip_addr, is_color, is_duplex, is_online)
    changed = False
    try:
        existing = ""
        if os.path.exists(target_path):
            with open(target_path, "r") as f:
                existing = f.read()
        if existing != content:
            with open(target_path, "w") as f:
                f.write(content)
            changed = True
    except Exception as e:
        print(f"[!] Error writing Avahi service {target_filename} for {queue_name}: {e}")

    return changed

def remove_avahi_service(queue_name):
    """Removes all Avahi service files for disconnected printer."""
    import glob
    removed = False
    for pat in [f"mantaprint_{queue_name}*.service", f"heykprint_{queue_name}*.service"]:
        for f in glob.glob(os.path.join(AVAHI_SERVICE_DIR, pat)):
            try:
                os.remove(f)
                removed = True
            except Exception:
                pass
    return removed

def cleanup_legacy_services():
    """Removes single-printer legacy and obsolete alias service files."""
    import glob
    legacy_patterns = [
        "heykprint_airprint.service",
        "*_generic.service",
        "*_mantaprint.service",
        "*[0-9]-[0-9]*.service"
    ]
    for pat in legacy_patterns:
        for f in glob.glob(os.path.join(AVAHI_SERVICE_DIR, pat)):
            try:
                os.remove(f)
            except Exception:
                pass


def is_roll_or_thermal_printer(hw, ppd=""):
    """
    Returns True if the printer is a POS receipt roll or barcode label printer.
    These devices must NOT have PageSize=A4 or cupsFitToPage=True forced on them.
    """
    mdl = (hw.get("model") or "").lower()
    des = (hw.get("des") or "").lower()
    mfg = (hw.get("vendor") or "").lower()
    cmd = (hw.get("cmd") or "").upper()

    if any(k in mdl for k in THERMAL_LABEL_KEYWORDS) or any(k in des for k in THERMAL_LABEL_KEYWORDS):
        return True
    if any(k in mfg for k in ["zebra", "xprinter", "tsc", "gprinter", "hprt"]):
        return True
    if "zpl" in cmd or "epl" in cmd or ("esc/pos" in cmd or "escpos" in cmd):
        return True
    if ppd and any(k in ppd.lower() for k in ("raw", "zebra", "thermal", "ptouch", "dymo")):
        return True
    return False


## ---------------------------------------------------------------------------------------
## HP "stateless" LaserJet firmware provisioning
## ---------------------------------------------------------------------------------------
# A specific, narrow family of host-based HP LaserJets has no persistent flash memory in the
# print engine: they lose their firmware every time they're powered off, and refuse to print
# at all until the host re-uploads it over USB. This is verified against HP's own HPLIP
# compatibility database (models.dat, fw-download=True) — NOT the same thing as HPLIP's
# "plugin=1" flag, which usually refers to hpcups's separate, proprietary *rendering* plugin.
# The much more commonly cited P1102/P1102w/M12a/M102a/M15a/M130a etc. are fw-download=False
# in that same database: they print fine with the open foo2zjs/hpcups filters alone and were
# previously (wrongly) lumped in with this list in this file's own docs. See docs/HP_FIRMWARE.md.
#
# Firmware acquisition reuses `getweb`, the GPL tool foo2zjs itself ships (installed by this
# repo's own install.sh) and Debian's printer-driver-foo2zjs-common package ships for exactly
# this purpose: it fetches HP's firmware image from a public mirror and converts it to the
# appliance's .dl format with `arm2hpdl` — the same pipeline `sudo getweb 1020` performs by
# hand. We do not bundle, redistribute or reverse engineer HP's firmware; we just automate
# running the same sanctioned tool per hotplugged device instead of a fixed list at install time.
#
# Firmware delivery re-invokes CUPS's own standard `usb` backend directly (the pristine copy our
# install.sh already preserves at /usr/lib/cups/backend/usb-cups-orig before installing the
# smart Canon wrapper over /usr/lib/cups/backend/usb) with the firmware .dl file as the "document"
# — exactly the interface cupsd itself uses to send a real job, so firmware delivery gets the
# same tested USB claim/transfer/detach handling a normal print job already relies on, instead of
# a new, unverified low-level USB implementation. The previous implementation looked for
# foo2zjs's own udev-triggered loader scripts at "/usr/sbin/<name>" / "/usr/bin/<name>", but
# Debian ships them at "/lib/udev/<name>" — so it silently never ran on a stock install.

# canonical key -> (getweb argument, firmware filename getweb/arm2hpdl produces)
HP_FIRMWARE_MODELS = {
    "1000": ("1000", "sihp1000.dl"),
    "1005": ("1005", "sihp1005.dl"),
    "1018": ("1018", "sihp1018.dl"),
    "1020": ("1020", "sihp1020.dl"),
    "p1005": ("P1005", "sihpP1005.dl"),
    "p1007": ("P1005", "sihpP1005.dl"),   # getweb's own [pP]100[57] pattern: P1007 shares P1005's image
    "p1006": ("P1006", "sihpP1006.dl"),
    "p1008": ("P1006", "sihpP1006.dl"),   # getweb's own [pP]100[68] pattern: P1008 shares P1006's image
    "p1505": ("P1505", "sihpP1505.dl"),
}

# Also genuinely fw-download=True per HPLIP's models.dat, but neither getweb nor any other
# public tool we could find has a fetch case for these — reported honestly as "needs firmware,
# no known automatic source" rather than silently treated as unsupported or guessed at.
HP_FIRMWARE_NO_SOURCE = {"p1009", "p1566", "p1567", "p1568", "p1569"}

FIRMWARE_HELPER_DIRS = ("/lib/udev", "/usr/lib/udev", "/usr/sbin", "/usr/bin")
GETWEB_OUTPUT_DIR = "/var/lib/foo2zjs/firmware"
GETWEB_RETRY_SECONDS = 300  # don't hammer a dead mirror/no-network on every hotplug burst


def needs_hp_firmware(vendor, model):
    """Returns the HP_FIRMWARE_MODELS key if this exact model needs a firmware upload before
    it will print, "no_source" if it needs one but we have no automatic way to fetch it, or
    None if it's not HP or (like the far more commonly seen P1102/M12a/M102a/M15a/etc.) simply
    doesn't need this at all. Requires "laserjet" in the model string as well as the number, so
    a coincidental "1020"-shaped substring in an unrelated product line can't false-positive."""
    v = normalize(vendor)
    if v not in ("hp", "hewlettpackard"):
        return None
    if "laserjet" not in normalize(model):
        return None
    # Collapse anything non-alphanumeric to a single space (rather than normalize()'s "delete
    # entirely") so real \b word boundaries survive: "P1005" and "1005" must NOT cross-match
    # (P-series and bare-numbered LaserJets are different physical models), which a boundary-less
    # substring check can't tell apart once "P1005" and "1005" both just become digit runs.
    words = re.sub(r'[^a-z0-9]+', ' ', model.lower())
    for key in HP_FIRMWARE_MODELS:
        if re.search(r'\b' + re.escape(key) + r'\b', words):
            return key
    for key in HP_FIRMWARE_NO_SOURCE:
        if re.search(r'\b' + re.escape(key) + r'\b', words):
            return "no_source"
    return None


def firmware_cache_dir():
    """Persistent cache for fetched firmware, following the same MicroSD-first, tmpfs-fallback
    convention the rest of the appliance uses for anything that must survive a reboot."""
    base = "/mnt/data/firmware" if os.path.isdir("/mnt/data") else "/var/cache/mantaprint/firmware"
    path = os.path.join(base, "hp")
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path


def _firmware_attempts_path():
    return os.path.join(firmware_cache_dir(), ".attempts.json")


def _load_firmware_attempts():
    try:
        with open(_firmware_attempts_path(), "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_firmware_attempts(data):
    try:
        with open(_firmware_attempts_path(), "w") as f:
            json.dump(data, f)
    except Exception:
        pass


def get_hp_firmware(key, force=False):
    """Returns a local path to `key`'s firmware .dl file, fetching it via getweb if it isn't
    already cached. Returns None (without raising) if it's not cached and fetching failed —
    e.g. no network, or the mirror is down — recording the failure so repeated hotplug events
    for the same still-unpowered/still-offline printer don't re-trigger a fetch every time.
    `force=True` (an admin's explicit "try again now" click) bypasses that backoff window."""
    if key not in HP_FIRMWARE_MODELS:
        return None
    getweb_key, dl_name = HP_FIRMWARE_MODELS[key]
    cache_dir = firmware_cache_dir()
    cached = os.path.join(cache_dir, dl_name)
    if os.path.exists(cached) and os.path.getsize(cached) > 0:
        return cached

    attempts = _load_firmware_attempts()
    last = attempts.get(key, {})
    if not force and last.get("at") and (time.time() - last["at"]) < GETWEB_RETRY_SECONDS:
        return None  # tried recently and failed; don't hammer the mirror

    if not (os.path.exists("/usr/sbin/getweb") or os.path.exists("/usr/bin/getweb")):
        attempts[key] = {"at": time.time(), "error": "getweb not installed"}
        _save_firmware_attempts(attempts)
        return None

    try:
        os.makedirs(GETWEB_OUTPUT_DIR, exist_ok=True)
        code, out, err = exec_cmd(["getweb", getweb_key], timeout=30)
        produced = os.path.join(GETWEB_OUTPUT_DIR, dl_name)
        if code == 0 and os.path.exists(produced) and os.path.getsize(produced) > 0:
            os.makedirs(cache_dir, exist_ok=True)
            with open(produced, "rb") as src, open(cached, "wb") as dst:
                dst.write(src.read())
            try:
                os.remove(produced)
            except Exception:
                pass
            attempts.pop(key, None)
            _save_firmware_attempts(attempts)
            print(f"[*] Fetched HP firmware for {key} via getweb -> {cached}")
            return cached
        attempts[key] = {"at": time.time(), "error": (err or out or "getweb produced no output")[:300]}
        _save_firmware_attempts(attempts)
        print(f"[!] getweb {getweb_key} did not produce firmware: {attempts[key]['error']}")
        return None
    except Exception as e:
        attempts[key] = {"at": time.time(), "error": str(e)[:300]}
        _save_firmware_attempts(attempts)
        print(f"[!] Failed to fetch HP firmware for {key}: {e}")
        return None


def push_firmware_via_cups_backend(uri, dl_path):
    """Delivers a firmware .dl file to the printer at `uri` by invoking CUPS's own standard usb
    backend directly, the same way cupsd invokes any backend for a real job: DEVICE_URI in the
    environment, argv = [job-id, user, title, copies, options, filename]. This reuses the exact,
    already-hardware-verified USB claim/transfer/detach logic every other USB print job on this
    hub already depends on, rather than a new, from-scratch libusb implementation."""
    backend = "/usr/lib/cups/backend/usb-cups-orig"
    if not os.path.exists(backend):
        backend = "/usr/lib/cups/backend/usb"  # no smart wrapper installed (e.g. dev/test box)
    if not os.path.exists(backend):
        print("[!] No CUPS usb backend found; cannot deliver HP firmware.")
        return False
    try:
        env = dict(os.environ)
        env["DEVICE_URI"] = uri
        proc = subprocess.run(
            [backend, "1", "root", "MantaPrint Firmware Load", "1", "", dl_path],
            env=env, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        if proc.returncode != 0:
            print(f"[!] Firmware delivery backend exited {proc.returncode}: {proc.stderr.decode(errors='ignore')[:300]}")
        return proc.returncode == 0
    except Exception as e:
        print(f"[!] Failed to deliver HP firmware over USB: {e}")
        return False


def provision_hp_firmware(hw, force=False):
    """Orchestrates firmware acquisition + delivery for one detected HP printer. Returns
    "ready" (delivered, or this exact model doesn't need it), "provisioning" (delivered just
    now — the device will re-enumerate briefly), "needs_firmware" (not delivered yet: no
    network/mirror down/not cached, will retry on the next hotplug sync), or "unsupported"
    (genuinely needs firmware but we have no automatic source for it). `force=True` is an
    admin's explicit "try again now" click: bypasses the getweb retry backoff."""
    key = needs_hp_firmware(hw.get("vendor", ""), hw.get("model", ""))
    if key is None:
        return "ready"
    if key == "no_source":
        return "unsupported"
    dl_path = get_hp_firmware(key, force=force)
    if not dl_path:
        return "needs_firmware"
    ok = push_firmware_via_cups_backend(hw["uri"], dl_path)
    return "provisioning" if ok else "needs_firmware"


## ---------------------------------------------------------------------------------------
## Readiness: an honest "will this queue actually print" signal, persisted for the hub web
## app to read (server.mjs merges it into the printer objects it serves to the admin UI).
## Previously a printer with NO real driver match still got a queue, got enabled, and got
## broadcast over AirPrint identically to one with a confirmed-correct driver — the only
## difference was an internal debug string ("Fallback Generic PCL") nobody but a developer
## reading server logs would ever see.
## ---------------------------------------------------------------------------------------
READY = "ready"
READINESS_NEEDS_FIRMWARE = "needs_firmware"
READINESS_PROVISIONING = "provisioning"
READINESS_NEEDS_REVIEW = "needs_review"
READINESS_UNSUPPORTED = "unsupported"


def verify_queue_cupsfilter(queue_name):
    """Checks that every filter binary a provisioned queue's PPD declares (the `*cupsFilter`/
    `*cupsFilter2` lines) actually exists and is executable. Catches the failure mode a wrong
    driver match, a missing package, or an architecture mismatch (e.g. an x86-only filter on
    the ARM64 appliance) would otherwise only surface as a silently-swallowed failed job.
    Returns (ok: bool, detail: str). A driverless IPP Everywhere queue has no *cupsFilter lines
    at all and always passes (the printer's own firmware does the rendering)."""
    ppd_path = f"/etc/cups/ppd/{queue_name}.ppd"
    if not os.path.exists(ppd_path):
        return True, "driverless (no PPD)"
    try:
        with open(ppd_path, "r", errors="ignore") as f:
            content = f.read()
    except Exception as e:
        return False, f"could not read PPD: {e}"

    filters = re.findall(r'^\*cupsFilter2?:\s*"([^"]+)"', content, re.MULTILINE)
    if not filters:
        return True, "no filter chain declared"

    filter_dir = "/usr/lib/cups/filter"
    missing = []
    for line in filters:
        parts = line.split()
        program = parts[3] if len(parts) >= 4 else (parts[-1] if parts else "")
        if not program or program == "-":
            continue
        fpath = program if program.startswith("/") else os.path.join(filter_dir, program)
        if not (os.path.exists(fpath) and os.access(fpath, os.X_OK)):
            missing.append(program)
    if missing:
        return False, f"missing filter binary: {', '.join(missing)}"
    return True, "filter chain OK"


def describe_readiness(hw, resolved, is_ipp):
    """Combines driver-match confidence, HP firmware state and the cupsfilter check into one
    state + reason, for one hardware entry. `resolved` is a resolve_driver() result (or None for
    an IPP-over-USB device, which never goes through the PPD matcher).

    Returns (state, reason_code, detail). `reason_code` is a short, stable key the hub web app
    translates client-side (frontend/src/i18n/ui.js, adm.printers.readiness.reasons) — the admin
    UI is English/Indonesian throughout, so this function must never hand the frontend a
    ready-made English sentence to display as-is. `detail` is an optional, untranslated technical
    fragment (a matched driver's debug description, or a missing filter binary's name) that a
    reason string may fold in with "{detail}"; empty for reason codes that don't need one."""
    hp_state = provision_hp_firmware(hw)
    if hp_state == "unsupported":
        return READINESS_UNSUPPORTED, "hp_no_source", ""
    if hp_state == READINESS_NEEDS_FIRMWARE:
        return hp_state, "firmware_downloading", ""
    if hp_state == READINESS_PROVISIONING:
        return hp_state, "firmware_sent", ""

    if is_ipp:
        return READY, "driverless", ""
    return driver_readiness(resolved, hw["queue_name"])


def driver_readiness(resolved, queue_name):
    """The driver half of describe_readiness(), shared with network printers adopted from
    discovery (which have no USB firmware question to answer first)."""
    if resolved is None:
        return READINESS_NEEDS_REVIEW, "no_driver_info", ""
    if resolved.get("uri") == "everywhere":
        return READY, "driverless", ""
    if resolved.get("uri") == "raw":
        return READY, "raw", ""
    if resolved.get("confidence") == "none":
        return READINESS_UNSUPPORTED, "no_driver_match", ""
    if resolved.get("confidence") == "fuzzy":
        return READINESS_NEEDS_REVIEW, "fuzzy_match", resolved.get("desc", "")[:80]

    ok, detail = verify_queue_cupsfilter(queue_name)
    if not ok:
        return READINESS_NEEDS_REVIEW, "broken_filter_chain", detail
    return READY, "driver_ok", ""


def load_readiness_file():
    try:
        with open(READINESS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_readiness(readiness_by_queue):
    try:
        os.makedirs(os.path.dirname(READINESS_FILE), exist_ok=True)
        tmp = READINESS_FILE + f".tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(readiness_by_queue, f)
        os.replace(tmp, READINESS_FILE)
    except Exception as e:
        print(f"[!] Failed to write readiness file: {e}")


def update_readiness(updates, keep=None):
    """Read-modify-write of the readiness file under an exclusive lock: the hotplug sync and a
    network adoption run as separate processes and must not overwrite each other's entries.
    `keep(queue)` decides which existing entries survive; updated queues always do."""
    import fcntl
    try:
        os.makedirs(os.path.dirname(READINESS_FILE), exist_ok=True)
        with open(READINESS_FILE + ".lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            current = load_readiness_file()
            if keep is not None:
                current = {q: v for q, v in current.items() if keep(q)}
            current.update(updates)
            save_readiness(current)
    except Exception as e:
        print(f"[!] Failed to update readiness file: {e}")


def is_network_uri(uri):
    """A CUPS device URI that reaches a printer over the LAN (not USB, not the local ipp-usb
    bridge on 127.0.0.1:60000+)."""
    uri = uri or ""
    if re.match(r"^ipps?://(localhost|127\.0\.0\.1):60\d\d", uri):
        return False
    return uri.startswith(("socket://", "ipp://", "ipps://", "lpd://", "http://", "https://", "dnssd://"))


# ---- Network printer discovery & adoption ---------------------------------------------------
#
# Finds printers on the LAN (mDNS via avahi-browse, plus SNMP via CUPS's own snmp backend for
# old JetDirect-style printers that don't do mDNS), works out whether phones can already print
# to each one directly (AirPrint / IPP Everywhere) or whether it needs the hub in front of it
# with a driver, and can add ("adopt") one as a CUPS queue. See docs/12-driver-compatibility.md.

DISCOVERY_FILE = "/run/mantaprint/network_discovery.json"
AUTO_ADOPTED_FILE = "/var/cache/cups/mantaprint_auto_adopted.json"
AVAHI_PRINTER_TYPES = {
    "_ipp._tcp": "ipp",
    "_ipps._tcp": "ipps",
    "_pdl-datastream._tcp": "socket",
    "_printer._tcp": "lpd",
}
DEFAULT_PORTS = {"ipp": 631, "ipps": 631, "socket": 9100, "lpd": 515}
_AVAHI_LINE = re.compile(r"^=;([^;]*);([^;]*);(.*?);(_[A-Za-z0-9_-]+\._(?:tcp|udp));([^;]*);([^;]*);([^;]*);(\d+);?(.*)$")


def _avahi_decode(text, i=0, stop=None):
    """Decodes avahi-browse -p escaping (\\DDD = one decimal byte, \\x = literal x) from text[i:]
    up to an unescaped `stop` char. Bytes are collected first so escaped UTF-8 names survive.
    Returns (decoded, index just past the stop char)."""
    out = bytearray()
    n = len(text)
    while i < n and text[i] != stop:
        if text[i] == "\\" and i + 1 < n:
            code = text[i + 1:i + 4]
            if len(code) == 3 and code.isdigit() and int(code) < 256:
                out.append(int(code))
                i += 4
            else:
                out += text[i + 1].encode("utf-8")
                i += 2
            continue
        out += text[i].encode("utf-8")
        i += 1
    return out.decode("utf-8", errors="replace"), i + 1


def _avahi_unescape(text):
    return _avahi_decode(text or "")[0]


def _parse_avahi_txt(field):
    """TXT records as avahi-browse -p prints them: "k=v" "k2=v2". Keys are case-insensitive in
    DNS-SD, so they're lower-cased; the first occurrence wins."""
    txt = {}
    field = field or ""
    i, n = 0, len(field)
    while i < n:
        if field[i] != '"':
            i += 1
            continue
        item, i = _avahi_decode(field, i + 1, '"')
        key, _, value = item.partition("=")
        if key and key.lower() not in txt:
            txt[key.lower()] = value
    return txt


def parse_avahi_browse(stdout):
    """Resolved ("=") entries from `avahi-browse -rptk <type>`."""
    services = []
    for line in (stdout or "").splitlines():
        m = _AVAHI_LINE.match(line)
        if not m:
            continue
        iface, proto, name, stype, _domain, hostname, address, port, txt = m.groups()
        services.append({
            "iface": iface, "proto": proto, "name": _avahi_unescape(name), "type": stype,
            "hostname": hostname, "address": address, "port": int(port), "txt": _parse_avahi_txt(txt),
        })
    return services


def parse_lpinfo(stdout):
    """`lpinfo -l -v` blocks -> dicts. Bare scheme entries ("uri = socket") are the manual-entry
    placeholders CUPS lists for every network backend, not discovered printers, so they're dropped."""
    devices, cur = [], None
    for line in (stdout or "").splitlines():
        m = re.match(r"^Device:\s+uri\s*=\s*(\S+)", line)
        if m:
            cur = {"uri": m.group(1)}
            devices.append(cur)
            continue
        m = re.match(r"^\s+([a-z-]+)\s*=\s*(.*)$", line)
        if m and cur is not None:
            cur[m.group(1).replace("-", "_")] = m.group(2).strip()
    return [d for d in devices if "://" in d["uri"]]


def _run_parallel(cmds, timeout):
    """Runs discovery commands side by side; a slow one is killed at the deadline and whatever
    it printed so far is still used."""
    procs = []
    for cmd in cmds:
        try:
            procs.append(subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                          stdin=subprocess.DEVNULL, text=True))
        except Exception:
            procs.append(None)
    deadline = time.time() + timeout
    outs = []
    for p in procs:
        if p is None:
            outs.append("")
            continue
        try:
            out, _ = p.communicate(timeout=max(0.1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            p.kill()
            out, _ = p.communicate()
        outs.append(out or "")
    return outs


def _split_make_model(make_model, mfg="", mdl=""):
    """(vendor, model) in the shape a USB printer's IEEE 1284 MFG/MDL would have, which is what
    resolve_driver() is tuned for: the device's own 1284 fields when the network advertised them,
    else the make-and-model string with the vendor word dropped - except for HP, whose own 1284
    MDL does start with "HP" ("HP LaserJet 400 M401dn")."""
    make_model = (make_model or "").strip()
    if mdl:
        return (mfg or make_model.split(" ", 1)[0]).strip(), mdl.strip()
    first, _, rest = make_model.partition(" ")
    if normalize(first) in ("hp", "hewlettpackard") or not rest:
        return first, make_model
    return first, rest.strip()


def _host_of(uri):
    from urllib.parse import urlsplit
    try:
        return (urlsplit(uri).hostname or "").lower()
    except Exception:
        return ""


_MDNS_HOST = re.compile(r"\._(ipps?|pdl-datastream|printer|uscan|scanner)\._tcp\.[^/]*$", re.IGNORECASE)


def _dnssd_service_name(uri):
    """The mDNS instance name behind a dnssd://Name._ipp._tcp.local/ URI - or the ipp:// form of
    the same thing that CUPS's driverless backend lists. "" for an ordinary host URI."""
    from urllib.parse import unquote, urlsplit
    try:
        netloc = unquote(urlsplit(uri).netloc)
    except Exception:
        return ""
    if not _MDNS_HOST.search(netloc):
        return ""
    return _MDNS_HOST.sub("", netloc)


def merge_discovered(avahi_services, lpinfo_devices, local_ips=()):
    """Folds mDNS services and SNMP/lpinfo devices into one candidate per printer. A printer
    advertises the same instance name for each protocol it speaks, so mDNS services are keyed by
    (IPv4 address, instance name) - which also keeps several queues shared by one print server
    apart. SNMP results (address only) join the single mDNS printer at that address, if any."""
    local = set(local_ips or ())
    by_key = {}

    def cand(key):
        if key not in by_key:
            by_key[key] = {
                "id": key, "host": "", "hostname": "", "name": "", "make_model": "", "vendor": "",
                "model": "", "has_1284": False, "cmd": "", "location": "", "services": {}, "service_names": [],
                "pdl": [], "airprint": False, "ipp_everywhere": False, "sources": [],
            }
        return by_key[key]

    for svc in avahi_services:
        if svc["proto"] != "IPv4" or not svc["address"] or svc["address"] in local or svc["address"].startswith("127."):
            continue
        kind = AVAHI_PRINTER_TYPES.get(svc["type"])
        if not kind or svc["port"] <= 0:
            continue  # _printer._tcp on port 0 is only a name reservation ("no LPD")
        c = cand(f"{svc['address']}|{svc['name']}")
        txt = svc["txt"]
        c["host"] = svc["address"]
        c["hostname"] = c["hostname"] or svc["hostname"]
        c["name"] = c["name"] or svc["name"]
        if svc["name"] not in c["service_names"]:
            c["service_names"].append(svc["name"])
        if "mdns" not in c["sources"]:
            c["sources"].append("mdns")
        rp = txt.get("rp", "")
        c["services"].setdefault(kind, {"port": svc["port"], "rp": rp})
        mfg, mdl = txt.get("usb_mfg", ""), txt.get("usb_mdl", "")
        make_model = txt.get("ty") or (f"{mfg} {mdl}".strip() if mdl else "") or txt.get("product", "").strip("()")
        if make_model and (not c["make_model"] or (mdl and not c.get("has_1284"))):
            c["make_model"] = c["make_model"] or make_model
            c["vendor"], c["model"] = _split_make_model(make_model, mfg, mdl)
            c["has_1284"] = bool(mdl)
        c["cmd"] = c["cmd"] or txt.get("usb_cmd", "")
        c["location"] = c["location"] or txt.get("note", "")
        for fmt in (txt.get("pdl") or "").split(","):
            fmt = fmt.strip()
            if fmt and fmt not in c["pdl"]:
                c["pdl"].append(fmt)
        if kind in ("ipp", "ipps"):
            if txt.get("urf") and txt.get("urf", "").lower() != "none":
                c["airprint"] = True
            if "image/pwg-raster" in (txt.get("pdl") or ""):
                c["ipp_everywhere"] = True

    for dev in lpinfo_devices:
        uri = dev["uri"]
        scheme = uri.split("://", 1)[0]
        info = parse_1284_device_id(dev.get("device_id", ""))
        make_model = dev.get("make_and_model", "")
        if make_model.lower() == "unknown":
            make_model = ""
        name = _dnssd_service_name(uri)
        if name:
            # An mDNS printer (CUPS's dnssd and driverless backends). Already known from
            # avahi-browse, with an address, under the same instance name -> nothing to add.
            if any(name.lower() in (n.lower() for n in c["service_names"]) for c in by_key.values()):
                continue
            c = cand(f"dnssd:{name}")
            c["name"] = name
            if name not in c["service_names"]:
                c["service_names"].append(name)
            c["services"].setdefault("dnssd", {"uri": uri})
            cmd = info.get("CMD", info.get("COMMAND SET", "")).upper()
            if scheme in ("ipp", "ipps") and ("URF" in cmd or "PWG" in cmd):
                # the driverless backend's own ipp:// URI for a printer that can do it
                c["services"]["dnssd"] = {"uri": uri}
                c["airprint"] = c["airprint"] or "URF" in cmd
                c["ipp_everywhere"] = c["ipp_everywhere"] or "PWG" in cmd
        else:
            host = _host_of(uri)
            if not host or host in local or host.startswith("127."):
                continue
            at_host = [x for x in by_key.values() if x["host"] == host]
            if len(at_host) > 1:
                continue  # a multi-queue print server already fully described by mDNS
            c = at_host[0] if at_host else cand(host)
            c["host"] = host
            port = uri.split("://", 1)[1].split("/", 1)[0].rsplit(":", 1)
            kind = {"socket": "socket", "lpd": "lpd", "ipp": "ipp", "ipps": "ipps"}.get(scheme)
            if kind:
                c["services"].setdefault(kind, {
                    "port": int(port[1]) if len(port) == 2 and port[1].isdigit() else DEFAULT_PORTS[kind],
                    "rp": uri.split("://", 1)[1].split("/", 1)[1] if "/" in uri.split("://", 1)[1] else "",
                })
        source = "mdns" if name else "snmp"
        if source not in c["sources"]:
            c["sources"].append(source)
        dev_mfg = info.get("MFG", info.get("MANUFACTURER", ""))
        dev_mdl = info.get("MDL", info.get("MODEL", ""))
        mm = make_model or f"{dev_mfg} {dev_mdl}".strip()
        if mm and (not c["make_model"] or (dev_mdl and not c.get("has_1284"))):
            c["make_model"] = c["make_model"] or mm
            c["vendor"], c["model"] = _split_make_model(mm, dev_mfg, dev_mdl)
            c["has_1284"] = bool(dev_mdl)
        c["cmd"] = c["cmd"] or info.get("CMD", info.get("COMMAND SET", ""))
        c["name"] = c["name"] or dev.get("info", "") or c["make_model"]
        c["location"] = c["location"] or dev.get("location", "")
    result = list(by_key.values())
    for c in result:
        c["shared_host"] = bool(c["host"]) and sum(1 for x in result if x["host"] == c["host"]) > 1
    return result


def _adopt_uri(c):
    """Best device URI for a legacy (non-driverless) printer: raw 9100 > IPP > LPD."""
    host, svcs = c["host"], c["services"]
    if "socket" in svcs:
        return f"socket://{host}:{svcs['socket']['port']}", "socket"
    if "ipp" in svcs:
        return f"ipp://{host}:{svcs['ipp']['port']}/{svcs['ipp']['rp'] or 'ipp/print'}", "ipp"
    if "lpd" in svcs:
        return f"lpd://{host}:{svcs['lpd']['port']}/{svcs['lpd']['rp'] or 'lp'}", "lpd"
    if "ipps" in svcs:
        return f"ipps://{host}:{svcs['ipps']['port']}/{svcs['ipps']['rp'] or 'ipp/print'}", "ipps"
    if "dnssd" in svcs:
        return svcs["dnssd"]["uri"], "dnssd"
    return "", ""


def classify_candidate(c, engine, configured=None):
    """Adds `configured_queue`, `recommendation` and `adopt` to a candidate:
      native   - phones can already print to it directly (AirPrint / IPP Everywhere); adopting
                 it is optional and uses the driverless "everywhere" model, never a PPD guess
      driver   - legacy printer with an exact driver match: the hub makes it AirPrint-able
      review   - only a best-guess driver match
      generic  - no driver match; a generic fallback would be used (likely won't print right)
      unknown  - nothing usable to connect to"""
    configured = configured or {}
    c["configured_queue"] = None
    if c["host"]:
        # An existing queue at the same IPP path is this printer; any queue at the same address
        # is too, unless that address is a print server sharing several printers.
        for kind in ("ipp", "ipps"):
            rp = (c["services"].get(kind) or {}).get("rp")
            if rp is not None and configured.get(f"{c['host']}/{rp.strip('/')}"):
                c["configured_queue"] = configured[f"{c['host']}/{rp.strip('/')}"]
        if not c["configured_queue"] and not c.get("shared_host"):
            c["configured_queue"] = configured.get(c["host"])
    if not c["configured_queue"]:
        for name in c["service_names"]:
            if configured.get(f"dnssd:{name}"):
                c["configured_queue"] = configured[f"dnssd:{name}"]
                break

    ipp_kind = "ipp" if "ipp" in c["services"] else ("ipps" if "ipps" in c["services"] else "")
    dnssd_ipp = (c["services"].get("dnssd") or {}).get("uri", "")
    dnssd_ipp = dnssd_ipp if dnssd_ipp.startswith(("ipp://", "ipps://", "dnssd://")) and "._ipp" in dnssd_ipp.lower() else ""
    c["native"] = bool(ipp_kind or dnssd_ipp) and (c["airprint"] or c["ipp_everywhere"])
    if c["native"]:
        if ipp_kind:
            svc = c["services"][ipp_kind]
            uri = f"{ipp_kind}://{c['host']}:{svc['port']}/{svc['rp'] or 'ipp/print'}"
        else:
            uri, ipp_kind = dnssd_ipp, "dnssd"
        c["recommendation"] = "native"
        c["adopt"] = {"uri": uri, "protocol": ipp_kind, "driver": "everywhere", "confidence": "exact",
                      "driver_desc": "IPP Everywhere (driverless)"}
        return c

    uri, protocol = _adopt_uri(c)
    if not uri:
        c["recommendation"], c["adopt"] = "unknown", None
        return c
    resolved = engine.resolve_driver(c["vendor"], c["model"] or c["make_model"], c["cmd"], "")
    c["recommendation"] = {"exact": "driver", "fuzzy": "review"}.get(resolved["confidence"], "generic")
    c["adopt"] = {"uri": uri, "protocol": protocol, "driver": resolved["uri"],
                  "confidence": resolved["confidence"], "driver_desc": resolved["desc"]}
    return c


def configured_network_hosts(cups_printers):
    """Existing network queues, keyed by "<host>", "<host>/<path>" and "dnssd:<service name>"."""
    from urllib.parse import urlsplit
    out = {}
    for q, info in sorted((cups_printers or {}).items()):
        uri = info.get("uri", "")
        if not is_network_uri(uri):
            continue
        if uri.startswith("dnssd://"):
            out[f"dnssd:{_dnssd_service_name(uri)}"] = q
            continue
        host = _host_of(uri)
        if host:
            out.setdefault(host, q)
            try:
                out[f"{host}/{urlsplit(uri).path.strip('/')}"] = q
            except Exception:
                pass
    return out


def discover_network_printers(timeout=8):
    have_avahi = bool(shutil_which("avahi-browse"))
    have_lpinfo = bool(shutil_which("lpinfo"))
    cmds = []
    if have_avahi:
        cmds += [["avahi-browse", "-rptk", t] for t in AVAHI_PRINTER_TYPES]
    if have_lpinfo:
        # CUPS's snmp backend finds JetDirect-era printers that never speak mDNS; its dnssd
        # backend is only a fallback for when avahi-browse isn't installed.
        schemes = "snmp" if have_avahi else "snmp,dnssd"
        cmds.append(["lpinfo", "-l", "-v", "--include-schemes", schemes, "--timeout", str(max(2, timeout - 1))])
    outs = _run_parallel(cmds, timeout + 2) if cmds else []
    avahi_out = "\n".join(outs[:len(AVAHI_PRINTER_TYPES)]) if have_avahi else ""
    lpinfo_out = outs[-1] if have_lpinfo and outs else ""

    candidates = merge_discovered(parse_avahi_browse(avahi_out), parse_lpinfo(lpinfo_out), get_all_local_ips())
    cups_printers, _ = get_cups_printers()
    configured = configured_network_hosts(cups_printers)
    engine = get_driver_engine()
    for c in candidates:
        classify_candidate(c, engine, configured)
    order = {"driver": 0, "review": 1, "generic": 2, "native": 3, "unknown": 4}
    candidates.sort(key=lambda c: (bool(c["configured_queue"]), order.get(c["recommendation"], 9), (c["make_model"] or c["name"]).lower()))
    result = {"scanned_at": int(time.time()), "tools": {"avahi": have_avahi, "lpinfo": have_lpinfo}, "candidates": candidates}
    try:
        os.makedirs(os.path.dirname(DISCOVERY_FILE), exist_ok=True)
        tmp = DISCOVERY_FILE + f".tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(result, f)
        os.replace(tmp, DISCOVERY_FILE)
    except Exception:
        pass
    return result


def shutil_which(name):
    import shutil
    return shutil.which(name, path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")


def _unique_queue_name(base, existing):
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", base or "").strip("_")[:40] or "Network_Printer"
    candidate, n = name, 2
    while candidate in existing:
        candidate = f"{name[:36]}_{n}"
        n += 1
    return candidate


def adopt_network_printer(c, publish=False):
    """Creates a CUPS queue for a discovered printer and records its readiness. Returns a dict
    for the hub (which owns printers_config.json and the network-printer mDNS broadcast)."""
    adopt = c.get("adopt")
    if not adopt:
        return {"ok": False, "code": "not_adoptable"}
    if c.get("configured_queue"):
        return {"ok": False, "code": "already_configured", "queue": c["configured_queue"]}
    uri = adopt["uri"]
    if not is_network_uri(uri):
        return {"ok": False, "code": "not_adoptable"}
    cups_printers, _ = get_cups_printers()
    display = (c.get("make_model") or c.get("name") or c.get("host") or "Network printer").strip()[:64]
    queue = _unique_queue_name(display, cups_printers)
    driver = adopt["driver"]
    cmd = ["lpadmin", "-p", queue, "-E", "-v", uri, "-D", display, "-L", (c.get("location") or "Network")[:64],
           "-o", "printer-error-policy=abort-job", "-o", f"printer-is-shared={'true' if publish else 'false'}"]
    if driver in ("everywhere", "raw"):
        cmd += ["-m", driver]
    elif driver.startswith("/"):
        cmd += ["-P", driver]
    else:
        cmd += ["-m", driver]
    # "everywhere" makes cupsd query the printer for its capabilities, which can take a while.
    code, _, err = exec_cmd(cmd, timeout=60)
    if code != 0:
        return {"ok": False, "code": "lpadmin_failed", "detail": (err or "")[-200:]}
    hw_like = {"vendor": c.get("vendor", ""), "model": c.get("make_model", ""), "cmd": c.get("cmd", ""), "des": c.get("make_model", "")}
    if driver != "raw" and not is_roll_or_thermal_printer(hw_like, adopt.get("driver_desc", "")):
        exec_cmd(["lpadmin", "-p", queue, "-o", "PageSize=A4", "-o", "cupsFitToPage=True"])
    exec_cmd(["cupsenable", queue])
    exec_cmd(["cupsaccept", queue])

    state, reason_code, detail = driver_readiness(
        {"uri": driver, "confidence": adopt["confidence"], "desc": adopt.get("driver_desc", "")}, queue)
    update_readiness({queue: {"state": state, "reason_code": reason_code, "detail": detail,
                              "confidence": adopt["confidence"], "updated_at": int(time.time())}})
    return {"ok": True, "code": "adopted", "queue": queue, "display_name": display, "uri": uri,
            "protocol": adopt["protocol"], "location": c.get("location") or "Network", "readiness": state,
            "reason_code": reason_code, "published": bool(publish and state == READY), "host": c.get("host", "")}


def auto_adopt_eligible(c):
    """Auto-adoption only takes a printer phones *can't* already print to, with an exact driver
    match. Driverless printers don't need the hub, and a guessed driver shouldn't be broadcast
    without a human confirming it prints."""
    adopt = c.get("adopt") or {}
    return (c.get("recommendation") == "driver" and not c.get("configured_queue")
            and adopt.get("driver") not in (None, "raw") and bool(c.get("host")))


def auto_adopt(candidates):
    """Adopts every eligible printer once. A host is remembered after its first auto-adoption so
    an admin who deletes the queue doesn't see it come straight back 15 minutes later."""
    try:
        with open(AUTO_ADOPTED_FILE) as f:
            seen = set(json.load(f))
    except Exception:
        seen = set()
    adopted = []
    for c in candidates:
        if not auto_adopt_eligible(c) or c["host"] in seen:
            continue
        res = adopt_network_printer(c, publish=True)
        seen.add(c["host"])
        if res.get("ok"):
            if res["readiness"] != READY:
                # Only a verified-working queue gets shared automatically.
                exec_cmd(["lpadmin", "-p", res["queue"], "-o", "printer-is-shared=false"])
            c["configured_queue"] = res["queue"]
            adopted.append(res)
    try:
        os.makedirs(os.path.dirname(AUTO_ADOPTED_FILE), exist_ok=True)
        with open(AUTO_ADOPTED_FILE, "w") as f:
            json.dump(sorted(seen), f)
    except Exception:
        pass
    return adopted


_last_sync_time = 0
_last_sync_result = []

def sync_all_printers():
    """
    Synchronizes physical USB printers with CUPS queues and Avahi advertisements.
    Thread-safe; safe to invoke from udev events or HTTP endpoints concurrently.
    """
    global _last_sync_time, _last_sync_result
    with _lock:
        now = time.time()
        # Debounce burst events within 1.5 seconds to ensure idempotency and prevent thrashing
        if (now - _last_sync_time < 1.5) and _last_sync_result is not None:
            return _last_sync_result

        # Self-healing: verify Avahi mDNS daemon is active, restart if dead
        _, avahi_st, _ = exec_cmd(["systemctl", "is-active", "avahi-daemon"])
        if avahi_st != "active":
            print("[!] Avahi daemon is inactive or crashed. Restarting avahi-daemon...")
            exec_cmd(["systemctl", "restart", "avahi-daemon"])

        # Silence CUPS native raw DNS-SD to prevent duplicate "@ host" Generic PostScript broadcasts
        exec_cmd(["cupsctl", "BrowseLocalProtocols=none"])

        cleanup_legacy_services()
        hw_printers = probe_hardware_printers()
        cups_printers, default_q = get_cups_printers()
        engine = get_driver_engine()

        avahi_changed = False
        connected_queues = set()
        readiness_by_queue = {}

        for hw in hw_printers:
            q_name = hw["queue_name"]
            connected_queues.add(q_name)
            is_ipp = hw.get("is_ipp", False)
            hw_uri = hw["uri"]
            is_color = hw.get("is_color", not any(k in hw["model"].lower() for k in ["laser", "hl-", "lbp", "m1132", "p1102", "1020"]))
            is_roll = False
            # Resolved once per hotplugged device and reused for provisioning, upgrade checks
            # and the readiness verdict below, instead of matching the driver up to three times.
            resolved = None if is_ipp else engine.resolve_driver(hw["vendor"], hw["model"], hw.get("cmd", ""), hw.get("des", ""))

            # Check if queue exists in CUPS
            if q_name not in cups_printers:
                if is_ipp:
                    print(f"[*] Provisioning new driverless IPP printer: {q_name} -> {hw_uri}")
                    lpadmin_cmd = [
                        "lpadmin",
                        "-p", q_name,
                        "-E",
                        "-v", hw_uri,
                        "-m", "everywhere",
                        "-D", f"{hw['display_name']} @ MantaPrint",
                        "-L", "MantaPrint Hub"
                    ]
                else:
                    ppd, desc = resolved["uri"], resolved["desc"]
                    is_roll = is_roll_or_thermal_printer(hw, ppd)
                    print(f"[*] Provisioning classic USB printer: {q_name} using PPD: {ppd} ({desc}) [confidence={resolved['confidence']}] [is_roll={is_roll}]")
                    lpadmin_cmd = [
                        "lpadmin",
                        "-p", q_name,
                        "-E",
                        "-v", hw_uri,
                        "-D", f"{hw['display_name']} @ MantaPrint",
                        "-L", "MantaPrint Hub"
                    ]
                    if ppd == "raw":
                        lpadmin_cmd.extend(["-m", "raw"])
                    elif ppd.startswith("/"):
                        lpadmin_cmd.extend(["-P", ppd])
                    else:
                        lpadmin_cmd.extend(["-m", ppd])

                code, _, err = exec_cmd(lpadmin_cmd)
                if code == 0:
                    cmd_opts = ["-o", "printer-error-policy=abort-job", "-o", "printer-is-shared=true"]
                    # Only enforce A4 on standard sheet printers, NEVER on thermal receipts or labels
                    if not is_roll:
                        cmd_opts.extend(["-o", "PageSize=A4", "-o", "cupsFitToPage=True"])
                    if not is_color:
                        cmd_opts.extend(["-o", "print-color-mode-default=monochrome"])
                    if cmd_opts:
                        exec_cmd(["lpadmin", "-p", q_name] + cmd_opts)
                        exec_cmd(["lpoptions", "-p", q_name] + cmd_opts)
                    exec_cmd(["cupsenable", q_name])
                    exec_cmd(["cupsaccept", q_name])
                else:
                    print(f"[!] Failed to add printer {q_name}: {err}")
            else:
                current_ppd_nick = cups_printers.get(q_name, {}).get("ppd_nickname", "").lower()
                is_roll = is_roll_or_thermal_printer(hw, current_ppd_nick)
                current_uri = cups_printers.get(q_name, {}).get("uri", "")

                # 1. Existing queue: check if URI needs upgrade to driverless IPP
                if is_ipp and not current_uri.startswith("ipp://"):
                    print(f"[*] Upgrading existing queue {q_name} to driverless IPP Everywhere: {hw_uri}")
                    upgrade_opts = ["-o", "printer-error-policy=abort-job", "-o", "printer-is-shared=true"]
                    if not is_roll:
                        upgrade_opts.extend(["-o", "PageSize=A4", "-o", "cupsFitToPage=True"])
                    exec_cmd(["lpadmin", "-p", q_name, "-v", hw_uri, "-m", "everywhere"] + upgrade_opts)
                    if upgrade_opts:
                        exec_cmd(["lpoptions", "-p", q_name] + upgrade_opts)

                # 2. Existing queue: check if driver is generic / sub-optimal and needs upgrade
                elif not is_ipp:
                    best_ppd, desc = resolved["uri"], resolved["desc"]
                    is_suboptimal = ("generic" in current_ppd_nick or "sample.drv" in current_ppd_nick or not current_ppd_nick)
                    if is_suboptimal and best_ppd and ("sample.drv/generic" not in best_ppd):
                        print(f"[*] Upgrading sub-optimal driver for {q_name} (was: '{current_ppd_nick}') -> {best_ppd} ({desc})")
                        if best_ppd == "raw":
                            exec_cmd(["lpadmin", "-p", q_name, "-m", "raw"])
                        elif best_ppd.startswith("/"):
                            exec_cmd(["lpadmin", "-p", q_name, "-P", best_ppd])
                        else:
                            exec_cmd(["lpadmin", "-p", q_name, "-m", best_ppd])

                # Enforce printer-error-policy=abort-job and printer-is-shared=true
                cmd_opts = ["-o", "printer-error-policy=abort-job", "-o", "printer-is-shared=true"]
                if not is_roll:
                    cmd_opts.extend(["-o", "PageSize=A4", "-o", "cupsFitToPage=True"])
                if not is_color:
                    cmd_opts.extend(["-o", "print-color-mode-default=monochrome"])
                if cmd_opts:
                    exec_cmd(["lpadmin", "-p", q_name] + cmd_opts)
                    exec_cmd(["lpoptions", "-p", q_name] + cmd_opts)

                # Only enable/accept if stopped to avoid slow subprocess calls
                if cups_printers.get(q_name, {}).get("state") != "idle":
                    exec_cmd(["cupsenable", q_name])
                    exec_cmd(["cupsaccept", q_name])

            # Determine UUID
            printer_uuid = hw.get("uuid") or cups_printers.get(q_name, {}).get("uuid")
            if not printer_uuid:
                printer_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"mantaprint-{q_name}"))

            # Determine color/duplex
            is_color = hw.get("is_color", not any(k in hw["model"].lower() for k in ["laser", "hl-", "lbp", "m1132", "p1102", "1020"]))

            # Readiness: only a queue we're actually confident will print gets broadcast over
            # AirPrint/Mopria. A printer waiting on firmware, with no real driver match, or only
            # a fuzzy guess still gets its CUPS queue (so it's visible and jobs can queue up) but
            # is held back from mDNS until it verifiably works — previously every queue was
            # broadcast identically regardless of how the driver was actually chosen.
            state, reason_code, detail = describe_readiness(hw, resolved, is_ipp)
            readiness_by_queue[q_name] = {
                "state": state, "reason_code": reason_code, "detail": detail,
                "confidence": (resolved or {}).get("confidence"), "updated_at": int(time.time())
            }
            if state == READY:
                if write_avahi_service(q_name, hw["display_name"], hw["model"], printer_uuid, is_color=is_color):
                    avahi_changed = True
            else:
                print(f"[*] Not broadcasting {q_name} over mDNS yet: {state} — {reason_code} {detail}".strip())
                if remove_avahi_service(q_name):
                    avahi_changed = True

        # Mark CUPS queues offline for any USB / IPP-USB printers that are temporarily disconnected.
        # DO NOT call lpadmin -x or cancel jobs to prevent destroying queues during USB bus resets or power cycles.
        for q_name, q_info in list(cups_printers.items()):
            cur_uri = q_info.get("uri", "")
            if (cur_uri.startswith("usb://") or cur_uri.startswith("ipp://localhost:600") or cur_uri.startswith("ipp://127.0.0.1:600")) and q_name not in connected_queues:
                # 1. Never disable if currently printing or processing a job
                if q_info.get("state") in ("processing", "printing"):
                    print(f"[*] Preserving actively printing queue: {q_name}")
                    continue
                # 2. Never disable if hardware is physically present in USB sysfs (prevents false disconnect during print transfer)
                if is_device_connected_sysfs(cur_uri):
                    print(f"[*] Preserving queue {q_name}: hardware physically present in USB sysfs")
                    connected_queues.add(q_name)
                    continue
                print(f"[*] Marking disconnected printer queue offline: {q_name}")
                exec_cmd(["cupsdisable", "-r", "Printer offline atau dimatikan", q_name])
                exec_cmd(["lpadmin", "-p", q_name, "-o", "printer-is-shared=false"])
                remove_avahi_service(q_name)
                # Retain queue in CUPS so spooled jobs and client configurations persist

        # Dynamically set default destination to the physically connected printer
        if connected_queues:
            primary_queue = list(connected_queues)[0]
            if (not default_q) or (default_q not in connected_queues) or (len(connected_queues) == 1 and default_q != primary_queue):
                print(f"[*] Dynamically routing default printer destination to connected device: {primary_queue}")
                exec_cmd(["lpadmin", "-d", primary_queue])
                exec_cmd(["lpoptions", "-d", primary_queue])
                default_q = primary_queue
        else:
            exec_cmd(["lpoptions", "-x"])
            default_q = None

        if avahi_changed:
            exec_cmd(["systemctl", "reload", "avahi-daemon"])

        # Only persist readiness for hardware that's actually connected right now; a queue for
        # long-unplugged hardware shouldn't keep showing a stale "ready"/"needs firmware" pill.
        # Network queues (adopted from discovery) aren't hotplug hardware and keep theirs.
        network_queues = {q for q, info in cups_printers.items() if is_network_uri(info.get("uri", ""))}
        update_readiness(readiness_by_queue, keep=lambda q: q in connected_queues or q in network_queues)

        _last_sync_time = time.time()
        _last_sync_result = list(connected_queues)
        return _last_sync_result

# Compatibility alias for scripts and external services
sync_printers = sync_all_printers

def print_test_page(target_printer=None):
    """Safely prints a test page to the requested or default printer."""
    cups_printers, default_q = get_cups_printers()
    if target_printer and target_printer not in cups_printers:
        target_printer = None
    printer = target_printer or default_q
    if not printer and cups_printers:
        printer = list(cups_printers.keys())[0]

    if not printer:
        return False, "Tidak ada printer aktif yang terhubung."

    # Validate printer name characters strictly to prevent command injection
    if not re.match(r'^[a-zA-Z0-9_-]+$', printer):
        return False, "Invalid printer queue name. Only alphanumeric, dashes, and underscores allowed."

    # Ensure requested printer exists
    if cups_printers and printer not in cups_printers:
        return False, f"Printer queue '{printer}' does not exist."

    # Generate custom HeykPrint test page PDF
    pdf_path = f"/tmp/mantaprint_testpage_{printer}.pdf"
    if generate_mantaprint_test_page:
        info = {
            "model": cups_printers.get(printer, {}).get("info", printer.replace("_", " ")),
            "queue": printer,
            "uri": cups_printers.get(printer, {}).get("uri", "")
        }
        try:
            generate_mantaprint_test_page(pdf_path, info)
        except Exception as e:
            print(f"[!] Warning: failed to generate custom test page: {e}")
            pdf_path = "/usr/share/cups/data/testprint"
    else:
        pdf_path = "/usr/share/cups/data/testprint"

    print_file = pdf_path if os.path.exists(pdf_path) else "/usr/share/cups/data/testprint"
    code, out, err = exec_cmd(["lp", "-d", printer, "-o", "fit-to-page", "-o", "PageSize=A4", print_file])
    if code == 0:
        return True, f"Halaman uji coba kustom MantaPrint berhasil dikirim ke {printer}!"
    else:
        return False, f"Gagal mencetak: {err or out}"

def cancel_all_jobs(target_printer=None):
    """Cancels and purges all active print jobs across all queues with -x."""
    args = ["cancel", "-a", "-x"]
    if target_printer:
        args.append(target_printer)
    code, out, err = exec_cmd(args)
    exec_cmd(["cupsenable", "-c"])
    return code == 0, err or out

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "sync"
    if action == "test":
        target = sys.argv[2] if len(sys.argv) > 2 else None
        ok, msg = print_test_page(target)
        print(f"[{'+' if ok else '!'}] {msg}")
        sys.exit(0 if ok else 1)
    elif action in ("cancel", "purge"):
        target = sys.argv[2] if len(sys.argv) > 2 else None
        ok, msg = cancel_all_jobs(target)
        print(f"[{'+' if ok else '!'}] {msg or 'All print jobs cancelled and spool purged.'}")
        sys.exit(0 if ok else 1)
    elif action == "provision-firmware":
        # Admin-triggered "try again now" for one queue (see /api/printers/:queue/provision-firmware
        # in server.mjs). Re-probes hardware to find that exact queue, forces a fresh firmware
        # attempt bypassing the getweb backoff, then runs a full sync so readiness/Avahi reflect
        # the outcome immediately.
        target_queue = sys.argv[2] if len(sys.argv) > 2 else None
        hw_list = probe_hardware_printers()
        target_hw = next((h for h in hw_list if h["queue_name"] == target_queue), None)
        if not target_hw:
            print(f"[!] Queue '{target_queue}' is not currently detected as connected hardware.")
            sys.exit(1)
        result = provision_hp_firmware(target_hw, force=True)
        print(f"[*] provision-firmware {target_queue}: {result}")
        sync_all_printers()
        sys.exit(0 if result in ("ready", "provisioning") else 1)
    elif action == "discover-network":
        # Hub admin "Scan network" and the periodic auto-adopt pass (server.mjs). Output is one
        # DISCOVERY_JSON: line so stray log lines from the driver index can't corrupt it.
        result = discover_network_printers()
        result["adopted"] = auto_adopt(result["candidates"]) if "--auto-adopt" in sys.argv else []
        print("DISCOVERY_JSON:" + json.dumps(result))
        sys.exit(0)
    elif action == "adopt-network":
        # Adopt one candidate by id from the last scan (re-scanning if that's stale or gone).
        target_id = sys.argv[2] if len(sys.argv) > 2 else ""
        publish = "--publish" in sys.argv
        found = None
        try:
            with open(DISCOVERY_FILE) as f:
                cached = json.load(f)
            if time.time() - cached.get("scanned_at", 0) < 900:
                found = next((c for c in cached["candidates"] if c["id"] == target_id), None)
        except Exception:
            pass
        if found is None:
            found = next((c for c in discover_network_printers()["candidates"] if c["id"] == target_id), None)
        else:
            # The cached verdict may be minutes old; re-check it isn't configured already.
            classify_candidate(found, get_driver_engine(), configured_network_hosts(get_cups_printers()[0]))
        res = adopt_network_printer(found, publish=publish) if found else {"ok": False, "code": "not_found"}
        print("ADOPT_JSON:" + json.dumps(res))
        sys.exit(0 if res.get("ok") else 1)
    else:
        print("[*] Running standalone MantaPrint Printer Manager synchronization...")
        active = sync_all_printers()
        print(f"[*] Synchronized active printers: {active}")
