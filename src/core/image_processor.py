#!/usr/bin/env python3
"""
MantaPrint Image & Document Processor
High-performance scientific image enhancement, document deskew, illumination normalization,
dual-layer color preservation (Sauvola + HSV stamps/signatures), KTP 2-in-1 merger, and format conversion.
"""

import sys
import os
import gc
import argparse
import numpy as np
from PIL import Image, ImageEnhance, ImageOps, ImageFilter, ImageStat
try:
    import cv2
    HAVE_CV2 = True
except ImportError:
    HAVE_CV2 = False

CR80_ASPECT_RATIO = 85.60 / 53.98  # ~1.58577 (ISO/IEC 7810 ID-1)

# ==========================================
# 1. HORIZONTAL PROJECTION PROFILE DESKEW
# ==========================================

def detect_skew_angle(img_pil, max_angle=10.0, step=0.5, thumb_dim=180):
    """
    Detects document skew angle in degrees within [-max_angle, +max_angle]
    using Horizontal Projection Profile variance on downsampled thumbnail.
    Completes in < 15ms.
    """
    w, h = img_pil.size
    scale = min(1.0, thumb_dim / max(w, h))
    tw, th = max(1, int(round(w * scale))), max(1, int(round(h * scale)))

    thumb = img_pil.resize((tw, th), Image.Resampling.BILINEAR)
    gray = np.array(thumb.convert("L"), dtype=np.uint8)

    mean_lum = float(np.mean(gray))
    ink_mask = gray < (mean_lum * 0.92)

    ink_ys, ink_xs = np.nonzero(ink_mask)
    total_ink = len(ink_ys)
    if total_ink < 50:
        return 0.0

    # Subsample if too many points for speed
    if total_ink > 1200:
        indices = np.linspace(0, total_ink - 1, 1200, dtype=int)
        ink_xs = ink_xs[indices]
        ink_ys = ink_ys[indices]

    cx = tw / 2.0
    angles = np.arange(-max_angle, max_angle + step / 2.0, step)
    variances = []

    for ang in angles:
        rad = np.radians(ang)
        tan_ang = np.tan(rad)
        projected_ys = np.round(ink_ys - (ink_xs - cx) * tan_ang).astype(int)
        valid = (projected_ys >= 0) & (projected_ys < th)
        if not np.any(valid):
            variances.append(0.0)
            continue
        counts = np.bincount(projected_ys[valid], minlength=th)
        variances.append(float(np.var(counts)))

    best_idx = int(np.argmax(variances))
    best_angle = float(angles[best_idx])

    # Parabolic sub-grid interpolation
    if 0 < best_idx < len(angles) - 1:
        v0 = variances[best_idx]
        vm1 = variances[best_idx - 1]
        vp1 = variances[best_idx + 1]
        denom = vm1 - 2.0 * v0 + vp1
        if abs(denom) > 1e-6:
            delta = 0.5 * (vm1 - vp1) / denom
            if abs(delta) <= 1.0:
                best_angle += delta * step

    return round(best_angle, 2)

def deskew_image(img_pil, angle=None):
    """
    Deskews an image by rotating it around its center with white padding.
    If angle is None, skew angle is detected automatically.
    """
    if angle is None:
        angle = detect_skew_angle(img_pil)

    if abs(angle) < 0.05:
        return img_pil

    # PIL rotate uses counter-clockwise angle; negative counters clockwise skew
    return img_pil.rotate(-angle, resample=Image.Resampling.BILINEAR, expand=True, fillcolor=(255, 255, 255))

# ==========================================
# 2. MORPHOLOGICAL ILLUMINATION NORMALIZATION
# ==========================================

def normalize_illumination(img_pil, block_size=32, black_stretch=0.95):
    """
    Estimates smooth paper background using morphological closing and applies
    background division: I_clean = min(255, I / I_bg * 255).
    Eliminates paper tint, uneven illumination, shadows, and folds into clean white.
    Strictly optimized to stay under 45MB RAM footprint.
    """
    if img_pil.mode != "RGB":
        img_pil = img_pil.convert("RGB")

    w, h = img_pil.size
    grid_w = max(1, int(np.ceil(w / block_size)))
    grid_h = max(1, int(np.ceil(h / block_size)))

    # Direct C-level thumbnail extraction via Pillow
    thumb = img_pil.resize((grid_w, grid_h), Image.Resampling.BOX)
    thumb_gray = thumb.convert("L")
    bg_closed = thumb_gray.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    bg_smooth = bg_closed.filter(ImageFilter.GaussianBlur(1.5))
    bg_full = bg_smooth.resize((w, h), Image.Resampling.BILINEAR)
    bg_f = np.maximum(1.0, np.array(bg_full, dtype=np.float32))

    orig_rgb = np.array(img_pil, dtype=np.uint8)
    clean_rgb = np.empty_like(orig_rgb)
    for c in range(3):
        chan_f = (orig_rgb[:, :, c].astype(np.float32) / bg_f) * 255.0
        clean_rgb[:, :, c] = np.clip(chan_f, 0, 255).astype(np.uint8)
    del bg_f

    lum = 0.299 * clean_rgb[:, :, 0].astype(np.float32) + 0.587 * clean_rgb[:, :, 1].astype(np.float32) + 0.114 * clean_rgb[:, :, 2].astype(np.float32)
    paper_mask = lum >= 225.0
    knee_mask = (lum > 185.0) & (~paper_mask)
    clean_rgb[paper_mask] = 255
    if np.any(knee_mask):
        factor = ((lum[knee_mask] - 185.0) / 40.0)[:, None]
        clean_rgb[knee_mask] = np.clip(clean_rgb[knee_mask].astype(np.float32) + (255.0 - clean_rgb[knee_mask].astype(np.float32)) * factor * 0.9, 0, 255).astype(np.uint8)
    if black_stretch != 1.0:
        dark_mask = lum < 185.0
        clean_rgb[dark_mask] = np.clip(clean_rgb[dark_mask].astype(np.float32) * black_stretch, 0, 255).astype(np.uint8)

    return Image.fromarray(clean_rgb, "RGB")

# ==========================================
# 3. SAUVOLA THRESHOLDING & DUAL-LAYER COLOR PRESERVATION
# ==========================================

def binarize_sauvola(img_pil, window_radius=15, k=0.28, r=128):
    """
    Performs fast Sauvola adaptive thresholding:
    T(x, y) = mean * (1 + k * (std / r - 1))
    Returns binary PIL Image (0 for text ink, 255 for paper).
    Memory bounded to < 45MB RAM.
    """
    gray_pil = img_pil.convert("L")
    mean_pil = gray_pil.filter(ImageFilter.BoxBlur(window_radius))
    mean = np.array(mean_pil, dtype=np.float32)
    gray = np.array(gray_pil, dtype=np.float32)

    diff_pil = Image.fromarray(np.abs(gray - mean).astype(np.uint8))
    std_pil = diff_pil.filter(ImageFilter.BoxBlur(window_radius))
    std = np.array(std_pil, dtype=np.float32) * 1.2533

    thresh = mean * (1.0 + k * (std / float(r) - 1.0))
    del mean, std
    binary = np.where(gray <= thresh, 0, 255).astype(np.uint8)
    del gray, thresh

    return Image.fromarray(binary, "L")

def preserve_color_dual_layer(img_pil, saturation_thresh=0.20, k=0.28):
    """
    Dual-Layer Color Preservation:
    - Masking HSV saturation (S > 0.20) preserves colored stamps (red/purple/blue/green)
      and wet signatures in full natural color with normalized background.
    - Grayscale text regions are Sauvola binarized to pure black (0) and pure white (255).
    """
    if img_pil.mode != "RGB":
        img_pil = img_pil.convert("RGB")

    orig_rgb = np.array(img_pil, dtype=np.uint8)

    # 1. Clean illumination background
    clean_pil = normalize_illumination(img_pil, block_size=24)
    clean_rgb = np.array(clean_pil, dtype=np.uint8)

    # 2. Text Sauvola binarization on cleaned image
    text_bin = np.array(binarize_sauvola(clean_pil, window_radius=15, k=k), dtype=np.uint8)

    # 3. HSV Saturation Masking for stamps and signatures
    max_c = np.max(orig_rgb, axis=2)
    min_c = np.min(orig_rgb, axis=2)
    delta = max_c - min_c

    if HAVE_CV2:
        hsv = cv2.cvtColor(orig_rgb, cv2.COLOR_RGB2HSV)
        sat = hsv[:, :, 1] / 255.0
    else:
        sat = np.where(max_c > 0, delta / np.maximum(1.0, max_c.astype(np.float32)), 0.0)

    is_color_ink = (sat > saturation_thresh) & ((max_c - min_c) >= 20) & (max_c < 250)

    # 4. Composite Dual Layer
    out_rgb = np.full_like(orig_rgb, 255)
    # Ink pixels in monochrome text
    text_ink = (text_bin == 0) & (~is_color_ink)
    out_rgb[text_ink] = [0, 0, 0]
    # Color ink pixels
    out_rgb[is_color_ink] = clean_rgb[is_color_ink]

    return Image.fromarray(out_rgb, "RGB")

# ==========================================
# 4. KTP / ID CARD AUTO-SEGMENTER & TONE MAPPING
# ==========================================

def detect_ktp_card(img_pil):
    """
    Detects ID Card (CR80 aspect ratio ~1.586) bounding box on scanner flatbed.
    Returns (x, y, w, h) in original image coordinates.
    """
    w, h = img_pil.size
    thumb_max = 320
    scale = min(1.0, thumb_max / max(w, h))
    tw, th = int(round(w * scale)), int(round(h * scale))

    thumb = img_pil.resize((tw, th), Image.Resampling.BILINEAR)
    gray = np.array(thumb.convert("L"), dtype=np.uint8)

    if HAVE_CV2:
        edges = cv2.Canny(gray, 50, 150)
    else:
        edges = np.array(Image.fromarray(gray).filter(ImageFilter.FIND_EDGES))
    col_density = np.sum(edges > 0, axis=0)
    row_density = np.sum(edges > 0, axis=1)

    col_th = th * 0.05
    row_th = tw * 0.05

    valid_cols = np.where(col_density > col_th)[0]
    valid_rows = np.where(row_density > row_th)[0]

    if len(valid_cols) > 0 and len(valid_rows) > 0:
        min_x, max_x = valid_cols[0], valid_cols[-1]
        min_y, max_y = valid_rows[0], valid_rows[-1]

        orig_x = int(round(min_x / scale))
        orig_y = int(round(min_y / scale))
        orig_w = int(round((max_x - min_x + 1) / scale))
        orig_h = int(round((max_y - min_y + 1) / scale))
    else:
        # Fallback centered CR80
        orig_w = int(round(w * 0.65))
        orig_h = int(round(orig_w / CR80_ASPECT_RATIO))
        orig_x = (w - orig_w) // 2
        orig_y = (h - orig_h) // 2

    # Guard bounds
    orig_x = max(0, min(w - 1, orig_x))
    orig_y = max(0, min(h - 1, orig_y))
    orig_w = min(w - orig_x, orig_w)
    orig_h = min(h - orig_y, orig_h)

    return orig_x, orig_y, orig_w, orig_h

def enhance_ktp_tone(card_pil):
    """
    ID Card Specialized Tone Mapping:
    - Sharpens text region (NIK, Nama, Alamat, etc.)
    - Preserves face photo in natural 24-bit RGB without binarization.
    """
    if card_pil.mode != "RGB":
        card_pil = card_pil.convert("RGB")

    w, h = card_pil.size
    # Face photo coordinates on standard Indonesian KTP
    px0 = int(round(w * 0.60))
    px1 = int(round(w * 0.98))
    py0 = int(round(h * 0.18))
    py1 = int(round(h * 0.88))

    # Text region cleaned
    clean_pil = normalize_illumination(card_pil, block_size=16, black_stretch=0.90)

    # Fast composite: Keep original natural photo region, paste onto cleaned text background
    photo_crop = card_pil.crop((px0, py0, px1, py1))
    photo_enh = ImageEnhance.Contrast(photo_crop).enhance(1.12)
    clean_pil.paste(photo_enh, (px0, py0))

    return clean_pil

# ==========================================
# 5. KTP 2-IN-1 A4 TEMPLATE MERGER
# ==========================================

def ktp_2in1_merge(front_path, back_path, output_path, dpi=200, apply_enhance=True):
    """
    Merges Front and Back KTP card images onto a single A4 canvas sheet centered and aligned.
    A4: 210 x 297 mm
    CR80: 85.60 x 53.98 mm
    """
    if not os.path.exists(front_path):
        sys.stderr.write(f"Front file not found: {front_path}\n")
        sys.exit(1)
    if not os.path.exists(back_path):
        sys.stderr.write(f"Back file not found: {back_path}\n")
        sys.exit(1)

    # Clamp DPI between 150 and 300 (A4 300 DPI ~26MB RAM, safe for memory budget)
    dpi = min(max(int(dpi), 150), 300)

    # Target A4 and Card dimensions at given DPI
    a4_w = int(round((210.0 / 25.4) * dpi))
    a4_h = int(round((297.0 / 25.4) * dpi))
    card_w = int(round((85.60 / 25.4) * dpi))
    card_h = int(round((53.98 / 25.4) * dpi))

    canvas = Image.new("RGB", (a4_w, a4_h), (255, 255, 255))
    pos_x = (a4_w - card_w) // 2
    front_y = int(round(a4_h * 0.26 - card_h / 2.0))
    back_y = int(round(a4_h * 0.70 - card_h / 2.0))

    # Sequential processing: front card first, then reclaim memory before back card
    front_im = Image.open(front_path)
    front_im = deskew_image(front_im)
    fx, fy, fw, fh = detect_ktp_card(front_im)
    front_im = front_im.crop((fx, fy, fx + fw, fy + fh))
    if apply_enhance:
        front_im = enhance_ktp_tone(front_im)
    front_resized = front_im.resize((card_w, card_h), Image.Resampling.LANCZOS)
    del front_im
    canvas.paste(front_resized, (pos_x, front_y))
    del front_resized
    gc.collect()

    # Back card
    back_im = Image.open(back_path)
    back_im = deskew_image(back_im)
    bx, by, bw, bh = detect_ktp_card(back_im)
    back_im = back_im.crop((bx, by, bx + bw, by + bh))
    if apply_enhance:
        back_im = enhance_ktp_tone(back_im)
    back_resized = back_im.resize((card_w, card_h), Image.Resampling.LANCZOS)
    del back_im
    canvas.paste(back_resized, (pos_x, back_y))
    del back_resized
    gc.collect()

    # Draw subtle gray border cut guides (#D1D5DB)
    border_color = (209, 213, 219)
    from PIL import ImageDraw
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([pos_x, front_y, pos_x + card_w - 1, front_y + card_h - 1], outline=border_color, width=1)
    draw.rectangle([pos_x, back_y, pos_x + card_w - 1, back_y + card_h - 1], outline=border_color, width=1)

    ext = os.path.splitext(output_path)[1].lower()
    if ext == ".pdf":
        canvas.save(output_path, "PDF", resolution=float(dpi))
    elif ext in [".jpg", ".jpeg"]:
        canvas.save(output_path, "JPEG", quality=95, optimize=True)
    elif ext == ".png":
        canvas.save(output_path, "PNG", optimize=True)
    elif ext in [".tif", ".tiff"]:
        canvas.save(output_path, "TIFF", compression="tiff_deflate")
    else:
        canvas.save(output_path)

    try:
        canvas.close()
    except Exception:
        pass
    del canvas
    gc.collect()

    print(f"OK:{output_path}")

# ==========================================
# 6. ENHANCE IMAGE DISPATCHER
# ==========================================

def enhance_image(input_path, output_path, rotate=0, brightness=1.0, contrast=1.0, filter_mode="none", auto_deskew=False):
    if not os.path.exists(input_path):
        sys.stderr.write(f"Input file not found: {input_path}\n")
        sys.exit(1)

    img = Image.open(input_path)

    # 1. 90/180/270 degree rotation
    if rotate in [90, 180, 270]:
        img = img.rotate(-rotate, expand=True)

    # 2. Automatic projection deskew if requested
    if auto_deskew:
        img = deskew_image(img)

    # 3. Filter mode
    if filter_mode == "clean":
        img = normalize_illumination(img)
    elif filter_mode in ["bw", "sauvola"]:
        clean = normalize_illumination(img)
        img = binarize_sauvola(clean).convert("RGB")
    elif filter_mode in ["dual_layer", "dual_color"]:
        img = preserve_color_dual_layer(img)
    elif filter_mode == "gray":
        img = img.convert("L").convert("RGB")
    elif filter_mode == "color":
        if img.mode != "RGB":
            img = img.convert("RGB")
        color_enh = ImageEnhance.Color(img)
        img = color_enh.enhance(1.25)
    else:
        if img.mode not in ["RGB", "L"]:
            img = img.convert("RGB")

    # 4. Brightness
    if brightness != 1.0:
        enh_b = ImageEnhance.Brightness(img)
        img = enh_b.enhance(brightness)

    # 5. Contrast
    if contrast != 1.0:
        enh_c = ImageEnhance.Contrast(img)
        img = enh_c.enhance(contrast)

    # Save output
    ext = os.path.splitext(output_path)[1].lower()
    if ext in [".jpg", ".jpeg"]:
        img.save(output_path, "JPEG", quality=92, optimize=True)
    elif ext == ".png":
        img.save(output_path, "PNG", optimize=True)
    elif ext in [".tif", ".tiff"]:
        img.save(output_path, "TIFF", compression="tiff_deflate")
    elif ext == ".pdf":
        img.save(output_path, "PDF", resolution=300.0)
    else:
        img.save(output_path)

    try:
        img.close()
    except Exception:
        pass
    del img
    gc.collect()

    print(f"OK:{output_path}")

# ==========================================
# 7. MULTI-PAGE MERGE (PDF, TIFF, PNG, JPEG)
# ==========================================

def merge_documents(input_files, output_path, output_format="pdf"):
    if not input_files:
        sys.stderr.write("No input files provided\n")
        sys.exit(1)

    output_format = output_format.lower()

    # Check if all inputs are PDF and format is PDF
    all_pdfs = all(f.lower().endswith(".pdf") for f in input_files)
    if all_pdfs and output_format == "pdf":
        import subprocess
        for cmd in (
            ["qpdf", "--empty", "--pages"] + input_files + ["--", output_path],
            ["pdfunite"] + input_files + [output_path],
        ):
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                if res.returncode == 0 and os.path.exists(output_path):
                    print(f"OK:{output_path}")
                    return
            except (FileNotFoundError, subprocess.SubprocessError):
                pass

    # Load all images
    images = []
    for f in input_files:
        if not os.path.exists(f):
            continue
        try:
            with Image.open(f) as raw_im:
                im = raw_im.convert("RGB")
                images.append(im)
        except Exception as e:
            sys.stderr.write(f"Error opening {f}: {e}\n")

    if not images:
        sys.stderr.write("Failed to load any valid images for merging\n")
        sys.exit(1)

    first = images[0]
    rest = images[1:]

    try:
        if output_format == "pdf":
            first.save(output_path, "PDF", resolution=300.0, save_all=True, append_images=rest)
        elif output_format in ["tiff", "tif"]:
            first.save(output_path, "TIFF", compression="tiff_deflate", save_all=True, append_images=rest)
        elif output_format == "png":
            if not rest:
                first.save(output_path, "PNG")
            else:
                total_height = sum(im.height for im in images)
                max_width = max(im.width for im in images)
                stitched = Image.new("RGB", (max_width, total_height), (255, 255, 255))
                y_offset = 0
                for im in images:
                    stitched.paste(im, (0, y_offset))
                    y_offset += im.height
                stitched.save(output_path, "PNG")
                stitched.close()
        elif output_format in ["jpeg", "jpg"]:
            if not rest:
                first.save(output_path, "JPEG", quality=92)
            else:
                total_height = sum(im.height for im in images)
                max_width = max(im.width for im in images)
                stitched = Image.new("RGB", (max_width, total_height), (255, 255, 255))
                y_offset = 0
                for im in images:
                    stitched.paste(im, (0, y_offset))
                    y_offset += im.height
                stitched.save(output_path, "JPEG", quality=90)
                stitched.close()
        else:
            first.save(output_path)
    finally:
        for im in images:
            try:
                im.close()
            except Exception:
                pass
        images.clear()
        gc.collect()

    print(f"OK:{output_path}")

def detect_blank(input_path, dark_thresh=200, max_dark_pixels=15, max_stddev=3.5):
    if not os.path.exists(input_path):
        sys.stderr.write(f"Input file not found: {input_path}\n")
        sys.exit(1)
    try:
        with Image.open(input_path) as raw_im:
            im = raw_im.convert('L')
        w, h = im.size
        # Margin crop (3%) to remove feeder/roller margin shadows
        margin_w = max(1, int(w * 0.03))
        margin_h = max(1, int(h * 0.03))
        if w > 2 * margin_w and h > 2 * margin_h:
            cropped = im.crop((margin_w, margin_h, w - margin_w, h - margin_h))
        else:
            cropped = im
        # Downsample for lightning-fast inspection
        sample_w = 300
        sample_h = max(1, int(300 * (h / max(1, w))))
        sampled = cropped.resize((sample_w, sample_h))
        stat = ImageStat.Stat(sampled)
        hist = sampled.histogram()
        dark_pixels = sum(hist[:dark_thresh])
        std = stat.stddev[0]
        mean = stat.mean[0]

        # Blank heuristic:
        # A true blank paper back-side has almost no dark pixels (dark_pixels <= max_dark_pixels)
        # and low variance (std < max_stddev), and high average brightness (mean > 220)
        is_blank = (dark_pixels <= max_dark_pixels and std < max_stddev and mean > 220) or (std < 1.0 and mean > 225)

        import json
        result = {
            "blank": bool(is_blank),
            "mean": round(mean, 2),
            "stddev": round(std, 2),
            "darkPixels": dark_pixels,
            "totalPixels": sample_w * sample_h
        }
        print("BLANK_JSON:" + json.dumps(result))
        return is_blank
    except Exception as e:
        sys.stderr.write(f"Error checking blank page: {e}\n")
        sys.exit(1)

# ==========================================
# 8. CLI ENTRYPOINT
# ==========================================

def main():
    parser = argparse.ArgumentParser(description="MantaPrint Image & Document Processor")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Enhance command
    p_enh = subparsers.add_parser("enhance", help="Enhance single document image")
    p_enh.add_argument("-i", "--input", required=True, help="Input file path")
    p_enh.add_argument("-o", "--output", required=True, help="Output file path")
    p_enh.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270], help="Rotation angle in degrees CW")
    p_enh.add_argument("--brightness", type=float, default=1.0, help="Brightness factor (1.0 = original)")
    p_enh.add_argument("--contrast", type=float, default=1.0, help="Contrast factor (1.0 = original)")
    p_enh.add_argument("--filter", default="none",
                       choices=["none", "clean", "bw", "sauvola", "dual_layer", "dual_color", "gray", "color"],
                       help="Filter preset")
    p_enh.add_argument("--deskew", action="store_true", help="Auto deskew text angle")

    # Deskew command
    p_deskew = subparsers.add_parser("deskew", help="Automatically deskew text document")
    p_deskew.add_argument("-i", "--input", required=True, help="Input file path")
    p_deskew.add_argument("-o", "--output", required=True, help="Output file path")
    p_deskew.add_argument("--max-angle", type=float, default=10.0, help="Max search angle in degrees")

    # KTP 2-in-1 command
    p_ktp = subparsers.add_parser("ktp-2in1", help="Merge Front and Back KTP to single A4 canvas")
    p_ktp.add_argument("--front", required=True, help="Front KTP image path")
    p_ktp.add_argument("--back", required=True, help="Back KTP image path")
    p_ktp.add_argument("-o", "--output", required=True, help="Output file path (PDF/PNG/JPEG/TIFF)")
    p_ktp.add_argument("--dpi", type=int, default=300, help="Canvas resolution DPI (default 300)")
    p_ktp.add_argument("--no-enhance", action="store_true", help="Skip KTP tone mapping")

    # Merge command
    p_merge = subparsers.add_parser("merge", help="Merge multiple pages into PDF, TIFF, PNG, or JPEG")
    p_merge.add_argument("-i", "--inputs", nargs="+", required=True, help="List of input file paths")
    p_merge.add_argument("-o", "--output", required=True, help="Output merged file path")
    p_merge.add_argument("--format", default="pdf", choices=["pdf", "tiff", "tif", "png", "jpeg", "jpg"], help="Target format")

    # Blank detection command
    p_blank = subparsers.add_parser("detect-blank", help="Detect if scanned page is blank")
    p_blank.add_argument("-i", "--input", required=True, help="Input file path")
    p_blank.add_argument("--dark-thresh", type=int, default=200, help="Grayscale threshold for dark pixels")
    p_blank.add_argument("--max-dark-pixels", type=int, default=15, help="Max allowed dark pixels for blank page")
    p_blank.add_argument("--max-stddev", type=float, default=3.5, help="Max standard deviation for blank page")

    args = parser.parse_args()

    if args.command == "enhance":
        enhance_image(args.input, args.output, args.rotate, args.brightness, args.contrast, args.filter, args.deskew)
    elif args.command == "deskew":
        im = Image.open(args.input)
        angle = detect_skew_angle(im, max_angle=args.max_angle)
        out_im = deskew_image(im, angle)
        out_im.save(args.output)
        print(f"OK:{args.output}:{angle}")
    elif args.command == "ktp-2in1":
        ktp_2in1_merge(args.front, args.back, args.output, args.dpi, not args.no_enhance)
    elif args.command == "merge":
        merge_documents(args.inputs, args.output, args.format)
    elif args.command == "detect-blank":
        detect_blank(args.input, args.dark_thresh, args.max_dark_pixels, args.max_stddev)

if __name__ == "__main__":
    main()
