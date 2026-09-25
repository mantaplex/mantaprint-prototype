#!/usr/bin/env python3
"""
Verification script for HeykPrint Python image processor fallback.
Tests all algorithms and CLI subcommands: deskew, normalize_illumination,
Sauvola thresholding, dual-layer color preservation, KTP 2-in-1, and multi-page merge.
"""

import os
import sys
import tempfile
import subprocess
import numpy as np
from PIL import Image, ImageDraw

def create_synthetic_doc(path, skew_deg=3.5):
    im = Image.new("RGB", (400, 500), (240, 238, 235))
    draw = ImageDraw.Draw(im)
    # Draw horizontal text stripes
    for y in range(40, 460, 25):
        draw.rectangle([30, y, 370, y + 6], fill=(20, 20, 20))
    # Add red stamp
    draw.ellipse([220, 200, 320, 300], fill=(215, 30, 45))
    # Add blue signature
    draw.line([50, 350, 180, 370], fill=(20, 50, 210), width=4)
    # Rotate by skew_deg
    if skew_deg != 0:
        im = im.rotate(skew_deg, resample=Image.Resampling.BILINEAR, expand=False, fillcolor=(240, 238, 235))
    im.save(path)
    return path

def create_synthetic_ktp(path, side="front"):
    # CR80 at ~150 DPI: 506 x 319
    w, h = 506, 319
    im = Image.new("RGB", (w, h), (180, 205, 225))
    draw = ImageDraw.Draw(im)
    # Text lines on left
    for y in range(40, 280, 24):
        draw.rectangle([25, y, int(w * 0.58), y + 8], fill=(30, 30, 30))
    # Photo on right (only for front)
    if side == "front":
        px0, px1 = int(w * 0.62), int(w * 0.95)
        py0, py1 = int(h * 0.18), int(h * 0.85)
        draw.rectangle([px0, py0, px1, py1], fill=(210, 145, 115))
        draw.ellipse([px0 + 20, py0 + 15, px1 - 20, py1 - 25], fill=(160, 100, 75))
    im.save(path)
    return path

def run_tests():
    with tempfile.TemporaryDirectory() as tmpdir:
        print("--- Testing image_processor.py ---")

        doc_path = os.path.join(tmpdir, "doc_skew.png")
        create_synthetic_doc(doc_path, skew_deg=3.5)

        proc_path = os.path.join(os.path.dirname(__file__), "image_processor.py")
        if os.path.exists("/opt/heykprint/image_processor.py"):
            proc_path = "/opt/heykprint/image_processor.py"

        # 1. Test CLI Deskew
        out_deskew = os.path.join(tmpdir, "out_deskew.png")
        cmd = [sys.executable, proc_path, "deskew", "-i", doc_path, "-o", out_deskew]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"Deskew failed: {res.stderr}"
        assert os.path.exists(out_deskew)
        print("✔ CLI deskew command passed")

        # 2. Test CLI Enhance Clean
        out_clean = os.path.join(tmpdir, "out_clean.png")
        cmd = [sys.executable, proc_path, "enhance", "-i", doc_path, "-o", out_clean, "--filter", "clean", "--deskew"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"Enhance clean failed: {res.stderr}"
        assert os.path.exists(out_clean)
        print("✔ CLI enhance clean with auto-deskew passed")

        # 3. Test CLI Enhance Sauvola BW
        out_sauvola = os.path.join(tmpdir, "out_sauvola.png")
        cmd = [sys.executable, proc_path, "enhance", "-i", doc_path, "-o", out_sauvola, "--filter", "sauvola"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"Enhance sauvola failed: {res.stderr}"
        assert os.path.exists(out_sauvola)
        print("✔ CLI enhance sauvola passed")

        # 4. Test CLI Enhance Dual Layer (Stamps/Signatures preserved + Sauvola text)
        out_dual = os.path.join(tmpdir, "out_dual.png")
        cmd = [sys.executable, proc_path, "enhance", "-i", doc_path, "-o", out_dual, "--filter", "dual_layer"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"Enhance dual_layer failed: {res.stderr}"
        assert os.path.exists(out_dual)
        dual_im = Image.open(out_dual)
        rgb_arr = np.array(dual_im)
        # Verify stamp area has vibrant red
        stamp_px = rgb_arr[250, 270]
        assert stamp_px[0] > 180 and stamp_px[1] < 60, f"Stamp red not preserved: {stamp_px}"
        # Verify text ink is pure black (at center column x=200)
        text_px = rgb_arr[42, 200]
        assert text_px[0] == 0 and text_px[1] == 0 and text_px[2] == 0, f"Text not pure black: {text_px}"
        print("✔ CLI enhance dual_layer color preservation passed")

        # 5. Test CLI KTP 2-in-1 (PDF and PNG outputs)
        front_path = os.path.join(tmpdir, "ktp_front.png")
        back_path = os.path.join(tmpdir, "ktp_back.png")
        create_synthetic_ktp(front_path, "front")
        create_synthetic_ktp(back_path, "back")

        out_ktp_pdf = os.path.join(tmpdir, "ktp_2in1.pdf")
        cmd = [sys.executable, proc_path, "ktp-2in1", "--front", front_path, "--back", back_path, "-o", out_ktp_pdf, "--dpi", "150"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"KTP 2-in-1 PDF failed: {res.stderr}"
        assert os.path.exists(out_ktp_pdf) and os.path.getsize(out_ktp_pdf) > 1000
        print("✔ CLI ktp-2in1 PDF synthesis passed")

        out_ktp_png = os.path.join(tmpdir, "ktp_2in1.png")
        cmd = [sys.executable, proc_path, "ktp-2in1", "--front", front_path, "--back", back_path, "-o", out_ktp_png, "--dpi", "150"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"KTP 2-in-1 PNG failed: {res.stderr}"
        assert os.path.exists(out_ktp_png)
        ktp_im = Image.open(out_ktp_png)
        # Expected A4 at 150 DPI: 1240 x 1754
        assert ktp_im.size == (1240, 1754), f"Unexpected size: {ktp_im.size}"
        print("✔ CLI ktp-2in1 PNG canvas dimensions verified (1240x1754 @ 150 DPI)")

        # 6. Test CLI Multi-page Merge (TIFF and PDF)
        p1 = os.path.join(tmpdir, "p1.png")
        p2 = os.path.join(tmpdir, "p2.png")
        create_synthetic_doc(p1, skew_deg=0)
        create_synthetic_doc(p2, skew_deg=0)

        out_tiff = os.path.join(tmpdir, "multipage.tiff")
        cmd = [sys.executable, proc_path, "merge", "-i", p1, p2, "-o", out_tiff, "--format", "tiff"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"Merge TIFF failed: {res.stderr}"
        assert os.path.exists(out_tiff)
        tiff_im = Image.open(out_tiff)
        assert getattr(tiff_im, "n_frames", 1) == 2, f"Expected 2 frames in TIFF, got {getattr(tiff_im, 'n_frames', 1)}"
        print("✔ CLI merge multi-page TIFF verified (2 frames)")

        out_pdf = os.path.join(tmpdir, "multipage.pdf")
        cmd = [sys.executable, proc_path, "merge", "-i", p1, p2, "-o", out_pdf, "--format", "pdf"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"Merge PDF failed: {res.stderr}"
        assert os.path.exists(out_pdf) and os.path.getsize(out_pdf) > 2000
        print("✔ CLI merge multi-page PDF verified")

        print("\nALL PYTHON BACKEND VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉")

if __name__ == "__main__":
    run_tests()
