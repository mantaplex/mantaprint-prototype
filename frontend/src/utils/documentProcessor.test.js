/**
 * Unit Tests for MantaPageScan Studio Deterministic Image Processor
 * Verifies algorithms, scientific accuracy, and latency benchmarks (< 15ms deskew).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageBuffer,
  cloneImageBuffer,
  rgbToHsv,
  hsvToRgb,
  detectSkewAngle,
  deskewImageBuffer,
  normalizeIllumination,
  computeIntegralImages,
  binarizeSauvola,
  processDualLayerColorPreservation,
  detectCardContour,
  enhanceIdCardTone,
  createKtp2in1Template,
  processDocument,
  buildImageFilterString,
  applySoftKneePaperWhitening,
  injectJpegDpi,
  injectPngDpi,
  CR80_ASPECT_RATIO
} from './documentProcessor.js';

// Helper to draw horizontal text lines on an image buffer
function createSyntheticDocument(width, height, angleDegrees = 0) {
  const buf = createImageBuffer(width, height);
  // Fill with off-white/light gray paper (simulating scanner paper)
  buf.data.fill(240);

  // Draw simulated text lines (horizontal stripes)
  const lineSpacing = 24;
  const lineHeight = 6;
  const rad = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 30; y < height - 30; y += lineSpacing) {
    for (let dy = 0; dy < lineHeight; dy++) {
      const lineY = y + dy;
      for (let lineX = 30; lineX < width - 30; lineX++) {
        // Rotate around center
        const rx = cx + (lineX - cx) * cos - (lineY - cy) * sin;
        const ry = cy + (lineX - cx) * sin + (lineY - cy) * cos;

        const px = Math.round(rx);
        const py = Math.round(ry);

        if (px >= 0 && px < width && py >= 0 && py < height) {
          const idx = (py * width + px) * 4;
          // Dark text ink
          buf.data[idx] = 25;
          buf.data[idx + 1] = 25;
          buf.data[idx + 2] = 25;
          buf.data[idx + 3] = 255;
        }
      }
    }
  }

  return buf;
}

test('Color Space Conversions (RGB <-> HSV)', () => {
  // Pure Red: H=0, S=1, V=1
  const redHsv = rgbToHsv(255, 0, 0);
  assert.equal(redHsv.h, 0);
  assert.equal(redHsv.s, 1);
  assert.equal(redHsv.v, 1);

  // Reconvert to RGB
  const redRgb = hsvToRgb(redHsv.h, redHsv.s, redHsv.v);
  assert.equal(redRgb.r, 255);
  assert.equal(redRgb.g, 0);
  assert.equal(redRgb.b, 0);

  // Violet / Blue Stamp Ink: R=75, G=0, B=130
  const stampHsv = rgbToHsv(75, 0, 130);
  assert.ok(stampHsv.s > 0.8, 'Stamp has high saturation');
  assert.ok(stampHsv.h >= 270 && stampHsv.h <= 285, 'Stamp is in purple/violet spectrum');
});

test('Horizontal Projection Profile Deskew (< 15ms benchmark & accuracy)', () => {
  const width = 400;
  const height = 500;
  const targetSkew = 4.0; // 4 degrees skewed clockwise

  const doc = createSyntheticDocument(width, height, targetSkew);

  // Warm up JIT compiler
  for (let i = 0; i < 3; i++) {
    detectSkewAngle(doc, { maxAngle: 10, coarseStep: 1.0 });
  }

  // Run deskew detection benchmark
  const result = detectSkewAngle(doc, { maxAngle: 10, coarseStep: 0.5 });

  // Verification 1: Benchmark latency < 15ms (typical ~2-5ms warmed up)
  assert.ok(
    result.durationMs < 15.0,
    `Deskew algorithm took ${result.durationMs}ms, which must be < 15ms`
  );

  // Verification 2: Angle detection accuracy within +/- 0.5 degrees
  const angleError = Math.abs(result.angleDegrees - targetSkew);
  assert.ok(
    angleError <= 0.5,
    `Detected angle ${result.angleDegrees}° deviates by ${angleError}° from true skew ${targetSkew}°`
  );

  // Verification 3: Deskew correction applies cleanly
  const deskewed = deskewImageBuffer(doc, result.angleDegrees);
  assert.equal(deskewed.width, width);
  assert.equal(deskewed.height, height);
});

test('Morphological Illumination Normalization (Pembersih Latar Kertas)', () => {
  const width = 120;
  const height = 120;
  const buf = createImageBuffer(width, height);

  // Simulate severe gradient shadow across paper (left is dark 130, right is 230)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const paperIllum = Math.round(130 + (x / width) * 100);
      buf.data[idx] = paperIllum;
      buf.data[idx + 1] = paperIllum;
      buf.data[idx + 2] = paperIllum;
      buf.data[idx + 3] = 255;
    }
  }

  // Add dark text ink in shadowy region
  for (let y = 40; y < 45; y++) {
    for (let x = 20; x < 60; x++) {
      const idx = (y * width + x) * 4;
      buf.data[idx] = 40;
      buf.data[idx + 1] = 40;
      buf.data[idx + 2] = 40;
    }
  }

  const cleaned = normalizeIllumination(buf, { blockSize: 16 });

  // In the shadowy background without text (x=10, y=10), paper should become pure white (255)
  const bgIdx = (10 * width + 10) * 4;
  assert.ok(
    cleaned.data[bgIdx] >= 240,
    `Shadowed paper background must normalize to clean white, got ${cleaned.data[bgIdx]}`
  );

  // In the text region (x=30, y=42), ink must stay dark
  const textIdx = (42 * width + 30) * 4;
  assert.ok(
    cleaned.data[textIdx] < 100,
    `Text ink must remain dark, got ${cleaned.data[textIdx]}`
  );
});

test('Integral Image Accelerated Sauvola Binarization', () => {
  const width = 60;
  const height = 60;
  const gray = new Uint8Array(width * height);
  // Fill background with 220
  gray.fill(220);

  // Draw dark line
  for (let x = 10; x < 50; x++) {
    gray[30 * width + x] = 30;
  }

  const { integral, integralSq } = computeIntegralImages(gray, width, height);
  assert.equal(integral.length, (width + 1) * (height + 1));
  assert.equal(integralSq.length, (width + 1) * (height + 1));

  const mask = binarizeSauvola(gray, width, height, { windowRadius: 10, k: 0.28 });
  // The dark line must be classified as ink (1)
  assert.equal(mask[30 * width + 30], 1, 'Ink pixel must be 1');
  // Background must be paper (0)
  assert.equal(mask[10 * width + 10], 0, 'Paper background must be 0');
});

test('Dual-Layer Color Preservation (Stamps & Wet Signatures + Sauvola Text)', () => {
  const width = 100;
  const height = 100;
  const buf = createImageBuffer(width, height);
  // Fill with paper background
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = 235;
    buf.data[i + 1] = 230;
    buf.data[i + 2] = 220; // Slight yellow aging
    buf.data[i + 3] = 255;
  }

  // 1. Black printed text (Neutral low saturation)
  for (let x = 10; x < 40; x++) {
    const idx = (20 * width + x) * 4;
    buf.data[idx] = 20;
    buf.data[idx + 1] = 20;
    buf.data[idx + 2] = 20;
  }

  // 2. Red Official Stamp (High Saturation S > 0.6)
  for (let y = 40; y < 60; y++) {
    for (let x = 40; x < 60; x++) {
      const idx = (y * width + x) * 4;
      buf.data[idx] = 210; // High red
      buf.data[idx + 1] = 30;  // Low green
      buf.data[idx + 2] = 40;  // Low blue
    }
  }

  // 3. Blue Wet Signature (High Saturation S > 0.6)
  for (let x = 60; x < 90; x++) {
    const idx = (70 * width + x) * 4;
    buf.data[idx] = 25;
    buf.data[idx + 1] = 60;
    buf.data[idx + 2] = 210;
  }

  const result = processDualLayerColorPreservation(buf, { saturationThreshold: 0.20 });

  // Verify Black Text: Sauvola binarized to pure black (0, 0, 0)
  const textIdx = (20 * width + 25) * 4;
  assert.equal(result.data[textIdx], 0);
  assert.equal(result.data[textIdx + 1], 0);
  assert.equal(result.data[textIdx + 2], 0);

  // Verify Red Stamp: Color preserved in full RGB (R > 180, G < 60)
  const stampIdx = (50 * width + 50) * 4;
  assert.ok(result.data[stampIdx] > 180, 'Stamp red component preserved');
  assert.ok(result.data[stampIdx + 1] < 60, 'Stamp green remains low');
  const stampHsv = rgbToHsv(result.data[stampIdx], result.data[stampIdx + 1], result.data[stampIdx + 2]);
  assert.ok(stampHsv.s > 0.6, 'Stamp retains high color saturation');

  // Verify Blue Signature: Color preserved in full RGB (B > 180)
  const sigIdx = (70 * width + 75) * 4;
  assert.ok(result.data[sigIdx + 2] > 180, 'Signature blue component preserved');

  // Verify Paper Background: Converted to pure crisp white (255, 255, 255)
  const paperIdx = (5 * width + 5) * 4;
  assert.equal(result.data[paperIdx], 255);
  assert.equal(result.data[paperIdx + 1], 255);
  assert.equal(result.data[paperIdx + 2], 255);
});

test('KTP / ID Card Auto-Segmenter & CR80 Aspect Ratio Detection', () => {
  const width = 400;
  const height = 400;
  const buf = createImageBuffer(width, height);
  // Dark scanner bed (e.g. open scanner lid or dark platen)
  buf.data.fill(20);

  // Draw CR80 card in center: 85.60 x 53.98 ratio (~1.586)
  const cardW = 200;
  const cardH = Math.round(cardW / CR80_ASPECT_RATIO); // ~126
  const cardX = 100;
  const cardY = 130;

  for (let y = cardY; y < cardY + cardH; y++) {
    for (let x = cardX; x < cardX + cardW; x++) {
      const idx = (y * width + x) * 4;
      // Light blue-gray KTP card body
      buf.data[idx] = 180;
      buf.data[idx + 1] = 205;
      buf.data[idx + 2] = 225;
      buf.data[idx + 3] = 255;
    }
  }

  const contour = detectCardContour(buf);

  assert.ok(contour.width > 0 && contour.height > 0);
  const detectedRatio = contour.width / contour.height;
  const ratioDiff = Math.abs(detectedRatio - CR80_ASPECT_RATIO);
  assert.ok(
    ratioDiff < 0.25,
    `Detected card ratio ${detectedRatio} should match CR80 ~1.586 (diff: ${ratioDiff})`
  );
  assert.ok(contour.confidence > 0.6, 'High confidence on CR80 contour match');
});

test('ID Card Specialized Tone Mapping (Text Sharpened, Photo 24-bit RGB preserved)', () => {
  const cardW = 200;
  const cardH = Math.round(cardW / CR80_ASPECT_RATIO); // ~126
  const card = createImageBuffer(cardW, cardH);
  card.data.fill(210);

  // Left side: Text region (NIK)
  for (let x = 20; x < 80; x++) {
    const idx = (30 * cardW + x) * 4;
    card.data[idx] = 40;
    card.data[idx + 1] = 40;
    card.data[idx + 2] = 40;
  }

  // Right side: Face Photo region (Rich colorful skin tone RGB: R=210, G=150, B=120)
  for (let y = 30; y < 90; y++) {
    for (let x = 140; x < 185; x++) {
      const idx = (y * cardW + x) * 4;
      card.data[idx] = 210;
      card.data[idx + 1] = 150;
      card.data[idx + 2] = 120;
    }
  }

  const enhanced = enhanceIdCardTone(card);

  // 1. Text region: Cleaned and darkened
  const textIdx = (30 * cardW + 40) * 4;
  assert.ok(enhanced.data[textIdx] < 50, 'Text ink remains deep dark');

  // 2. Photo region: Retained in full 24-bit natural RGB (not monochrome or binarized!)
  const photoIdx = (60 * cardW + 160) * 4;
  assert.ok(
    enhanced.data[photoIdx] > 180 &&
    enhanced.data[photoIdx + 1] > 120 &&
    enhanced.data[photoIdx + 2] > 90,
    'Face photo region preserves multi-channel 24-bit color'
  );
});

test('KTP 2-in-1 Canvas Template (Front + Back aligned on A4 at 150 DPI & 300 DPI)', () => {
  // Test at 150 DPI for rapid unit test
  const dpi = 150;
  const cardW = Math.round((85.60 / 25.4) * dpi); // 506
  const cardH = Math.round((53.98 / 25.4) * dpi); // 319

  const front = createImageBuffer(cardW, cardH);
  // Indonesian KTP card with photo on right and text on left
  for (let y = 0; y < cardH; y++) {
    for (let x = 0; x < cardW; x++) {
      const idx = (y * cardW + x) * 4;
      if (x > cardW * 0.65) {
        // Face photo region in 24-bit RGB
        front.data[idx] = 200;
        front.data[idx + 1] = 140;
        front.data[idx + 2] = 110;
      } else {
        // Card body with text
        front.data[idx] = 180;
        front.data[idx + 1] = 205;
        front.data[idx + 2] = 225;
      }
      front.data[idx + 3] = 255;
    }
  }

  const back = cloneImageBuffer(front);

  const a4Canvas = createKtp2in1Template(front, back, { dpi, drawBorder: true });

  const expectedA4W = Math.round((210 / 25.4) * dpi); // 1240
  const expectedA4H = Math.round((297 / 25.4) * dpi); // 1754

  assert.equal(a4Canvas.width, expectedA4W, 'A4 width matches standard');
  assert.equal(a4Canvas.height, expectedA4H, 'A4 height matches standard');

  // Check that canvas center contains front and back cards
  const photoX = Math.round(expectedA4W / 2 + cardW * 0.25); // Inside face photo region
  const frontCenterY = Math.round(expectedA4H * 0.26);
  const backCenterY = Math.round(expectedA4H * 0.70);

  const frontIdx = (frontCenterY * expectedA4W + photoX) * 4;
  const backIdx = (backCenterY * expectedA4W + photoX) * 4;
  const emptyBorderIdx = (10 * expectedA4W + 10) * 4;

  // Background margin is pure white (255)
  assert.equal(a4Canvas.data[emptyBorderIdx], 255);

  // Front card photo is preserved in natural 24-bit RGB
  assert.ok(a4Canvas.data[frontIdx] > 180 && a4Canvas.data[frontIdx + 1] > 120, 'Front card photo placed at upper center');
  // Back card photo is preserved in natural 24-bit RGB
  assert.ok(a4Canvas.data[backIdx] > 180 && a4Canvas.data[backIdx + 1] > 120, 'Back card photo placed at lower center');
});

test('Universal Pipeline Dispatcher (processDocument)', () => {
  const doc = createSyntheticDocument(80, 80, 0);

  const resClean = processDocument(doc, 'clean');
  assert.equal(resClean.width, 80);

  const resBw = processDocument(doc, 'bw');
  assert.equal(resBw.width, 80);

  const resDual = processDocument(doc, 'dual_layer');
  assert.equal(resDual.width, 80);
});

test('WYSIWYG Filter String Builder (CSS & Canvas Parity)', () => {
  const strClean = buildImageFilterString({ brightness: 1.1, contrast: 1.2, bgClean: 40, filter: 'clean' });
  assert.ok(strClean.includes('brightness(1.1)'));
  assert.ok(strClean.includes('contrast(1.2)'));
  assert.ok(strClean.includes('contrast(1.18)'));
  assert.ok(strClean.includes('brightness(1.04)'));

  const strBw = buildImageFilterString({ filter: 'bw' });
  assert.ok(strBw.includes('grayscale(1) contrast(3.5) brightness(1.1)'));

  const strGray = buildImageFilterString({ filter: 'gray' });
  assert.ok(strGray.includes('grayscale(1)'));

  const strColor = buildImageFilterString({ filter: 'color' });
  assert.ok(strColor.includes('saturate(1.4) contrast(1.1)'));
});

test('Soft-Knee Background Whitening (Paper Tint Elimination)', () => {
  const buf = createImageBuffer(10, 10);
  // Light gray paper tint (RGB 230)
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = 230; buf.data[i + 1] = 230; buf.data[i + 2] = 230; buf.data[i + 3] = 255;
  }
  // Dark text ink (RGB 20) at pixel 0
  buf.data[0] = 20; buf.data[1] = 20; buf.data[2] = 20;

  applySoftKneePaperWhitening(buf, 40);

  // Dark text ink remains untouched
  assert.equal(buf.data[0], 20);
  assert.equal(buf.data[1], 20);
  assert.equal(buf.data[2], 20);

  // Paper background smoothly whitened to 255
  assert.equal(buf.data[4], 255);
  assert.equal(buf.data[5], 255);
  assert.equal(buf.data[6], 255);
});

test('DPI Header Injection (JPEG JFIF APP0 & PNG pHYs)', () => {
  // Test JPEG injection
  const fakeJpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00]);
  const taggedJpg = injectJpegDpi(fakeJpg, 300);
  assert.equal(taggedJpg[0], 0xFF);
  assert.equal(taggedJpg[1], 0xD8);
  assert.equal(taggedJpg[2], 0xFF);
  assert.equal(taggedJpg[3], 0xE0); // APP0
  const dpi = (taggedJpg[14] << 8) | taggedJpg[15];
  assert.equal(dpi, 300, 'JPEG DPI set to 300 in JFIF APP0');

  // Test PNG injection
  const fakePng = new Uint8Array(33 + 12);
  fakePng[0] = 0x89; fakePng[1] = 0x50; fakePng[2] = 0x4E; fakePng[3] = 0x47;
  const taggedPng = injectPngDpi(fakePng, 600);
  assert.equal(taggedPng[0], 0x89);
  // pHYs chunk type at offset 37: 'p' 'H' 'Y' 's'
  const typeStr = String.fromCharCode(taggedPng[37], taggedPng[38], taggedPng[39], taggedPng[40]);
  assert.equal(typeStr, 'pHYs', 'PNG pHYs chunk inserted after IHDR');
});
