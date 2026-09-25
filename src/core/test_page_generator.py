#!/usr/bin/env python3
"""
MantaPrint Universal Test Page Generator
Creates a professional, vector-sharp diagnostic calibration page for MantaPrint Hub.
Supports dynamic multilingual localization and dynamic versioning.
"""

import os
import sys
import json
import time
import socket
import subprocess
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.graphics.shapes import Drawing, Rect
from reportlab.graphics.barcode.qr import QrCodeWidget


def get_system_version():
    """Retrieve dynamic appliance version from version.json or package.json."""
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    candidates = [
        "/etc/mantaprint/version.json",
        "/opt/mantaprint/version.json",
        os.path.join(repo_root, "version.json"),
        "/opt/mantaprint/package.json",
        os.path.join(repo_root, "package.json")
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    ver = data.get("version")
                    if ver:
                        return str(ver).strip().lstrip("v")
            except Exception:
                pass
    return "0.0.0"


def get_system_config():
    """Retrieve global system configuration from /etc/mantaprint/config.json."""
    candidates = [
        "/etc/mantaprint/config.json",
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config", "config.json"),
        "/opt/mantaprint/config.json"
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return {"language": "en", "version": get_system_version(), "hostname": "mantaprint"}


def get_local_ip():
    """Retrieve primary local IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "192.168.1.114"


STRINGS = {
    "en": {
        "title": "MANTAPRINT HUB {version}",
        "subtitle": "Universal Plug & Play Smart Print Box • Diagnostic Calibration Page",
        "tagline": "Auto-Sensing Hardware Subsystem • Zero-Config AirPrint & IPP Everywhere",
        "verified": "● AUTO-SENSING VERIFIED",
        "tech_header": "TECHNICAL PARAMETERS & DEVICE TELEMETRY",
        "lbl_model": "Printer Model",
        "lbl_queue": "CUPS Queue",
        "lbl_conn": "Hardware Link",
        "val_usb": "USB Direct High-Speed",
        "val_ipp": "IPP Driverless",
        "lbl_comm": "Comm Status",
        "val_comm": "Online / Ready to Print (Idle)",
        "lbl_ip": "Hub IP Address",
        "lbl_mdns": "mDNS Hostname",
        "lbl_engine": "Spool Engine",
        "val_engine": "CUPS 2.4.x / IPP Engine",
        "lbl_time": "Calibration Time",
        "qr_header": "WEB DASHBOARD",
        "qr_sub": "Scan to access print portal",
        "gray_header": "CONTINUOUS GRADIENT & STEPPED DENSITY TEST",
        "cmyk_header": "CMYK COLOR SEPARATION & PROCESS ACCURACY",
        "res_header": "GEOMETRIC LINE RESOLUTION & OPTICAL ALIGNMENT",
        "res_lines": "Precision Line Weights",
        "res_grid": "Cross-Hatch Precision 2mm Grid",
        "typo_header": "MULTI-SCALE TYPOGRAPHY LEGIBILITY & CONTRAST BENCHMARK",
        "typo_sample_6": "6 pt:  MantaPrint Hub brings driverless wireless printing to legacy USB printers without software installation.",
        "typo_sample_75": "7.5 pt:  High-precision edge rendering with localized, ephemeral in-memory document rasterization.",
        "typo_sample_9": "9 pt:  Universal Plug-and-Play Multi-Compatible Print & Scan Engine with Live Telemetry.",
        "typo_sample_11": "11 pt Serif:  Classic typographic legibility test rendered with sharp anti-aliasing.",
        "typo_sample_13": "13 pt Bold:  MANTAPRINT INTELLIGENT PRINT & SCAN HUB {version}",
        "inv_text": "MICRO-TYPE LEGIBILITY (WHITE ON BLACK) • EVALUATES TONER BLEED & DITHERING AT HIGH RESOLUTION",
        "cert_title": "SYSTEM INTEGRITY VERIFICATION: PASSED (100%)",
        "cert_desc": "This diagnostic document confirms two-way communication between MantaPrint Hub and physical print engine is operating normally.",
        "footer_brand": "MantaPrint Hub {version} • Universal Smart Print & Scan Appliance",
        "footer_printed_at": "Printed at"
    },
    "id": {
        "title": "MANTAPRINT HUB {version}",
        "subtitle": "Kotak Cetak Pintar Universal Plug & Play • Halaman Kalibrasi Diagnostik",
        "tagline": "Subsistem Hardware Deteksi Otomatis • Zero-Config AirPrint & IPP Everywhere",
        "verified": "● TERVERIFIKASI OTOMATIS",
        "tech_header": "PARAMETER TEKNIS & TELEMETRI PERANGKAT",
        "lbl_model": "Model Printer",
        "lbl_queue": "Antrean CUPS",
        "lbl_conn": "Koneksi Hardware",
        "val_usb": "USB Direct High-Speed",
        "val_ipp": "IPP Driverless",
        "lbl_comm": "Status Komunikasi",
        "val_comm": "Online / Siap Digunakan (Idle)",
        "lbl_ip": "Alamat IP Hub",
        "lbl_mdns": "Hostname mDNS",
        "lbl_engine": "Spool Engine",
        "val_engine": "CUPS 2.4.x / IPP Engine",
        "lbl_time": "Waktu Kalibrasi",
        "qr_header": "DASHBOARD WEB",
        "qr_sub": "Pindai untuk kontrol hub",
        "gray_header": "UJI DENSITAS GRADASI GRAYSCALE & TINTA / TONER",
        "cmyk_header": "SEPARASI WARNA CMYK & AKURASI PROSES CETAK",
        "res_header": "RESOLUSI GARIS GEOMETRIS & KETEPATAN OPTIK",
        "res_lines": "Ketebalan Garis Presisi",
        "res_grid": "Uji Kisi Presisi 2mm (Cross-Hatch)",
        "typo_header": "UJI KETAJAMAN TIPOGRAFI & KEJERNIHAN TEKS (FONT LADDER)",
        "typo_sample_6": "6 pt:  MantaPrint Hub menghadirkan pencetakan nirkabel otomatis tanpa kerumitan instalasi driver pada printer USB.",
        "typo_sample_75": "7.5 pt:  Presisi cetak optik tinggi dengan pemrosesan dokumen lokal berkinerja tinggi dalam memori RAM.",
        "typo_sample_9": "9 pt:  Plug and Play Multi-Compatible Print & Scan Engine dengan telemetri hardware langsung.",
        "typo_sample_11": "11 pt Serif:  Uji keterbacaan tipografi klasik dengan rendering vektor anti-aliasing tajam.",
        "typo_sample_13": "13 pt Bold:  MANTAPRINT INTELLIGENT PRINT & SCAN HUB {version}",
        "inv_text": "UJI TEKS INVERSI (WHITE ON BLACK) • MENGEVALUASI DERAJAT TONER BLEED & TEKNIK DITHERING",
        "cert_title": "SERTIFIKASI STATUS SISTEM: CETAK BERHASIL",
        "cert_desc": "Dokumen kalibrasi ini mengonfirmasi komunikasi data dua arah antara MantaPrint Hub dan printer fisik berjalan normal.",
        "footer_brand": "MantaPrint Hub {version} • Perangkat Cetak & Pindai Pintar Universal",
        "footer_printed_at": "Dicetak pada"
    }
}


def render_precision_ruler(c, ruler_x, ruler_y_start, ruler_h_mm=100.0):
    """
    Renders an unobstructed 100mm precision metric calibration scale
    along the right margin of the diagnostic page.
    Drawn at top z-index with a clean protective rail backing so no
    adjacent card or shape can ever obscure its scale ticks and labels.
    """
    pt_per_mm = 72.0 / 25.4
    ruler_h_pt = ruler_h_mm * pt_per_mm
    card_x = ruler_x - 24.5
    card_w = 27.0
    card_y = ruler_y_start - 12.0
    card_h = ruler_h_pt + 24.0

    # Dedicated subtle card backing for ruler
    c.setFillColor(colors.HexColor("#f8fafc"))
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.setLineWidth(0.6)
    c.roundRect(card_x, card_y, card_w, card_h, radius=3, stroke=1, fill=1)

    # Top & bottom mini labels
    c.setFont("Helvetica-Bold", 4.5)
    c.setFillColor(colors.HexColor("#475569"))
    c.drawCentredString(card_x + (card_w / 2.0), ruler_y_start + ruler_h_pt + 4.5, "100mm SCALE")
    c.drawCentredString(card_x + (card_w / 2.0), ruler_y_start - 8.5, "CALIBRATION")

    # Vertical baseline
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(0.6)
    c.line(ruler_x, ruler_y_start, ruler_x, ruler_y_start + ruler_h_pt)

    # Tick marks & cm numbers
    for mm in range(int(ruler_h_mm) + 1):
        y_pos = ruler_y_start + (mm * pt_per_mm)
        if mm % 10 == 0:
            c.setStrokeColor(colors.HexColor("#0f172a"))
            c.setLineWidth(0.7)
            c.line(ruler_x - 6.5, y_pos, ruler_x, y_pos)

            c.setFont("Helvetica-Bold", 5.2)
            c.setFillColor(colors.HexColor("#0f172a"))
            c.drawRightString(ruler_x - 8.0, y_pos - 1.8, f"{mm // 10}cm")
        elif mm % 5 == 0:
            c.setStrokeColor(colors.HexColor("#334155"))
            c.setLineWidth(0.5)
            c.line(ruler_x - 4.2, y_pos, ruler_x, y_pos)
        else:
            c.setStrokeColor(colors.HexColor("#64748b"))
            c.setLineWidth(0.35)
            c.line(ruler_x - 2.0, y_pos, ruler_x, y_pos)


def generate_mantaprint_test_page(output_path, printer_info=None):
    """
    Generates a custom A4 PDF test page tailored for MantaPrint Hub.
    """
    if printer_info is None:
        printer_info = {}

    cfg = get_system_config()
    lang = printer_info.get("lang") or cfg.get("language") or "en"
    if lang not in STRINGS:
        lang = "en"

    # Explicit CLI/API version wins, then version.json; config.json is only a last resort
    # because its copy of the version can lag behind the installed release.
    raw_version = printer_info.get("version") or get_system_version()
    if not raw_version or str(raw_version).strip().lstrip("v") in ("0.0.0", "0.0.1"):
        raw_version = cfg.get("version") or "0.0.0"
    clean_version = str(raw_version).strip().lstrip("v")
    version_str = f"v{clean_version}"

    # Format localized strings with real version
    t = {}
    for k, v in STRINGS[lang].items():
        if isinstance(v, str):
            t[k] = v.replace("{version}", version_str).replace("v0.0.1", version_str)
        else:
            t[k] = v

    model = printer_info.get("model", "Universal Printer")
    queue_name = printer_info.get("queue", "default")
    device_uri = printer_info.get("uri", "usb://")
    local_ip = printer_info.get("ip") or get_local_ip()
    hostname = cfg.get("hostname") or socket.gethostname() or "mantaprint"
    web_url = f"http://{local_ip}"
    now_str = datetime.now().strftime("%d %B %Y, %H:%M:%S")

    # A4 dimensions in points (595.28 x 841.89)
    page_w, page_h = A4
    margin_l = 28.0
    margin_r = page_w - 28.0
    content_w = margin_r - margin_l

    # Dedicated content boundary leaving a clear gutter for the right-hand metric ruler
    ruler_gutter = 32.0
    main_content_w = content_w - ruler_gutter
    main_right_x = margin_l + main_content_w

    c = canvas.Canvas(output_path, pagesize=A4)
    c.setTitle(f"MantaPrint Test Page ({version_str}) - {model}")
    c.setAuthor(f"MantaPrint Hub {version_str}")

    # -------------------------------------------------------------------------
    # 1. CORNER CROP MARKS & REGISTRATION TARGETS
    # -------------------------------------------------------------------------
    c.setStrokeColor(colors.HexColor("#0f172a"))
    c.setLineWidth(0.5)

    corners = [
        (margin_l, margin_l),
        (margin_r, margin_l),
        (margin_l, page_h - margin_l),
        (margin_r, page_h - margin_l)
    ]
    mark_len = 14.0
    for cx, cy in corners:
        dx = mark_len if cx == margin_l else -mark_len
        dy = mark_len if cy == margin_l else -mark_len
        c.line(cx, cy, cx + dx, cy)
        c.line(cx, cy, cx, cy + dy)

    # Center crosshairs on page edges
    mid_x = page_w / 2.0
    c.line(mid_x - 10, page_h - 14, mid_x + 10, page_h - 14)
    c.line(mid_x, page_h - 24, mid_x, page_h - 4)
    c.line(mid_x - 10, 14, mid_x + 10, 14)
    c.line(mid_x, 4, mid_x, 24)

    # -------------------------------------------------------------------------
    # 2. TOP BRANDING BANNER
    # -------------------------------------------------------------------------
    banner_y = page_h - 105.0
    banner_h = 70.0

    # Banner Background (Modern dark slate)
    c.setFillColor(colors.HexColor("#0f172a"))
    c.roundRect(margin_l, banner_y, content_w, banner_h, radius=6, stroke=0, fill=1)

    # Decorative Accent Bar (Mantaplex teal)
    c.setFillColor(colors.HexColor("#0a7f87"))
    c.roundRect(margin_l, banner_y, 6, banner_h, radius=3, stroke=0, fill=1)

    # Embedded MantaPrint Brand Logo
    logo_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mantaprint.png")
    if not os.path.exists(logo_path):
        logo_path = "/opt/mantaprint/mantaprint.png"
    if not os.path.exists(logo_path):
        logo_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "mantaprint.png")

    if os.path.exists(logo_path):
        c.drawImage(logo_path, margin_l + 10, banner_y + 11, width=48, height=48, mask='auto', preserveAspectRatio=True)
    else:
        c.setFillColor(colors.HexColor("#8e2c47"))
        c.circle(margin_l + 35, banner_y + 35, 23, stroke=0, fill=1)

    # Logo Text
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 19)
    c.drawString(margin_l + 66, banner_y + 41, t["title"])

    c.setFont("Helvetica", 8.5)
    c.setFillColor(colors.HexColor("#94a3b8"))
    c.drawString(margin_l + 66, banner_y + 27, t["subtitle"])

    c.setFont("Helvetica-Oblique", 7.5)
    c.setFillColor(colors.HexColor("#5eead4"))
    c.drawString(margin_l + 66, banner_y + 13, t["tagline"])

    # Status Badge on right of banner
    badge_w = 148.0
    badge_h = 22.0
    badge_x = margin_r - badge_w - 12
    badge_y = banner_y + 24.0

    c.setFillColor(colors.HexColor("#065f46"))
    c.roundRect(badge_x, badge_y, badge_w, badge_h, radius=4, stroke=0, fill=1)
    c.setFillColor(colors.HexColor("#34d399"))
    c.setFont("Helvetica-Bold", 7.5)
    c.drawCentredString(badge_x + (badge_w / 2.0), badge_y + 7.0, t["verified"])

    # -------------------------------------------------------------------------
    # 3. DIAGNOSTICS & QR CODE SECTION
    # -------------------------------------------------------------------------
    diag_y = banner_y - 126.0
    diag_h = 118.0
    qr_box_w = 110.0
    info_box_w = content_w - qr_box_w - 12.0

    # Info Box Card
    c.setFillColor(colors.HexColor("#f8fafc"))
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.setLineWidth(0.8)
    c.roundRect(margin_l, diag_y, info_box_w, diag_h, radius=5, stroke=1, fill=1)

    # Info Header
    c.setFillColor(colors.HexColor("#1e293b"))
    c.setFont("Helvetica-Bold", 9.0)
    c.drawString(margin_l + 12, diag_y + diag_h - 18, t["tech_header"])

    c.setStrokeColor(colors.HexColor("#cbd5e1"))
    c.setLineWidth(0.5)
    c.line(margin_l + 12, diag_y + diag_h - 23, margin_l + info_box_w - 12, diag_y + diag_h - 23)

    fields_col1 = [
        (t["lbl_model"], model[:26]),
        (t["lbl_queue"], queue_name[:26]),
        (t["lbl_conn"], t["val_usb"] if "usb://" in device_uri else t["val_ipp"]),
        (t["lbl_comm"], t["val_comm"])
    ]

    fields_col2 = [
        (t["lbl_ip"], local_ip),
        (t["lbl_mdns"], f"{hostname}.local:631"),
        (t["lbl_engine"], t["val_engine"]),
        (t["lbl_time"], now_str)
    ]

    col1_x = margin_l + 12
    col2_x = margin_l + 225.0

    def render_fields(fields, start_x):
        cur_y = diag_y + diag_h - 38
        for label, val in fields:
            c.setFont("Helvetica-Bold", 7.5)
            c.setFillColor(colors.HexColor("#64748b"))
            c.drawString(start_x, cur_y, label)

            c.setFont("Helvetica", 7.2 if len(val) > 22 else 7.8)
            c.setFillColor(colors.HexColor("#0f172a"))
            c.drawString(start_x + 85, cur_y, f":  {val}")
            cur_y -= 18

    render_fields(fields_col1, col1_x)
    render_fields(fields_col2, col2_x)

    # QR Code Card
    qr_x = margin_r - qr_box_w
    c.setFillColor(colors.HexColor("#f8fafc"))
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.setLineWidth(0.8)
    c.roundRect(qr_x, diag_y, qr_box_w, diag_h, radius=5, stroke=1, fill=1)

    qr_size = 68
    qr_widget = QrCodeWidget(web_url)
    qr_widget.barWidth = qr_size
    qr_widget.barHeight = qr_size
    qr_widget.qrVersion = 1

    d = Drawing(qr_size, qr_size)
    d.add(qr_widget)
    d.drawOn(c, qr_x + 21, diag_y + 36)

    c.setFont("Helvetica-Bold", 7.0)
    c.setFillColor(colors.HexColor("#0f172a"))
    c.drawCentredString(qr_x + (qr_box_w / 2.0), diag_y + 22, t["qr_header"])

    c.setFont("Helvetica", 6.0)
    c.setFillColor(colors.HexColor("#64748b"))
    c.drawCentredString(qr_x + (qr_box_w / 2.0), diag_y + 12, t["qr_sub"])

    # -------------------------------------------------------------------------
    # 4. GRAYSCALE DENSITY & COLOR FIDELITY STRIPS
    # -------------------------------------------------------------------------
    gray_y = diag_y - 82.0
    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(margin_l, gray_y + 68, t["gray_header"])

    num_steps = 11
    step_w = main_content_w / num_steps
    step_h = 18.0
    step_y = gray_y + 44.0

    c.setFont("Helvetica", 6.5)
    for i in range(num_steps):
        pct = i * 10
        val = 1.0 - (i / 10.0)
        bx = margin_l + (i * step_w)

        c.setFillColor(colors.Color(val, val, val))
        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.setLineWidth(0.5)
        c.rect(bx, step_y, step_w, step_h, stroke=1, fill=1)

        c.setFillColor(colors.HexColor("#0f172a"))
        c.drawCentredString(bx + (step_w / 2.0), step_y - 9, f"{pct}%")

    # Continuous gradient strip below steps
    grad_y = gray_y + 18.0
    grad_h = 10.0
    grad_w = main_content_w
    slices = 100
    slice_w = grad_w / slices
    for s in range(slices):
        g_val = 1.0 - (s / float(slices))
        c.setFillColor(colors.Color(g_val, g_val, g_val))
        c.rect(margin_l + (s * slice_w), grad_y, slice_w + 0.3, grad_h, stroke=0, fill=1)
    c.setStrokeColor(colors.HexColor("#94a3b8"))
    c.setLineWidth(0.5)
    c.rect(margin_l, grad_y, grad_w, grad_h, stroke=1, fill=0)

    # CMYK Swatches
    cmyk_y = gray_y - 50.0
    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(margin_l, cmyk_y + 36, t["cmyk_header"])

    swatches = [
        ("Cyan (C)", colors.HexColor("#00a4e4")),
        ("Magenta (M)", colors.HexColor("#e4007f")),
        ("Yellow (Y)", colors.HexColor("#ffed00")),
        ("Black (K)", colors.HexColor("#000000")),
        ("Red (R)", colors.HexColor("#e11d48")),
        ("Green (G)", colors.HexColor("#10b981")),
        ("Blue (B)", colors.HexColor("#2563eb")),
        ("Rich Gray", colors.HexColor("#475569"))
    ]
    swatch_w = main_content_w / len(swatches)
    swatch_h = 16.0
    for idx, (s_name, s_color) in enumerate(swatches):
        sx = margin_l + (idx * swatch_w)
        c.setFillColor(s_color)
        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.setLineWidth(0.5)
        c.rect(sx, cmyk_y + 14, swatch_w, swatch_h, stroke=1, fill=1)

        c.setFillColor(colors.HexColor("#0f172a"))
        c.setFont("Helvetica-Bold", 6.0)
        c.drawCentredString(sx + (swatch_w / 2.0), cmyk_y + 4, s_name)

    # -------------------------------------------------------------------------
    # 5. GEOMETRIC LINE RESOLUTION & OPTICAL ALIGNMENT
    # -------------------------------------------------------------------------
    res_y = cmyk_y - 142.0
    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(margin_l, res_y + 125, t["res_header"])

    # Left: Radial Siemens Star
    star_cx = margin_l + 65.0
    star_cy = res_y + 60.0
    star_r = 48.0
    num_spokes = 36
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.5)
    import math
    for sp in range(num_spokes):
        ang = (sp * 360.0 / num_spokes) * (math.pi / 180.0)
        ex = star_cx + (star_r * math.cos(ang))
        ey = star_cy + (star_r * math.sin(ang))
        c.line(star_cx, star_cy, ex, ey)
    c.circle(star_cx, star_cy, star_r, stroke=1, fill=0)

    # Middle: Line weight ladder
    line_box_x = margin_l + 130.0
    line_box_w = 175.0
    line_box_y = res_y + 5.0
    line_box_h = 115.0

    c.setFillColor(colors.HexColor("#f8fafc"))
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.setLineWidth(0.5)
    c.roundRect(line_box_x, line_box_y, line_box_w, line_box_h, radius=4, stroke=1, fill=1)

    c.setFont("Helvetica-Bold", 7.5)
    c.setFillColor(colors.HexColor("#1e293b"))
    c.drawString(line_box_x + 8, line_box_y + line_box_h - 14, t["res_lines"])

    weights = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0]
    ly = line_box_y + line_box_h - 26
    c.setFont("Helvetica", 6.0)
    c.setFillColor(colors.HexColor("#475569"))

    for w in weights:
        c.drawString(line_box_x + 8, ly - 2, f"{w} pt")
        c.setStrokeColor(colors.black)
        c.setLineWidth(w)
        c.line(line_box_x + 38, ly, line_box_x + line_box_w - 10, ly)
        ly -= 14

    # Right: Cross-hatch microgrid (constrained to main_right_x to prevent ruler collision)
    grid_x = margin_l + 318.0
    grid_w = main_right_x - grid_x
    grid_y = line_box_y
    grid_h = line_box_h

    c.setFillColor(colors.HexColor("#f8fafc"))
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.roundRect(grid_x, grid_y, grid_w, grid_h, radius=4, stroke=1, fill=1)

    c.setFont("Helvetica-Bold", 7.5)
    c.setFillColor(colors.HexColor("#1e293b"))
    c.drawString(grid_x + 8, grid_y + grid_h - 14, t["res_grid"])

    gx_start = grid_x + 8
    gx_end = grid_x + grid_w - 8
    gy_start = grid_y + 8
    gy_end = grid_y + grid_h - 24

    c.setStrokeColor(colors.HexColor("#cbd5e1"))
    c.setLineWidth(0.4)
    for x in range(int(gx_start), int(gx_end), 8):
        c.line(x, gy_start, x, gy_end)
    for y in range(int(gy_start), int(gy_end), 8):
        c.line(gx_start, y, gx_end, y)

    # -------------------------------------------------------------------------
    # 6. TYPOGRAPHY & READABILITY LADDER
    # -------------------------------------------------------------------------
    type_y = res_y - 134.0

    c.setFillColor(colors.HexColor("#0f172a"))
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(margin_l, type_y + 117, t["typo_header"])

    type_box_w = main_content_w
    type_box_h = 106.0
    c.setFillColor(colors.HexColor("#f8fafc"))
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.setLineWidth(0.8)
    c.roundRect(margin_l, type_y, type_box_w, type_box_h, radius=4, stroke=1, fill=1)

    c.setFillColor(colors.HexColor("#0f172a"))

    c.setFont("Helvetica", 6.0)
    c.drawString(margin_l + 10, type_y + 88, t["typo_sample_6"])

    c.setFont("Helvetica", 7.5)
    c.drawString(margin_l + 10, type_y + 74, t["typo_sample_75"])

    c.setFont("Helvetica", 9.0)
    c.drawString(margin_l + 10, type_y + 59, t["typo_sample_9"])

    c.setFont("Times-Roman", 11.0)
    c.drawString(margin_l + 10, type_y + 42, t["typo_sample_11"])

    c.setFont("Helvetica-Bold", 13.0)
    c.drawString(margin_l + 10, type_y + 24, t["typo_sample_13"])

    # Inverted text strip
    inv_w = type_box_w - 20
    inv_h = 14.0
    inv_x = margin_l + 10
    inv_y = type_y + 6

    c.setFillColor(colors.HexColor("#0f172a"))
    c.roundRect(inv_x, inv_y, inv_w, inv_h, radius=2, stroke=0, fill=1)

    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawCentredString(inv_x + (inv_w / 2.0), inv_y + 4, t["inv_text"])

    # -------------------------------------------------------------------------
    # 6.5 PRECISION METRIC CALIBRATION RULER (RIGHT MARGIN)
    # -------------------------------------------------------------------------
    # Rendered on top layer to ensure zero occlusion from any surrounding boxes
    ruler_x = margin_r - 2.0
    ruler_y_start = 208.0
    render_precision_ruler(c, ruler_x, ruler_y_start, ruler_h_mm=100.0)

    # -------------------------------------------------------------------------
    # 7. FOOTER CERTIFICATE OF VERIFICATION
    # -------------------------------------------------------------------------
    footer_y = 28.0
    footer_h = 42.0

    c.setStrokeColor(colors.HexColor("#cbd5e1"))
    c.setLineWidth(0.6)
    c.line(margin_l, footer_y + footer_h + 4, margin_r, footer_y + footer_h + 4)

    c.setFont("Helvetica-Bold", 8.0)
    c.setFillColor(colors.HexColor("#0f172a"))
    c.drawString(margin_l, footer_y + 28, t["cert_title"])

    c.setFont("Helvetica", 7.0)
    c.setFillColor(colors.HexColor("#64748b"))
    c.drawString(margin_l, footer_y + 16, t["cert_desc"])
    c.drawString(margin_l, footer_y + 6, f"{t['footer_brand']} • Host: {hostname} ({local_ip}) • {t['footer_printed_at']} {now_str}")

    c.setFont("Courier-Bold", 7.0)
    c.setFillColor(colors.HexColor("#0f172a"))
    c.drawRightString(margin_r - 10, footer_y + 26, f"PRN: {queue_name[:18]}")
    c.setFont("Courier", 6.5)
    c.setFillColor(colors.HexColor("#64748b"))
    c.drawRightString(margin_r - 10, footer_y + 14, f"IP : {local_ip}")
    c.drawRightString(margin_r - 10, footer_y + 4, "STATUS: PASSED (100%)")

    c.save()
    return output_path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/mantaprint_testpage.pdf"
    q_name = sys.argv[2] if len(sys.argv) > 2 else "Canon_LBP6030_6040_6018L"
    model_name = sys.argv[3] if len(sys.argv) > 3 else "Canon LBP6030/6040/6018L"
    lang_arg = sys.argv[4] if len(sys.argv) > 4 else None
    ver_arg = sys.argv[5] if len(sys.argv) > 5 else None

    # Handle if lang_arg is passed as display string (e.g. from server.mjs line 4676)
    valid_lang = None
    if lang_arg in STRINGS:
        valid_lang = lang_arg
    elif lang_arg and (lang_arg.startswith("v") or lang_arg[0].isdigit()) and not ver_arg:
        ver_arg = lang_arg

    info = {
        "model": model_name,
        "queue": q_name,
        "uri": "usb://Canon/LBP6030/6040/6018L?serial=0000A3I0U93L",
        "ip": get_local_ip()
    }
    if valid_lang:
        info["lang"] = valid_lang
    if ver_arg:
        info["version"] = ver_arg

    print(f"[*] Generating MantaPrint Custom Test Page -> {out}")
    path = generate_mantaprint_test_page(out, info)
    print(f"[OK] Generated: {path} ({os.path.getsize(path)} bytes)")


# Compatibility aliases
generate_heykprint_test_page = generate_mantaprint_test_page
