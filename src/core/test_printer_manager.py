#!/usr/bin/env python3
"""
Verification script for the MantaPrint driver-matching engine (printer_manager.py).

Run directly (matches the convention of test_image_processor.py — there is no pytest in
this repo's runtime image): `python3 src/core/test_printer_manager.py`

Requires the same driver packages install.sh provisions (cups-filters, printer-driver-all,
printer-driver-brlaser/-escpr/-foo2zjs/-splix, libsane-hpaio, printer-driver-ptouch, dymo,
plus the Canon UFR II LT .deb and captdriver's PPDs under drivers/). On a bare devbox without
these installed, DriverEngine.rebuild_index() finds nothing and every case here is skipped
with a note rather than failing, so this script is safe to run anywhere but only meaningful
where the real driver set is present (i.e. the appliance image, or a container built from
install.sh's package list).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import printer_manager as pm

PASS = 0
FAIL = 0
SKIPPED = 0


def check(label, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  [OK] {label}")
    else:
        FAIL += 1
        print(f"  [FAIL] {label}{': ' + detail if detail else ''}")


def resolve(engine, mfg, mdl, cmd="", des=""):
    return engine.resolve_driver(mfg, mdl, cmd, des)


# `avahi-browse -rptk <type>` and `lpinfo -l -v` output as a real LAN produces it: an HP with
# IPP (no URF), raw 9100 and LPD; an AirPrint Canon (plus its LPD port-0 placeholder and an
# IPv6 duplicate); the hub's own re-broadcast; and SNMP-only / dnssd-only printers.
AVAHI_FIXTURE = r'''+;eth0;IPv4;HP\032LaserJet\032400\032M401dn\032\0401A2B3C\041;_ipp._tcp;local
=;eth0;IPv4;HP\032LaserJet\032400\032M401dn\032\0401A2B3C\041;_ipp._tcp;local;NPI1A2B3C.local;192.168.1.50;631;"txtvers=1" "rp=ipp/print" "ty=HP LaserJet 400 M401dn" "pdl=application/postscript,application/vnd.hp-PCL" "note=Back office" "usb_MFG=Hewlett-Packard" "usb_MDL=HP LaserJet 400 M401dn" "usb_CMD=PJL,PCL,PCLXL,POSTSCRIPT"
=;eth0;IPv6;HP\032LaserJet\032400\032M401dn\032\0401A2B3C\041;_ipp._tcp;local;NPI1A2B3C.local;fe80::1;631;"ty=HP LaserJet 400 M401dn"
=;eth0;IPv4;HP\032LaserJet\032400\032M401dn\032\0401A2B3C\041;_pdl-datastream._tcp;local;NPI1A2B3C.local;192.168.1.50;9100;"ty=HP LaserJet 400 M401dn"
=;eth0;IPv4;HP\032LaserJet\032400\032M401dn\032\0401A2B3C\041;_printer._tcp;local;NPI1A2B3C.local;192.168.1.50;515;"rp=RAW"
=;eth0;IPv4;Canon\032G3030\032series;_ipp._tcp;local;CanonG3030.local;192.168.1.61;631;"rp=ipp/print" "ty=Canon G3030 series" "pdl=image/urf,image/pwg-raster" "URF=W8,SRGB24,RS300-600"
=;eth0;IPv4;Canon\032G3030\032series;_printer._tcp;local;CanonG3030.local;192.168.1.61;0;
=;eth0;IPv4;Canon\032G3030\032\064\032MantaPrint;_ipp._tcp;local;mantaprint.local;192.168.1.114;631;"rp=printers/Canon_G3030" "URF=W8"
'''
LPINFO_FIXTURE = """Device: uri = socket
        class = network
        info = AppSocket/HP JetDirect
        make-and-model = Unknown
        device-id = 
        location = 
Device: uri = socket://192.168.1.77
        class = network
        info = Brother HL-L2350DW series
        make-and-model = Brother HL-L2350DW series
        device-id = MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:HL-L2350DW series;CLS:PRINTER;
        location = Warehouse
Device: uri = socket://192.168.1.50
        class = network
        info = HP LaserJet 400 M401dn
        make-and-model = HP LaserJet 400 M401dn
        device-id = MFG:Hewlett-Packard;MDL:HP LaserJet 400 M401dn;CMD:PJL,PCL,POSTSCRIPT;
        location = 
Device: uri = dnssd://Old%20Epson._pdl-datastream._tcp.local/
        class = network
        info = Old Epson
        make-and-model = EPSON LQ-2190
        device-id = 
        location = 
Device: uri = ipp://Canon%20G3030%20series._ipp._tcp.local/
        class = network
        info = Canon G3030 series (driverless)
        make-and-model = Canon G3030 series
        device-id = MFG:Canon;MDL:G3030 series;CMD:PWGRaster,AppleRaster,URF,PWG,JPEG;
        location = 
Device: uri = ipp://EPSON%20L6270%20Series._ipp._tcp.local/
        class = network
        info = EPSON L6270 Series (driverless)
        make-and-model = EPSON L6270 Series
        device-id = MFG:EPSON;MDL:L6270 Series;CMD:PWGRaster,URF,JPEG;
        location = 
"""


def discovery_checks():
    """Network discovery parsing/merging - pure functions, no drivers or network needed."""
    print("-- Network discovery: avahi-browse / lpinfo parsing and merging --")
    check("avahi name escapes decode (\\032 space, \\040/\\041 parens, UTF-8 bytes)",
          pm._avahi_unescape(r"HP\032LaserJet\032\0401A2B3C\041") == "HP LaserJet (1A2B3C)"
          and pm._avahi_unescape(r"Caf\195\169") == "Café")
    txt = pm._parse_avahi_txt(r'"ty=HP LaserJet" "note=Back \"office\"" "URF=W8" "TY=dup"')
    check("TXT records parse with escaped quotes, lower-cased keys, first key wins",
          txt == {"ty": "HP LaserJet", "note": 'Back "office"', "urf": "W8"}, str(txt))
    services = pm.parse_avahi_browse(AVAHI_FIXTURE)
    check("only resolved (=) avahi lines are kept", len(services) == 7, str(len(services)))
    devices = pm.parse_lpinfo(LPINFO_FIXTURE)
    check("lpinfo manual-entry placeholders (uri = socket) are dropped", [d["uri"] for d in devices][:3] == [
        "socket://192.168.1.77", "socket://192.168.1.50", "dnssd://Old%20Epson._pdl-datastream._tcp.local/"] and len(devices) == 5)

    cands = {c["id"]: c for c in pm.merge_discovered(services, devices, ["192.168.1.114"])}
    cands = {c["id"].split("|")[0]: c for c in cands.values()}
    check("one candidate per printer; the hub's own broadcast, IPv6 and driverless-backend duplicates excluded",
          sorted(cands) == ["192.168.1.50", "192.168.1.61", "192.168.1.77", "dnssd:EPSON L6270 Series", "dnssd:Old Epson"], str(sorted(cands)))
    l6270 = pm.classify_candidate(cands["dnssd:EPSON L6270 Series"], None, {})
    check("without avahi, CUPS's driverless ipp://Name._ipp._tcp.local/ entry is still recognised as AirPrint",
          l6270["recommendation"] == "native" and l6270["adopt"]["uri"] == "ipp://EPSON%20L6270%20Series._ipp._tcp.local/", str(l6270.get("adopt")))
    hp = cands["192.168.1.50"]
    check("HP merges mDNS + SNMP and all three protocols", hp["sources"] == ["mdns", "snmp"]
          and sorted(hp["services"]) == ["ipp", "lpd", "socket"] and hp["services"]["lpd"]["rp"] == "RAW")
    check("HP uses the advertised 1284 MFG/MDL (what resolve_driver is tuned for)",
          (hp["vendor"], hp["model"], hp["cmd"]) == ("Hewlett-Packard", "HP LaserJet 400 M401dn", "PJL,PCL,PCLXL,POSTSCRIPT"))
    check("HP without URF/pwg-raster is not AirPrint", not hp["airprint"] and not hp["ipp_everywhere"])
    canon = cands["192.168.1.61"]
    check("Canon with URF is AirPrint; its LPD port-0 placeholder is ignored",
          canon["airprint"] and canon["ipp_everywhere"] and sorted(canon["services"]) == ["ipp"])
    brother = cands["192.168.1.77"]
    check("SNMP-only Brother takes its model from the device ID, without the vendor word",
          (brother["vendor"], brother["model"], brother["location"]) == ("Brother", "HL-L2350DW series", "Warehouse"))
    check("dnssd-only printer keeps its dnssd:// URI", cands["dnssd:Old Epson"]["services"]["dnssd"]["uri"].startswith("dnssd://Old%20Epson"))
    check("make-and-model fallback keeps HP's own 'HP ...' model convention",
          pm._split_make_model("HP OfficeJet 250") == ("HP", "HP OfficeJet 250")
          and pm._split_make_model("EPSON L3150 Series") == ("EPSON", "L3150 Series"))

    check("is_network_uri: LAN URIs yes, USB and the local ipp-usb bridge no",
          pm.is_network_uri("socket://10.0.0.5:9100") and pm.is_network_uri("dnssd://X._ipp._tcp.local/")
          and not pm.is_network_uri("usb://HP/LaserJet") and not pm.is_network_uri("ipp://localhost:60000/ipp/print"))
    configured = pm.configured_network_hosts({"Front": {"uri": "socket://192.168.1.77:9100"}, "USB": {"uri": "usb://X"},
                                              "Old": {"uri": "dnssd://Old%20Epson._pdl-datastream._tcp.local/"}})
    check("existing network queues are recognised by host, host/path and dnssd service name",
          configured == {"192.168.1.77": "Front", "192.168.1.77/": "Front", "dnssd:Old Epson": "Old"}, str(configured))
    server = [{"host": "10.0.0.9", "service_names": [], "airprint": True, "ipp_everywhere": True,
               "shared_host": True, "services": {"ipp": {"port": 631, "rp": rp}}} for rp in ("printers/A", "printers/B")]
    server_conf = pm.configured_network_hosts({"A": {"uri": "ipp://10.0.0.9:631/printers/A"}})
    check("on a print server sharing several printers, only the queue at the same IPP path counts as configured",
          [pm.classify_candidate(c, None, server_conf)["configured_queue"] for c in server] == ["A", None])
    native = pm.classify_candidate(dict(canon), None, configured)
    check("AirPrint printer is 'native' and would be adopted driverless, never with a PPD guess",
          native["recommendation"] == "native" and native["adopt"]["driver"] == "everywhere"
          and native["adopt"]["uri"] == "ipp://192.168.1.61:631/ipp/print")
    check("auto-adopt never takes a native printer", not pm.auto_adopt_eligible(native))
    return cands, configured


def discovery_driver_checks(engine, cands, configured):
    print("\n-- Network discovery: driver verdicts (needs the real driver index) --")
    hp = pm.classify_candidate(cands["192.168.1.50"], engine, configured)
    check("HP LaserJet 400 M401dn -> HP's own PostScript PPD, exact, over raw 9100",
          hp["recommendation"] == "driver" and "hp-laserjet_400_m401" in hp["adopt"]["driver"]
          and hp["adopt"]["uri"] == "socket://192.168.1.50:9100", str(hp["adopt"]))
    check("...and is eligible for auto-adopt", pm.auto_adopt_eligible(hp))
    brother = pm.classify_candidate(cands["192.168.1.77"], engine, configured)
    check("Brother HL-L2350DW is only a sibling-model guess (review), and already configured",
          brother["recommendation"] == "review" and brother["configured_queue"] == "Front", str(brother["adopt"]))
    check("...so it's not auto-adopted", not pm.auto_adopt_eligible(brother))
    epson = pm.classify_candidate(cands["dnssd:Old Epson"], engine, {})
    check("A model with no driver is 'generic', not dressed up as working", epson["recommendation"] == "generic")
    check("A bare-number driver model (ptouch 'MDL:2300') no longer matches HL-L2300-style names",
          "ptouch" not in engine.resolve_driver("Brother", "Brother HL-L2350DW series", "PJL,PCL")["uri"])


def main():
    global SKIPPED
    cands, configured = discovery_checks()
    engine = pm.DriverEngine.__new__(pm.DriverEngine)
    engine.rebuild_index()
    print(f"\nIndexed {len(engine.drivers)} driver entries.\n")

    if len(engine.drivers) < 50:
        print("Fewer than 50 driver entries indexed — the real driver packages (printer-driver-all,")
        print("printer-driver-ptouch, libsane-hpaio, the Canon .debs, captdriver's PPDs, ...) don't")
        print("look installed here. Skipping the model-resolution assertions below (they need real")
        print("PPDs/.drv files to mean anything); syntax/import already succeeded.")
        SKIPPED = 1
        return

    print("-- contains_as_model() boundary helper --")
    check("exact end-of-string match accepted", pm.contains_as_model("lbp6018", "canoninclbp6018"))
    check("trailing letter suffix rejected (6018 vs 6018L)", not pm.contains_as_model("lbp6018", "canonlbp6018l"))
    check("trailing digit rejected (601 vs 6018)", not pm.contains_as_model("lbp601", "canonlbp6018"))
    check("no match returns False", not pm.contains_as_model("zzz", "canonlbp6018"))

    print("\n-- Canon LBP6018 (CAPT) vs LBP6018L (UFR II LT): must resolve to different PPDs --")
    capt = resolve(engine, "Canon", "LBP6018", "CAPT")
    ufr2 = resolve(engine, "Canon", "LBP6018L", "")
    check("LBP6018 (no suffix) resolves to the CAPT PPD", "CanonLBP-6000-6018" in capt["uri"], capt["uri"])
    check("LBP6018L resolves to the UFR II LT PPD", "CNRCUPSLBP6030" in ufr2["uri"], ufr2["uri"])
    check("LBP6018 and LBP6018L resolve to different PPDs", capt["uri"] != ufr2["uri"])
    lbp6018w = resolve(engine, "Canon", "LBP6018w", "")
    check("LBP6018w (documented UFR II LT sibling of 6018L) resolves to UFR II LT, not CAPT",
          "CNRCUPSLBP6030" in lbp6018w["uri"], lbp6018w["uri"])

    print("\n-- Canon multi-model PPD submodel cleanup (no more mangled 'LBP LBP6018, 0.1.4') --")
    lbp3050 = resolve(engine, "Canon", "LBP3050", "")
    check("LBP3050 resolves to the 3010/3018/3050 PPD, not the unrelated 2900/3000 one",
          "3010-3018-3050" in lbp3050["uri"], lbp3050["uri"])
    lbp6030w = resolve(engine, "Canon", "LBP6030w", "")
    check("LBP6030w still resolves to its own UFR II LT PPD",
          "CNRCUPSLBP6030" in lbp6030w["uri"], lbp6030w["uri"])

    print("\n-- HP Product-attribute aliases now indexed (drv 'Attribute \"Product\"' lines) --")
    m102a = resolve(engine, "HP", "HP LaserJet Pro M102a", "PCLm")
    check("HP LaserJet Pro M102a resolves to the m101-m106 family PPD",
          "m101-m106" in m102a["uri"], m102a["uri"])
    check("... with exact confidence", m102a["confidence"] == "exact", m102a["confidence"])
    m130a = resolve(engine, "HP", "HP LaserJet Pro MFP M130a", "PCLm")
    check("HP LaserJet Pro MFP M130a resolves to the m129-m134 family PPD",
          "m129-m134" in m130a["uri"], m130a["uri"])
    m15a = resolve(engine, "HP", "HP LaserJet Pro M15a", "PCLm")
    check("HP LaserJet Pro M15a resolves to its own m14-m17 family PPD",
          "m14-m17" in m15a["uri"], m15a["uri"])

    print("\n-- Brother P-touch/QL label printers now indexed (were falling to Generic PCL) --")
    ql800 = resolve(engine, "Brother", "QL-800", "")
    check("Brother QL-800 resolves to its ptouch-ql PPD, not Generic PCL",
          "ptouch" in ql800["uri"] and "QL-800" in ql800["uri"], ql800["uri"])
    check("... with exact confidence", ql800["confidence"] == "exact")
    ptp700 = resolve(engine, "Brother", "PT-P700", "")
    check("Brother PT-P700 resolves to its ptouch-pt PPD, not Generic PCL",
          "ptouch" in ptp700["uri"] and "PT-P700" in ptp700["uri"], ptp700["uri"])

    print("\n-- Generic ESC/POS clones -> raw, without hijacking Zebra/Dymo/P-touch --")
    xp58 = resolve(engine, "Xprinter", "XP-58", "ESC/POS")
    check("Xprinter XP-58 resolves to raw (was misclassified as 9-pin dot-matrix)",
          xp58["uri"] == "raw", xp58["uri"])
    dymo = resolve(engine, "DYMO", "LabelWriter 450", "")
    check("DYMO LabelWriter 450 still resolves to its own dymo PPD (not swept into raw)",
          "dymo" in dymo["uri"] and "lw450" in dymo["uri"], dymo["uri"])
    zebra = resolve(engine, "Zebra Technologies", "ZTC ZD230-203dpi ZPL", "ZPL")
    check("Unbranded/no-driver Zebra model falls back to the generic Zebra PPD (not raw)",
          zebra["uri"] == "drv:///sample.drv/zebraep2.ppd", zebra["uri"])

    print("\n-- Epson vendor-alias preference order is honored (was a coin flip by list order) --")
    l3210 = resolve(engine, "EPSON", "L3210 Series", "ESCPL2")
    check("Epson L3210 resolves to the L3250 alias (first-listed preference), not L3100",
          "L3250" in l3210["uri"], l3210["uri"])

    print("\n-- Roll/thermal page-size policy also covers ptouch/dymo queues --")
    check("ptouch PPD is treated as roll/label (no forced A4)",
          pm.is_roll_or_thermal_printer({}, ppd="Brother QL-800 Foomatic/ptouch-ql"))
    check("dymo PPD is treated as roll/label (no forced A4)",
          pm.is_roll_or_thermal_printer({}, ppd="dymo:0/cups/model/lw450.ppd"))

    print("\n-- match() keeps its old (uri, desc) 2-tuple contract for existing callers --")
    uri, desc = engine.match("Brother", "QL-800", "")
    check("match() 2-tuple unpack still works", isinstance(uri, str) and isinstance(desc, str))

    print("\n-- HP firmware model table (fw-download=True per HPLIP's own models.dat) --")
    check("1020 needs firmware", pm.needs_hp_firmware("Hewlett-Packard", "HP LaserJet 1020") is not None)
    check("1018 needs firmware", pm.needs_hp_firmware("HP", "HP LaserJet 1018") is not None)
    check("P1005 needs firmware", pm.needs_hp_firmware("HP", "HP LaserJet P1005") is not None)
    p1007_key = pm.needs_hp_firmware("HP", "HP LaserJet P1007")
    p1005_key = pm.needs_hp_firmware("HP", "HP LaserJet P1005")
    check("P1007 maps to the same firmware file as P1005 (getweb's own [pP]100[57] grouping)",
          p1007_key is not None and p1005_key is not None and pm.HP_FIRMWARE_MODELS[p1007_key] == pm.HP_FIRMWARE_MODELS[p1005_key])
    check("P1102 does NOT need firmware (fw-download=False per HPLIP)", pm.needs_hp_firmware("HP", "HP LaserJet Professional P1102") is None)
    check("P1102w does NOT need firmware", pm.needs_hp_firmware("HP", "HP LaserJet Professional P1102w") is None)
    check("M12a does NOT need firmware", pm.needs_hp_firmware("HP", "HP LaserJet Pro M12a") is None)
    check("M102a does NOT need firmware", pm.needs_hp_firmware("HP", "HP LaserJet Pro M102a") is None)
    check("A non-HP vendor never needs HP firmware", pm.needs_hp_firmware("Canon", "HP LaserJet 1020") is None)
    check("P1009 is a known no-automatic-source model", pm.needs_hp_firmware("HP", "HP LaserJet P1009") == "no_source")

    discovery_driver_checks(engine, cands, configured)


if __name__ == "__main__":
    main()
    print(f"\n{PASS} passed, {FAIL} failed" + (", index skipped (no driver packages installed)" if SKIPPED else ""))
    sys.exit(1 if FAIL else 0)
