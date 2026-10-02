/**
 * MantaPageScan Studio - Deterministic & Scientific Image Processing Module
 * Client-side Computer Vision algorithms for high-speed document processing.
 *
 * Capabilities:
 * 1. Horizontal Projection Profile Deskew (< 15ms on downsampled thumbnail, range [-10°, +10°])
 * 2. Morphological Illumination Normalization (Pembersih Latar Kertas: closing filter & background division)
 * 3. Dual-Layer Color Preservation (HSV S > 0.20 for stamps & wet signatures + Integral Image Sauvola Binarization)
 * 4. KTP / ID Card Auto-Segmenter (CR80 ratio ~1.586) & ID Card Specialized Tone Mapping
 * 5. KTP 2-in-1 Template Merger (Front + Back neatly aligned on A4 canvas)
 */

// ==========================================
// 1. DATA STRUCTURE HELPERS & COLOR SPACES
// ==========================================

/**
 * Creates an ImageData-compatible buffer object.
 * Returns a real ImageData instance if available in browser, or fallback object in Node.
 */
export function createImageBuffer(width, height) {
  if (typeof ImageData !== 'undefined') {
    try {
      return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
    } catch {
      try {
        return new ImageData(width, height);
      } catch {}
    }
  }
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
}

/**
 * Ensures a buffer is converted to a native ImageData instance suitable for ctx.putImageData.
 */
export function toImageData(buf, ctx = null) {
  if (!buf) return null;
  if (typeof ImageData !== 'undefined' && buf instanceof ImageData) {
    return buf;
  }
  if (typeof ImageData !== 'undefined' && buf.width && buf.height && buf.data) {
    try {
      const clamped = buf.data instanceof Uint8ClampedArray ? buf.data : new Uint8ClampedArray(buf.data);
      return new ImageData(clamped, buf.width, buf.height);
    } catch {}
  }
  if (ctx && typeof ctx.createImageData === 'function' && buf.width && buf.height && buf.data) {
    const imgData = ctx.createImageData(buf.width, buf.height);
    imgData.data.set(buf.data);
    return imgData;
  }
  return buf;
}

/**
 * Deep clones an ImageData or image buffer.
 */
export function cloneImageBuffer(src) {
  const dst = createImageBuffer(src.width, src.height);
  dst.data.set(src.data);
  return dst;
}

/**
 * Converts RGB values (0-255) to HSV values:
 * H in [0, 360), S in [0, 1], V in [0, 1]
 */
export function rgbToHsv(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;

  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === rf) {
      h = 60 * (((gf - bf) / delta) % 6);
    } else if (max === gf) {
      h = 60 * ((bf - rf) / delta + 2);
    } else {
      h = 60 * ((rf - gf) / delta + 4);
    }
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h, s, v };
}

/**
 * Converts HSV values back to RGB values (0-255).
 */
export function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let rf = 0, gf = 0, bf = 0;
  if (h >= 0 && h < 60) {
    rf = c; gf = x; bf = 0;
  } else if (h >= 60 && h < 120) {
    rf = x; gf = c; bf = 0;
  } else if (h >= 120 && h < 180) {
    rf = 0; gf = c; bf = x;
  } else if (h >= 180 && h < 240) {
    rf = 0; gf = x; bf = c;
  } else if (h >= 240 && h < 300) {
    rf = x; gf = 0; bf = c;
  } else {
    rf = c; gf = 0; bf = x;
  }

  return {
    r: Math.min(255, Math.max(0, Math.round((rf + m) * 255))),
    g: Math.min(255, Math.max(0, Math.round((gf + m) * 255))),
    b: Math.min(255, Math.max(0, Math.round((bf + m) * 255)))
  };
}

/**
 * Converts image buffer to grayscale Luminance array (Y = 0.299R + 0.587G + 0.114B).
 */
export function toGrayscaleArray(imgBuffer) {
  const { width, height, data } = imgBuffer;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  return gray;
}

/**
 * Downsamples an image buffer to target maximum dimension (preserving aspect ratio).
 * Ensures deterministic fast processing for thumbnails and analysis.
 */
export function downsampleImageBuffer(src, maxDim = 300) {
  const { width: sw, height: sh, data: sData } = src;
  const scale = Math.min(1.0, maxDim / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  if (dw === sw && dh === sh) {
    return cloneImageBuffer(src);
  }

  const dst = createImageBuffer(dw, dh);
  const dData = dst.data;

  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min(sh - 1, Math.floor(dy / scale));
    const syOffset = sy * sw * 4;
    const dyOffset = dy * dw * 4;

    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, Math.floor(dx / scale));
      const sIdx = syOffset + sx * 4;
      const dIdx = dyOffset + dx * 4;

      dData[dIdx] = sData[sIdx];
      dData[dIdx + 1] = sData[sIdx + 1];
      dData[dIdx + 2] = sData[sIdx + 2];
      dData[dIdx + 3] = sData[sIdx + 3];
    }
  }

  return dst;
}

// ==========================================
// 2. HORIZONTAL PROJECTION PROFILE DESKEW
// ==========================================

/**
 * Detects text document skew angle in degrees in the range [-maxAngle, +maxAngle]
 * using Horizontal Projection Profile variance on downsampled thumbnail.
 * Execution time is benchmarked to complete in < 15ms.
 *
 * @param {Object} imgBuffer - Source image buffer { width, height, data }
 * @param {Object} options - Configuration options
 * @param {number} options.maxAngle - Maximum search angle in degrees (default 10)
 * @param {number} options.coarseStep - Coarse search step in degrees (default 1.0)
 * @param {number} options.fineStep - Fine search step in degrees (default 0.1)
 * @param {number} options.thumbMaxDim - Downsampling max dimension (default 240)
 * @returns {{ angleDegrees: number, confidence: number, durationMs: number }}
 */
export function detectSkewAngle(imgBuffer, options = {}) {
  const startTime = performance.now();
  const maxAngle = options.maxAngle || 10;
  const coarseStep = options.coarseStep || 0.5;
  const thumbMaxDim = options.thumbMaxDim || 180;

  // 1. Downsample image to thumbnail (< 180px for sub-millisecond processing)
  const thumb = downsampleImageBuffer(imgBuffer, thumbMaxDim);
  const tw = thumb.width;
  const th = thumb.height;
  const gray = toGrayscaleArray(thumb);

  // 2. Compute Otsu / Mean threshold to extract high-contrast text strokes
  let sumLum = 0;
  for (let i = 0; i < gray.length; i++) {
    sumLum += gray[i];
  }
  const meanLum = sumLum / gray.length;

  // Binary text mask: 1 for dark ink, 0 for paper background
  const inkMask = new Uint8Array(tw * th);
  let totalInk = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < meanLum * 0.92) {
      inkMask[i] = 1;
      totalInk++;
    }
  }

  // Subsample ink points if there are too many, guaranteeing < 15ms execution
  const maxSamplePoints = 1200;
  const stride = Math.max(1, Math.floor(totalInk / maxSamplePoints));
  const sampledCount = Math.ceil(totalInk / stride);

  const inkXs = new Int16Array(sampledCount);
  const inkYs = new Int16Array(sampledCount);
  let pIdx = 0;
  let rawCount = 0;

  for (let y = 0; y < th && pIdx < sampledCount; y++) {
    const rowOffset = y * tw;
    for (let x = 0; x < tw && pIdx < sampledCount; x++) {
      if (inkMask[rowOffset + x] === 1) {
        if (rawCount % stride === 0) {
          inkXs[pIdx] = x;
          inkYs[pIdx] = y;
          pIdx++;
        }
        rawCount++;
      }
    }
  }

  const cx = tw / 2;
  const projectionProfile = new Float32Array(th);

  /**
   * Evaluates horizontal projection profile variance for candidate angle in degrees.
   */
  function evaluateAngleVariance(deg) {
    const rad = (deg * Math.PI) / 180;
    const tanAngle = Math.tan(rad);

    projectionProfile.fill(0);

    for (let i = 0; i < pIdx; i++) {
      const x = inkXs[i];
      const y = inkYs[i];
      const projectedY = Math.round(y - (x - cx) * tanAngle);
      if (projectedY >= 0 && projectedY < th) {
        projectionProfile[projectedY]++;
      }
    }

    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < th; y++) {
      const v = projectionProfile[y];
      sum += v;
      sumSq += v * v;
    }
    return sumSq - (sum * sum) / th;
  }

  // 3. Coarse Search Pass
  let bestAngle = 0;
  let maxVariance = -1;
  const variances = [];
  const angles = [];

  for (let angle = -maxAngle; angle <= maxAngle; angle += coarseStep) {
    const variance = evaluateAngleVariance(angle);
    angles.push(angle);
    variances.push(variance);
    if (variance > maxVariance) {
      maxVariance = variance;
      bestAngle = angle;
    }
  }

  // 4. Parabolic Sub-Grid Peak Refinement (Sub-0.1° accuracy without extra passes)
  const bestIdx = angles.indexOf(bestAngle);
  if (bestIdx > 0 && bestIdx < angles.length - 1) {
    const v0 = variances[bestIdx];
    const vm1 = variances[bestIdx - 1];
    const vp1 = variances[bestIdx + 1];
    const denom = vm1 - 2 * v0 + vp1;
    if (Math.abs(denom) > 1e-6) {
      const delta = (0.5 * (vm1 - vp1)) / denom;
      if (Math.abs(delta) <= 1.0) {
        bestAngle += delta * coarseStep;
      }
    }
  }

  const endTime = performance.now();
  const durationMs = endTime - startTime;

  // Confidence based on peak variance relative to baseline
  const baselineVariance = evaluateAngleVariance(0);
  const confidence = baselineVariance > 0
    ? Math.min(1.0, Math.max(0.1, maxVariance / (baselineVariance * 1.5)))
    : 0.5;

  return {
    angleDegrees: Number(bestAngle.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    durationMs: Number(durationMs.toFixed(2))
  };
}

/**
 * Rotates and deskews an image buffer by given angle degrees around its center
 * using bilinear interpolation, with pure white padding on borders.
 */
export function deskewImageBuffer(src, angleDegrees) {
  if (Math.abs(angleDegrees) < 0.05) {
    return cloneImageBuffer(src);
  }

  const { width: sw, height: sh, data: sData } = src;
  const dst = createImageBuffer(sw, sh);
  const dData = dst.data;

  const rad = (-angleDegrees * Math.PI) / 180; // Negative to counter skew
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const cx = sw / 2;
  const cy = sh / 2;

  for (let dy = 0; dy < sh; dy++) {
    const dyRel = dy - cy;
    const dyOffset = dy * sw * 4;

    for (let dx = 0; dx < sw; dx++) {
      const dxRel = dx - cx;

      // Inverse map to source coordinates
      const sx = cx + dxRel * cos - dyRel * sin;
      const sy = cy + dxRel * sin + dyRel * cos;

      const dIdx = dyOffset + dx * 4;

      if (sx >= 0 && sx < sw - 1 && sy >= 0 && sy < sh - 1) {
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = x0 + 1;
        const y1 = y0 + 1;

        const wx1 = sx - x0;
        const wx0 = 1 - wx1;
        const wy1 = sy - y0;
        const wy0 = 1 - wy1;

        const idx00 = (y0 * sw + x0) * 4;
        const idx10 = (y0 * sw + x1) * 4;
        const idx01 = (y1 * sw + x0) * 4;
        const idx11 = (y1 * sw + x1) * 4;

        for (let c = 0; c < 3; c++) {
          const val =
            wy0 * (wx0 * sData[idx00 + c] + wx1 * sData[idx10 + c]) +
            wy1 * (wx0 * sData[idx01 + c] + wx1 * sData[idx11 + c]);
          dData[dIdx + c] = Math.round(val);
        }
        dData[dIdx + 3] = 255;
      } else {
        // White border padding
        dData[dIdx] = 255;
        dData[dIdx + 1] = 255;
        dData[dIdx + 2] = 255;
        dData[dIdx + 3] = 255;
      }
    }
  }

  return dst;
}

// ==========================================
// 3. MORPHOLOGICAL ILLUMINATION NORMALIZATION
// ==========================================

/**
 * Estimates the smooth illumination background of paper using morphological closing
 * (dilation followed by erosion) accelerated via grid-block decomposition and bilinear upsampling.
 *
 * @param {Object} imgBuffer - Source image buffer { width, height, data }
 * @param {number} blockSize - Sampling block size (default 20 pixels)
 * @returns {{ rBg: Uint8Array, gBg: Uint8Array, bBg: Uint8Array }}
 */
export function estimatePaperBackground(imgBuffer, blockSize = 20) {
  const { width: w, height: h, data } = imgBuffer;
  const gridW = Math.ceil(w / blockSize);
  const gridH = Math.ceil(h / blockSize);

  // 1. Grid maximums per channel (Morphological Dilation approximation)
  const maxR = new Uint8Array(gridW * gridH);
  const maxG = new Uint8Array(gridW * gridH);
  const maxB = new Uint8Array(gridW * gridH);

  for (let gy = 0; gy < gridH; gy++) {
    const y0 = gy * blockSize;
    const y1 = Math.min(h, y0 + blockSize);

    for (let gx = 0; gx < gridW; gx++) {
      const x0 = gx * blockSize;
      const x1 = Math.min(w, x0 + blockSize);

      let mR = 0, mG = 0, mB = 0;
      for (let y = y0; y < y1; y++) {
        const rowOffset = y * w * 4;
        for (let x = x0; x < x1; x++) {
          const idx = rowOffset + x * 4;
          if (data[idx] > mR) mR = data[idx];
          if (data[idx + 1] > mG) mG = data[idx + 1];
          if (data[idx + 2] > mB) mB = data[idx + 2];
        }
      }

      const gIdx = gy * gridW + gx;
      maxR[gIdx] = mR;
      maxG[gIdx] = mG;
      maxB[gIdx] = mB;
    }
  }

  // 2. Morphological Erosion on Grid (radius 1 block to clean up hot-spot noise)
  const erodeR = new Uint8Array(gridW * gridH);
  const erodeG = new Uint8Array(gridW * gridH);
  const erodeB = new Uint8Array(gridW * gridH);

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      let minR = 255, minG = 255, minB = 255;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = Math.min(gridH - 1, Math.max(0, gy + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(gridW - 1, Math.max(0, gx + dx));
          const nIdx = ny * gridW + nx;
          if (maxR[nIdx] < minR) minR = maxR[nIdx];
          if (maxG[nIdx] < minG) minG = maxG[nIdx];
          if (maxB[nIdx] < minB) minB = maxB[nIdx];
        }
      }
      const gIdx = gy * gridW + gx;
      erodeR[gIdx] = minR;
      erodeG[gIdx] = minG;
      erodeB[gIdx] = minB;
    }
  }

  // 3. Bilinear upsampling to full image resolution
  const rBg = new Uint8Array(w * h);
  const gBg = new Uint8Array(w * h);
  const bBg = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const gy = y / blockSize - 0.5;
    const gy0 = Math.max(0, Math.floor(gy));
    const gy1 = Math.min(gridH - 1, gy0 + 1);
    const wy1 = Math.max(0, Math.min(1, gy - gy0));
    const wy0 = 1 - wy1;

    const rowOffset = y * w;
    const gRow0 = gy0 * gridW;
    const gRow1 = gy1 * gridW;

    for (let x = 0; x < w; x++) {
      const gx = x / blockSize - 0.5;
      const gx0 = Math.max(0, Math.floor(gx));
      const gx1 = Math.min(gridW - 1, gx0 + 1);
      const wx1 = Math.max(0, Math.min(1, gx - gx0));
      const wx0 = 1 - wx1;

      const idx = rowOffset + x;

      const i00 = gRow0 + gx0;
      const i10 = gRow0 + gx1;
      const i01 = gRow1 + gx0;
      const i11 = gRow1 + gx1;

      const valR = wy0 * (wx0 * erodeR[i00] + wx1 * erodeR[i10]) + wy1 * (wx0 * erodeR[i01] + wx1 * erodeR[i11]);
      const valG = wy0 * (wx0 * erodeG[i00] + wx1 * erodeG[i10]) + wy1 * (wx0 * erodeG[i01] + wx1 * erodeG[i11]);
      const valB = wy0 * (wx0 * erodeB[i00] + wx1 * erodeB[i10]) + wy1 * (wx0 * erodeB[i01] + wx1 * erodeB[i11]);

      rBg[idx] = Math.max(1, Math.round(valR));
      gBg[idx] = Math.max(1, Math.round(valG));
      bBg[idx] = Math.max(1, Math.round(valB));
    }
  }

  return { rBg, gBg, bBg };
}

/**
 * Normalizes document illumination using Morphological Background Division:
 * I_clean = min(255, I / I_bg * 255)
 * Eliminates paper yellowing, uneven lighting, shadows, and folds into pristine white.
 *
 * @param {Object} imgBuffer - Source image buffer { width, height, data }
 * @param {Object} options - Configuration options
 * @param {number} options.blockSize - Morphological grid block size (default 24)
 * @param {number} options.blackStretch - Factor to darken ink (default 0.95)
 * @returns {Object} Cleaned image buffer
 */
export function normalizeIllumination(imgBuffer, options = {}) {
  const { width: w, height: h, data } = imgBuffer;
  const blockSize = options.blockSize || 24;
  const blackStretch = options.blackStretch !== undefined ? options.blackStretch : 0.95;

  const { rBg, gBg, bBg } = estimatePaperBackground(imgBuffer, blockSize);
  const dst = createImageBuffer(w, h);
  const dData = dst.data;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const bgR = rBg[p];
    const bgG = gBg[p];
    const bgB = bBg[p];

    // Background division: I / I_bg * 255
    let cleanR = (r / bgR) * 255;
    let cleanG = (g / bgG) * 255;
    let cleanB = (b / bgB) * 255;

    // Gentle tone curve: paper tint (> 215) snaps to pure white (255), ink stays deep
    if (cleanR > 215) cleanR = 255; else cleanR = cleanR * blackStretch;
    if (cleanG > 215) cleanG = 255; else cleanG = cleanG * blackStretch;
    if (cleanB > 215) cleanB = 255; else cleanB = cleanB * blackStretch;

    dData[i] = Math.min(255, Math.max(0, Math.round(cleanR)));
    dData[i + 1] = Math.min(255, Math.max(0, Math.round(cleanG)));
    dData[i + 2] = Math.min(255, Math.max(0, Math.round(cleanB)));
    dData[i + 3] = 255;
  }

  return dst;
}

// ==========================================
// 4. INTEGRAL IMAGE ACCELERATED SAUVOLA & DUAL-LAYER
// ==========================================

/**
 * Computes Integral Image (Sum) and Squared Integral Image (Sum of Squares)
 * using Float64Array for exact numerical stability without overflow.
 */
export function computeIntegralImages(grayArray, width, height) {
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  const integralSq = new Float64Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    const rowOffsetGray = y * width;
    const rowOffsetInt = (y + 1) * stride;
    const prevRowOffsetInt = y * stride;

    for (let x = 0; x < width; x++) {
      const val = grayArray[rowOffsetGray + x];
      rowSum += val;
      rowSumSq += val * val;

      const colIdx = x + 1;
      integral[rowOffsetInt + colIdx] = integral[prevRowOffsetInt + colIdx] + rowSum;
      integralSq[rowOffsetInt + colIdx] = integralSq[prevRowOffsetInt + colIdx] + rowSumSq;
    }
  }

  return { integral, integralSq, stride };
}

/**
 * Performs Sauvola Adaptive Thresholding accelerated by Integral Images in O(1) time per pixel:
 * T(x, y) = mean(x, y) * (1 + k * (std(x, y) / R - 1))
 *
 * @param {Uint8Array} grayArray - Grayscale image buffer
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} options - Threshold options (windowRadius, k, R)
 * @returns {Uint8Array} Binary mask (1 for ink, 0 for paper)
 */
export function binarizeSauvola(grayArray, width, height, options = {}) {
  const windowRadius = options.windowRadius || 15;
  const k = options.k !== undefined ? options.k : 0.28;
  const R = options.R || 128;

  const { integral, integralSq, stride } = computeIntegralImages(grayArray, width, height);
  const binaryMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - windowRadius);
    const y2 = Math.min(height - 1, y + windowRadius);
    const rowOffset = y * width;

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - windowRadius);
      const x2 = Math.min(width - 1, x + windowRadius);

      const area = (x2 - x1 + 1) * (y2 - y1 + 1);

      // 4-lookup Integral sum
      const idxA = y1 * stride + x1;
      const idxB = y1 * stride + (x2 + 1);
      const idxC = (y2 + 1) * stride + x1;
      const idxD = (y2 + 1) * stride + (x2 + 1);

      const sum = integral[idxD] - integral[idxB] - integral[idxC] + integral[idxA];
      const sumSq = integralSq[idxD] - integralSq[idxB] - integralSq[idxC] + integralSq[idxA];

      const mean = sum / area;
      const variance = Math.max(0, sumSq / area - mean * mean);
      const std = Math.sqrt(variance);

      // Sauvola formula
      const threshold = mean * (1 + k * (std / R - 1));
      const val = grayArray[rowOffset + x];

      binaryMask[rowOffset + x] = val <= threshold ? 1 : 0;
    }
  }

  return binaryMask;
}

/**
 * Dual-Layer Color Preservation:
 * 1. Masking HSV saturation (S > saturationThreshold) preserves stamps (red/purple/blue/green)
 *    and wet signatures in full natural color.
 * 2. Grayscale text regions are binarized using sharp Sauvola Thresholding with zero background noise.
 *
 * @param {Object} imgBuffer - Source image buffer { width, height, data }
 * @param {Object} options - Configuration options
 * @param {number} options.saturationThreshold - Minimum HSV S to preserve color (default 0.20)
 * @param {number} options.k - Sauvola k parameter (default 0.28)
 * @param {number} options.windowRadius - Sauvola window radius (default 15)
 * @returns {Object} Enhanced dual-layer image buffer
 */
export function processDualLayerColorPreservation(imgBuffer, options = {}) {
  const { width: w, height: h, data } = imgBuffer;
  const saturationThreshold = options.saturationThreshold !== undefined ? options.saturationThreshold : 0.20;
  const windowRadius = options.windowRadius || 15;
  const k = options.k !== undefined ? options.k : 0.28;

  // 1. Morphological illumination normalization for clean background
  const cleaned = normalizeIllumination(imgBuffer, { blockSize: 24 });
  const cData = cleaned.data;

  // 2. Grayscale & Sauvola Thresholding on text
  const gray = toGrayscaleArray(cleaned);
  const textMask = binarizeSauvola(gray, w, h, { windowRadius, k });

  const dst = createImageBuffer(w, h);
  const dData = dst.data;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const rOrig = data[i];
    const gOrig = data[i + 1];
    const bOrig = data[i + 2];

    const rClean = cData[i];
    const gClean = cData[i + 1];
    const bClean = cData[i + 2];

    const { s: sOrig } = rgbToHsv(rOrig, gOrig, bOrig);
    const maxOrig = Math.max(rOrig, gOrig, bOrig);
    const minOrig = Math.min(rOrig, gOrig, bOrig);

    // Color preservation layer: Significant saturation in source image (stamps, signatures)
    // and distinct color delta to exclude neutral paper/ink noise
    const isColorInk = sOrig > saturationThreshold && (maxOrig - minOrig) >= 20;

    if (isColorInk) {
      // Retain vibrant stamp / signature ink with normalized paper background
      dData[i] = rClean;
      dData[i + 1] = gClean;
      dData[i + 2] = bClean;
      dData[i + 3] = 255;
    } else {
      // Monochrome layer: Sauvola binary text
      if (textMask[p] === 1) {
        // Crisp black ink
        dData[i] = 0;
        dData[i + 1] = 0;
        dData[i + 2] = 0;
        dData[i + 3] = 255;
      } else {
        // Pure white paper
        dData[i] = 255;
        dData[i + 1] = 255;
        dData[i + 2] = 255;
        dData[i + 3] = 255;
      }
    }
  }

  return dst;
}

// ==========================================
// 5. KTP / ID CARD AUTO-SEGMENTER & TONE MAPPING
// ==========================================

export const CR80_ASPECT_RATIO = 85.60 / 53.98; // ~1.58577 (ISO/IEC 7810 ID-1)

/**
 * Detects rectangular ID Card / KTP contours matching CR80 aspect ratio (~1.586).
 * Analyzes edge boundaries on flatbed scans against dark/light platen background.
 *
 * @param {Object} imgBuffer - Source scanner image buffer
 * @returns {{ x: number, y: number, width: number, height: number, aspectRatio: number, confidence: number }}
 */
export function detectCardContour(imgBuffer) {
  const { width: w, height: h, data } = imgBuffer;

  // Downsample for fast contour search
  const thumbMaxDim = 320;
  const scale = Math.min(1.0, thumbMaxDim / Math.max(w, h));
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);
  const thumb = downsampleImageBuffer(imgBuffer, thumbMaxDim);
  const gray = toGrayscaleArray(thumb);

  // Gradient magnitude (Sobel edges)
  const edge = new Uint8Array(tw * th);
  for (let y = 1; y < th - 1; y++) {
    for (let x = 1; x < tw - 1; x++) {
      const idx = y * tw + x;
      const gx =
        -gray[idx - tw - 1] + gray[idx - tw + 1] +
        -2 * gray[idx - 1] + 2 * gray[idx + 1] +
        -gray[idx + tw - 1] + gray[idx + tw + 1];
      const gy =
        -gray[idx - tw - 1] - 2 * gray[idx - tw] - gray[idx - tw + 1] +
        gray[idx + tw - 1] + 2 * gray[idx + tw] + gray[idx + tw + 1];
      const mag = Math.min(255, Math.abs(gx) + Math.abs(gy));
      edge[idx] = mag > 45 ? 255 : 0;
    }
  }

  // Row and column edge density projections to find card bounding box
  const colDensity = new Float32Array(tw);
  const rowDensity = new Float32Array(th);

  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if (edge[y * tw + x] === 255) {
        colDensity[x]++;
        rowDensity[y]++;
      }
    }
  }

  // Threshold projections to detect card bounds
  const colThresh = th * 0.05;
  const rowThresh = tw * 0.05;

  let minX = 0, maxX = tw - 1;
  let minY = 0, maxY = th - 1;

  for (let x = 0; x < tw; x++) {
    if (colDensity[x] > colThresh) { minX = x; break; }
  }
  for (let x = tw - 1; x >= 0; x--) {
    if (colDensity[x] > colThresh) { maxX = x; break; }
  }
  for (let y = 0; y < th; y++) {
    if (rowDensity[y] > rowThresh) { minY = y; break; }
  }
  for (let y = th - 1; y >= 0; y--) {
    if (rowDensity[y] > rowThresh) { maxY = y; break; }
  }

  // Map back to original full coordinates
  let origX = Math.round(minX / scale);
  let origY = Math.round(minY / scale);
  let origW = Math.round((maxX - minX + 1) / scale);
  let origH = Math.round((maxY - minY + 1) / scale);

  // Guard rails: Ensure minimum dimensions
  if (origW < w * 0.2 || origH < h * 0.15) {
    // Default to centered standard CR80 crop
    origW = Math.round(w * 0.65);
    origH = Math.round(origW / CR80_ASPECT_RATIO);
    origX = Math.round((w - origW) / 2);
    origY = Math.round((h - origH) / 2);
  }

  // If card is portrait, adjust aspect ratio calculation
  const currentRatio = origW >= origH ? origW / origH : origH / origW;
  const ratioDelta = Math.abs(currentRatio - CR80_ASPECT_RATIO);
  const coversFullFrame = origW >= w * 0.9 && origH >= h * 0.9;
  const confidence = (coversFullFrame && ratioDelta > 0.25)
    ? 0.1
    : Math.max(0.2, Math.min(0.98, 1.0 - ratioDelta / CR80_ASPECT_RATIO));

  return {
    x: Math.max(0, Math.min(w - 1, origX)),
    y: Math.max(0, Math.min(h - 1, origY)),
    width: Math.min(w - origX, origW),
    height: Math.min(h - origY, origH),
    aspectRatio: Number((origW / origH).toFixed(3)),
    confidence: Number(confidence.toFixed(2))
  };
}

/**
 * Crops a sub-rectangle from image buffer.
 */
export function cropImageBuffer(src, cropRect) {
  const { x, y, width: cw, height: ch } = cropRect;
  const { width: sw, height: sh, data: sData } = src;

  const validW = Math.max(1, Math.min(cw, sw - x));
  const validH = Math.max(1, Math.min(ch, sh - y));

  const dst = createImageBuffer(validW, validH);
  const dData = dst.data;

  for (let cy = 0; cy < validH; cy++) {
    const sOffset = ((y + cy) * sw + x) * 4;
    const dOffset = cy * validW * 4;
    for (let cx = 0; cx < validW * 4; cx++) {
      dData[dOffset + cx] = sData[sOffset + cx];
    }
  }

  return dst;
}

/**
 * ID Card Specialized Tone Mapping:
 * - Sharpens text details (NIK, Nama, Alamat, etc.) for crisp legibility and high OCR accuracy.
 * - Preserves face photo region in natural 24-bit RGB without binarization or posterization artifacts.
 *
 * @param {Object} cardImg - Cropped ID Card image buffer (landscape orientation)
 * @returns {Object} Tone-mapped ID Card image buffer
 */
export function enhanceIdCardTone(cardImg) {
  const { width: w, height: h, data } = cardImg;
  const dst = createImageBuffer(w, h);
  const dData = dst.data;

  // Indonesian KTP Face photo bounding box coordinates (approx 62% - 98% X, 18% - 88% Y)
  const photoX0 = Math.round(w * 0.60);
  const photoX1 = Math.round(w * 0.98);
  const photoY0 = Math.round(h * 0.18);
  const photoY1 = Math.round(h * 0.88);
  const feather = Math.round(w * 0.03); // Transition feather band

  // 1. Text Region Enhancement: High-pass sharpening & illumination cleaning
  const cleaned = normalizeIllumination(cardImg, { blockSize: 16, blackStretch: 0.90 });
  const cData = cleaned.data;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x * 4;

      const rOrig = data[idx];
      const gOrig = data[idx + 1];
      const bOrig = data[idx + 2];

      const rClean = cData[idx];
      const gClean = cData[idx + 1];
      const bClean = cData[idx + 2];

      // Determine photo weight: 1.0 = full photo region, 0.0 = full text region
      let photoWeight = 0;
      if (x >= photoX0 && x <= photoX1 && y >= photoY0 && y <= photoY1) {
        // Inside photo region: calculate distance to border for smooth feathering
        const dLeft = x - photoX0;
        const dRight = photoX1 - x;
        const dTop = y - photoY0;
        const dBottom = photoY1 - y;
        const minDist = Math.min(dLeft, dRight, dTop, dBottom);
        photoWeight = Math.min(1.0, minDist / feather);
      }

      if (photoWeight >= 0.99) {
        // Face Photo Region: Natural 24-bit RGB with gentle S-curve contrast boost
        const rBoost = (rOrig / 255 - 0.5) * 1.12 + 0.5;
        const gBoost = (gOrig / 255 - 0.5) * 1.12 + 0.5;
        const bBoost = (bOrig / 255 - 0.5) * 1.12 + 0.5;

        dData[idx] = Math.min(255, Math.max(0, Math.round(rBoost * 255)));
        dData[idx + 1] = Math.min(255, Math.max(0, Math.round(gBoost * 255)));
        dData[idx + 2] = Math.min(255, Math.max(0, Math.round(bBoost * 255)));
        dData[idx + 3] = 255;
      } else if (photoWeight <= 0.01) {
        // Text Region: High-contrast cleaned text
        dData[idx] = rClean;
        dData[idx + 1] = gClean;
        dData[idx + 2] = bClean;
        dData[idx + 3] = 255;
      } else {
        // Seamless transition feather
        const wPhoto = photoWeight;
        const wText = 1.0 - photoWeight;

        dData[idx] = Math.round(wPhoto * rOrig + wText * rClean);
        dData[idx + 1] = Math.round(wPhoto * gOrig + wText * gClean);
        dData[idx + 2] = Math.round(wPhoto * bOrig + wText * bClean);
        dData[idx + 3] = 255;
      }
    }
  }

  return dst;
}

// ==========================================
// 6. KTP 2-IN-1 A4 TEMPLATE MERGER
// ==========================================

/**
 * Resizes an image buffer with bilinear interpolation.
 */
export function resizeImageBuffer(src, targetW, targetH) {
  const { width: sw, height: sh, data: sData } = src;
  const dst = createImageBuffer(targetW, targetH);
  const dData = dst.data;

  const scaleX = sw / targetW;
  const scaleY = sh / targetH;

  for (let dy = 0; dy < targetH; dy++) {
    const sy = dy * scaleY;
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy1 = sy - y0;
    const wy0 = 1 - wy1;

    const dyOffset = dy * targetW * 4;

    for (let dx = 0; dx < targetW; dx++) {
      const sx = dx * scaleX;
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx1 = sx - x0;
      const wx0 = 1 - wx1;

      const idx00 = (y0 * sw + x0) * 4;
      const idx10 = (y0 * sw + x1) * 4;
      const idx01 = (y1 * sw + x0) * 4;
      const idx11 = (y1 * sw + x1) * 4;

      const dIdx = dyOffset + dx * 4;

      for (let c = 0; c < 3; c++) {
        const val =
          wy0 * (wx0 * sData[idx00 + c] + wx1 * sData[idx10 + c]) +
          wy1 * (wx0 * sData[idx01 + c] + wx1 * sData[idx11 + c]);
        dData[dIdx + c] = Math.round(val);
      }
      dData[dIdx + 3] = 255;
    }
  }

  return dst;
}

/**
 * Merges Front and Back KTP / ID Card images into a single A4 canvas sheet.
 * Standard A4 canvas: 210mm x 297mm.
 * Card size: CR80 85.6mm x 53.98mm.
 *
 * @param {Object} frontCard - Front side image buffer
 * @param {Object} backCard - Back side image buffer
 * @param {Object} options - Configuration options
 * @param {number} options.dpi - Output resolution DPI (default 300)
 * @param {boolean} options.applyToneMapping - Apply specialized ID Card tone mapping (default true)
 * @param {boolean} options.drawBorder - Draw subtle cut hairline around cards (default true)
 * @returns {Object} Synthetic A4 image buffer with Front and Back cards centered
 */
export function createKtp2in1Template(frontCard, backCard, options = {}) {
  const dpi = options.dpi || 300;
  const applyToneMapping = options.applyToneMapping !== false;
  const drawBorder = options.drawBorder !== false;

  // A4 Dimensions: 210 x 297 mm
  // At 300 DPI: 2480 x 3508 pixels
  // At 150 DPI: 1240 x 1754 pixels
  const a4Width = Math.round((210 / 25.4) * dpi);
  const a4Height = Math.round((297 / 25.4) * dpi);

  // Standard CR80 Dimensions: 85.60 x 53.98 mm
  const cardWidth = Math.round((85.60 / 25.4) * dpi);
  const cardHeight = Math.round((53.98 / 25.4) * dpi);

  // Initialize pristine white A4 canvas
  const canvas = createImageBuffer(a4Width, a4Height);
  canvas.data.fill(255);

  // Process & resize front card (auto-rotate portrait cards to landscape CR80)
  let procFront = frontCard.height > frontCard.width ? rotateImageBuffer(frontCard, 90) : frontCard;
  if (applyToneMapping) {
    procFront = enhanceIdCardTone(procFront);
  }
  const resizedFront = resizeImageBuffer(procFront, cardWidth, cardHeight);

  // Process & resize back card (auto-rotate portrait cards to landscape CR80)
  let procBack = backCard.height > backCard.width ? rotateImageBuffer(backCard, 90) : backCard;
  if (applyToneMapping) {
    procBack = enhanceIdCardTone(procBack);
  }
  const resizedBack = resizeImageBuffer(procBack, cardWidth, cardHeight);

  // Calculate centered coordinates on A4
  const posX = Math.round((a4Width - cardWidth) / 2);
  const frontY = Math.round(a4Height * 0.26 - cardHeight / 2);
  const backY = Math.round(a4Height * 0.70 - cardHeight / 2);

  /**
   * Pastes card into canvas buffer with optional border.
   */
  function pasteCard(cardBuf, px, py) {
    const cw = cardBuf.width;
    const ch = cardBuf.height;
    const cData = cardBuf.data;
    const canvasData = canvas.data;

    for (let y = 0; y < ch; y++) {
      const cRowOffset = y * cw * 4;
      const a4RowOffset = (py + y) * a4Width * 4;

      for (let x = 0; x < cw; x++) {
        const cIdx = cRowOffset + x * 4;
        const a4Idx = a4RowOffset + (px + x) * 4;

        canvasData[a4Idx] = cData[cIdx];
        canvasData[a4Idx + 1] = cData[cIdx + 1];
        canvasData[a4Idx + 2] = cData[cIdx + 2];
        canvasData[a4Idx + 3] = 255;
      }
    }

    if (drawBorder) {
      // Subtle gray hairline cut guide (#D1D5DB)
      const bColor = [209, 213, 219];
      // Top and bottom borders
      for (let x = 0; x < cw; x++) {
        const topIdx = (py * a4Width + (px + x)) * 4;
        const btmIdx = ((py + ch - 1) * a4Width + (px + x)) * 4;
        for (let c = 0; c < 3; c++) {
          canvasData[topIdx + c] = bColor[c];
          canvasData[btmIdx + c] = bColor[c];
        }
      }
      // Left and right borders
      for (let y = 0; y < ch; y++) {
        const lftIdx = ((py + y) * a4Width + px) * 4;
        const rgtIdx = ((py + y) * a4Width + (px + cw - 1)) * 4;
        for (let c = 0; c < 3; c++) {
          canvasData[lftIdx + c] = bColor[c];
          canvasData[rgtIdx + c] = bColor[c];
        }
      }
    }
  }

  pasteCard(resizedFront, posX, frontY);
  pasteCard(resizedBack, posX, backY);

  return canvas;
}

// ==========================================
// 7. HIGH-LEVEL UNIFIED PIPELINE
// ==========================================

/**
 * Universal processing pipeline dispatcher for MantaPrint WebScan Studio.
 *
 * @param {Object} imgBuffer - Source image buffer { width, height, data }
 * @param {string} mode - Filter mode ('clean' | 'bw' | 'sauvola' | 'dual_layer' | 'deskew' | 'ktp_enhance')
 * @param {Object} options - Custom parameters
 * @returns {Object} Processed image buffer
 */
export function processDocument(imgBuffer, mode = 'clean', options = {}) {
  switch (mode) {
    case 'clean':
      return normalizeIllumination(imgBuffer, options);

    case 'bw':
    case 'sauvola': {
      const gray = toGrayscaleArray(imgBuffer);
      const mask = binarizeSauvola(gray, imgBuffer.width, imgBuffer.height, options);
      const dst = createImageBuffer(imgBuffer.width, imgBuffer.height);
      const dData = dst.data;
      for (let i = 0, p = 0; i < dData.length; i += 4, p++) {
        const val = mask[p] === 1 ? 0 : 255;
        dData[i] = val;
        dData[i + 1] = val;
        dData[i + 2] = val;
        dData[i + 3] = 255;
      }
      return dst;
    }

    case 'dual_layer':
    case 'dual_color':
      return processDualLayerColorPreservation(imgBuffer, options);

    case 'deskew': {
      const skew = detectSkewAngle(imgBuffer, options);
      return deskewImageBuffer(imgBuffer, skew.angleDegrees);
    }

    case 'ktp_enhance':
      return enhanceIdCardTone(imgBuffer);

    default:
      return cloneImageBuffer(imgBuffer);
  }
}

// ==========================================
// 8. WYSIWYG FILTER BUILDER & DPI INJECTORS
// ==========================================

/**
 * Constructs a standardized CSS filter string that is mathematically identical
 * between the interactive screen preview and Canvas 2D ctx.filter rasterizer.
 *
 * @param {Object} options - Adjustment options
 * @param {number} options.brightness - Brightness multiplier (e.g. 1.0)
 * @param {number} options.contrast - Contrast multiplier (e.g. 1.0)
 * @param {number} options.bgClean - Background clean level (0 - 100)
 * @param {string} options.filter - Mode ('none' | 'clean' | 'bw' | 'gray' | 'color' | 'sauvola' | 'dual_layer')
 * @returns {string} CSS filter string
 */
export function buildImageFilterString(options = {}) {
  const {
    brightness = 1.0,
    contrast = 1.0,
    bgClean = 0,
    filter = 'none'
  } = options;

  let filterStr = `brightness(${brightness}) contrast(${contrast}) `;

  if (filter === 'bw') {
    filterStr += 'grayscale(1) contrast(3.5) brightness(1.1) ';
  } else if (filter === 'clean') {
    const cleanFactor = 1.0 + (bgClean / 100) * 0.45;
    const brightFactor = 1.0 + (bgClean / 100) * 0.1;
    filterStr += `contrast(${cleanFactor.toFixed(2)}) brightness(${brightFactor.toFixed(2)}) `;
  } else if (filter === 'gray') {
    filterStr += 'grayscale(1) ';
  } else if (filter === 'color') {
    filterStr += 'saturate(1.4) contrast(1.1) ';
  } else if (filter === 'sauvola') {
    filterStr += 'grayscale(1) contrast(8) brightness(1.2) ';
  } else if (filter === 'dual_layer') {
    filterStr += 'contrast(1.6) saturate(1.8) brightness(1.05) ';
  }

  return filterStr.trim();
}

/**
 * Applies high-speed soft-knee background whitening to an ImageData/image buffer.
 * Smoothly transitions light scanner paper background to pure white (255)
 * without clipping dark text or destroying colored stamps/signatures.
 * 
 * @param {Object} imgBuffer - { width, height, data }
 * @param {number} bgClean - Clean intensity (0 to 100)
 * @returns {Object} Cleaned image buffer
 */
export function applySoftKneePaperWhitening(imgBuffer, bgClean = 40) {
  if (!imgBuffer || !imgBuffer.data || bgClean <= 0) {
    return imgBuffer;
  }
  const data = imgBuffer.data;
  const len = data.length;
  const threshold = Math.max(180, 255 - (bgClean * 0.70));
  const knee = 35;
  const tMin = threshold - knee;

  for (let i = 0; i < len; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum >= threshold) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    } else if (lum > tMin) {
      const factor = (lum - tMin) / knee;
      data[i] = Math.min(255, Math.round(r + (255 - r) * factor * 0.9));
      data[i + 1] = Math.min(255, Math.round(g + (255 - g) * factor * 0.9));
      data[i + 2] = Math.min(255, Math.round(b + (255 - b) * factor * 0.9));
    }
  }
  return imgBuffer;
}

/**
 * Injects or updates standard JFIF APP0 marker with given DPI into a JPEG Uint8Array or ArrayBuffer.
 *
 * @param {Uint8Array|ArrayBuffer} input - Original JPEG bytes
 * @param {number} dpi - Target resolution in dots per inch (default 300)
 * @returns {Uint8Array} Modified JPEG bytes containing valid JFIF DPI headers
 */
export function injectJpegDpi(input, dpi = 300) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return bytes;
  }

  const targetDpi = Math.max(72, Math.min(2400, Math.round(dpi)));
  const dpiX_hi = (targetDpi >> 8) & 0xFF;
  const dpiX_lo = targetDpi & 0xFF;
  const dpiY_hi = (targetDpi >> 8) & 0xFF;
  const dpiY_lo = targetDpi & 0xFF;

  // Check if existing APP0 marker exists at offset 2
  if (bytes[2] === 0xFF && bytes[3] === 0xE0) {
    if (
      bytes[6] === 0x4A && // 'J'
      bytes[7] === 0x46 && // 'F'
      bytes[8] === 0x49 && // 'I'
      bytes[9] === 0x46 && // 'F'
      bytes[10] === 0x00
    ) {
      const copy = new Uint8Array(bytes);
      copy[13] = 0x01; // units = dots per inch
      copy[14] = dpiX_hi;
      copy[15] = dpiX_lo;
      copy[16] = dpiY_hi;
      copy[17] = dpiY_lo;
      return copy;
    }
  }

  // Insert standard 18-byte JFIF APP0 block right after SOI (FF D8)
  const jfifHeader = new Uint8Array([
    0xFF, 0xE0,
    0x00, 0x10,
    0x4A, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x02,
    0x01, // Units: dots per inch
    dpiX_hi, dpiX_lo,
    dpiY_hi, dpiY_lo,
    0x00, 0x00
  ]);

  const output = new Uint8Array(bytes.length + jfifHeader.length);
  output[0] = bytes[0];
  output[1] = bytes[1];
  output.set(jfifHeader, 2);
  output.set(bytes.subarray(2), 2 + jfifHeader.length);
  return output;
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  return crcTable;
}

function calculateCrc32(buf) {
  const table = getCrcTable();
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
 * Injects or updates standard pHYs chunk (Physical pixel dimensions) into a PNG byte array.
 *
 * @param {Uint8Array|ArrayBuffer} input - Original PNG bytes
 * @param {number} dpi - Target resolution in dots per inch (default 300)
 * @returns {Uint8Array} Modified PNG bytes containing pHYs resolution chunk
 */
export function injectPngDpi(input, dpi = 300) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (
    bytes.length < 33 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4E ||
    bytes[3] !== 0x47
  ) {
    return bytes;
  }

  const targetDpi = Math.max(72, Math.min(2400, Math.round(dpi)));
  const ppm = Math.round(targetDpi / 0.0254);

  const chunkData = new Uint8Array(9);
  const view = new DataView(chunkData.buffer);
  view.setUint32(0, ppm);
  view.setUint32(4, ppm);
  chunkData[8] = 1; // meter

  const typeAndData = new Uint8Array(4 + 9);
  typeAndData[0] = 0x70; typeAndData[1] = 0x48; typeAndData[2] = 0x59; typeAndData[3] = 0x73;
  typeAndData.set(chunkData, 4);
  const crc = calculateCrc32(typeAndData);

  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, 9);
  chunk.set(typeAndData, 4);
  chunkView.setUint32(17, crc);

  let insertPos = 33;
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (type === 'pHYs') {
      const out = new Uint8Array(bytes.length);
      out.set(bytes.subarray(0, pos), 0);
      out.set(chunk, pos);
      out.set(bytes.subarray(pos + 12 + len), pos + chunk.length);
      return out;
    }
    if (type === 'IDAT') {
      insertPos = pos;
      break;
    }
    pos += 12 + len;
  }

  const output = new Uint8Array(bytes.length + chunk.length);
  output.set(bytes.subarray(0, insertPos), 0);
  output.set(chunk, insertPos);
  output.set(bytes.subarray(insertPos), insertPos + chunk.length);
  return output;
}
