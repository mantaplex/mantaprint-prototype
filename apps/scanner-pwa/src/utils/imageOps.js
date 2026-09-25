import { PDFDocument } from 'pdf-lib';

/**
 * Loads an image blob or URL into an HTML Image element
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const isBlob = typeof src !== 'string';
    const objectUrl = isBlob ? URL.createObjectURL(src) : src;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (isBlob) URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = (e) => {
      if (isBlob) URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image: ' + e));
    };
    img.src = objectUrl;
  });
}

/**
 * Rotate Image by 90, 180, or 270 degrees
 */
export async function rotateImage(imageSource, degrees) {
  const img = await loadImage(imageSource);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const rad = (degrees * Math.PI) / 180;
  if (degrees === 90 || degrees === 270) {
    canvas.width = img.height;
    canvas.height = img.width;
  } else {
    canvas.width = img.width;
    canvas.height = img.height;
  }

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

/**
 * Sauvola Local Adaptive Thresholding in pure client-side JS
 * Ideal for business documents, receipts, and text notes.
 */
export async function applySauvolaBinarization(imageSource, windowSize = 15, k = 0.2, r = 128) {
  const img = await loadImage(imageSource);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const width = canvas.width;
  const height = canvas.height;

  // 1. Convert to Grayscale & compute Integral Images for fast O(1) box sum
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  const integral = new Float64Array((width + 1) * (height + 1));
  const integralSq = new Float64Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < width; x++) {
      const val = gray[y * width + x];
      rowSum += val;
      rowSumSq += val * val;

      const idx = (y + 1) * (width + 1) + (x + 1);
      const aboveIdx = y * (width + 1) + (x + 1);

      integral[idx] = integral[aboveIdx] + rowSum;
      integralSq[idx] = integralSq[aboveIdx] + rowSumSq;
    }
  }

  const half = Math.floor(windowSize / 2);

  // 2. Compute Sauvola Threshold for each pixel: T = m * (1 + k * (s / r - 1))
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height - 1, y + half);

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x + half);

      const count = (x1 - x0 + 1) * (y1 - y0 + 1);

      const iA = y0 * (width + 1) + x0;
      const iB = y0 * (width + 1) + (x1 + 1);
      const iC = (y1 + 1) * (width + 1) + x0;
      const iD = (y1 + 1) * (width + 1) + (x1 + 1);

      const sum = integral[iD] - integral[iB] - integral[iC] + integral[iA];
      const sumSq = integralSq[iD] - integralSq[iB] - integralSq[iC] + integralSq[iA];

      const mean = sum / count;
      const variance = Math.max(0, (sumSq / count) - (mean * mean));
      const stdDev = Math.sqrt(variance);

      const threshold = mean * (1.0 + k * ((stdDev / r) - 1.0));

      const pixelIdx = (y * width + x) * 4;
      const pixelVal = gray[y * width + x] >= threshold ? 255 : 0;

      data[pixelIdx] = pixelVal;
      data[pixelIdx + 1] = pixelVal;
      data[pixelIdx + 2] = pixelVal;
      // Alpha remains 255
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/**
 * KTP 2-in-1 Dual Side Alignment:
 * Front & Back ID cards combined onto a single standard A4 sheet
 */
export async function mergeKtp2In1(frontBlob, backBlob) {
  const frontImg = await loadImage(frontBlob);
  const backImg = await loadImage(backBlob);

  const canvas = document.createElement('canvas');
  // Standard A4 at 300 DPI: 2480 x 3508 pixels
  canvas.width = 2480;
  canvas.height = 3508;
  const ctx = canvas.getContext('2d');

  // Fill white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Standard KTP size in mm is 85.6 x 53.98.
  // At 300 DPI, that is ~1011 x 638 pixels.
  const targetW = 1011;
  const targetH = 638;

  // Center horizontally
  const x = (canvas.width - targetW) / 2;

  // Front card position (upper third)
  const yFront = 600;
  ctx.drawImage(frontImg, x, yFront, targetW, targetH);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, yFront, targetW, targetH);

  // Back card position (lower third)
  const yBack = yFront + targetH + 300;
  ctx.drawImage(backImg, x, yBack, targetW, targetH);
  ctx.strokeRect(x, yBack, targetW, targetH);

  // Header note
  ctx.fillStyle = '#64748b';
  ctx.font = '32px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SALINAN KARTU IDENTITAS RESMI (KTP 2-IN-1)', canvas.width / 2, 450);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}

/**
 * Compile multiple page blobs into a single searchable PDF using pdf-lib
 */
export async function compilePdfFromPages(pageBlobs) {
  const pdfDoc = await PDFDocument.create();

  for (const blob of pageBlobs) {
    const arrayBuffer = await blob.arrayBuffer();
    let embeddedImg;

    if (blob.type.includes('png')) {
      embeddedImg = await pdfDoc.embedPng(arrayBuffer);
    } else {
      embeddedImg = await pdfDoc.embedJpg(arrayBuffer);
    }

    const { width, height } = embeddedImg;
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embeddedImg, {
      x: 0,
      y: 0,
      width,
      height
    });
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}
