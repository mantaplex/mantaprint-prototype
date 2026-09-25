// Usage: npm i -g playwright && PORT=18090 node src/web/server/server.mjs &  then  BASE=http://127.0.0.1:18090 node qa/studio_e2e.mjs
// Playwright smoke test + screenshot capture for MantaPageScan Studio (/scan)
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:18090';
const OUT = process.env.OUT || '/home/user/mantaprint/docs/images/scan-studio';
const TMP = process.env.TMP_DIR || path.join(process.cwd(), '.e2e-samples');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const errors = [];
const attach = async (page) => {
  // Headless Chromium exposes showSaveFilePicker but can never show the picker; use the download fallback.
  await page.addInitScript(() => { try { delete window.showSaveFilePicker; } catch {} window.showSaveFilePicker = undefined; });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
};

// Generate document-like sample scans in a throwaway page (canvas → PNG)
async function makeSamples(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const draw = async (kind, idx) => {
    const dataUrl = await page.evaluate(({ kind, idx }) => {
      const c = document.getElementById('c');
      const isCard = kind === 'card';
      c.width = isCard ? 1200 : 1240; c.height = isCard ? 800 : 1754;
      const g = c.getContext('2d');
      // scanner glass background / paper tint
      g.fillStyle = isCard ? '#2b2b2b' : '#efe9dc';
      g.fillRect(0, 0, c.width, c.height);
      g.save();
      if (!isCard) { g.translate(c.width / 2, c.height / 2); g.rotate((idx === 1 ? -1.6 : 0.9) * Math.PI / 180); g.translate(-c.width / 2, -c.height / 2); }
      if (isCard) {
        g.translate(c.width / 2, c.height / 2); g.rotate((idx === 1 ? 1.2 : -0.8) * Math.PI / 180); g.translate(-c.width / 2, -c.height / 2);
        const cw = 1010, ch = 637, cx = (c.width - cw) / 2, cy = (c.height - ch) / 2;
        const grad = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
        grad.addColorStop(0, '#dbe7f5'); grad.addColorStop(1, '#f6f3e6');
        g.fillStyle = grad; g.beginPath(); g.roundRect(cx, cy, cw, ch, 36); g.fill();
        g.fillStyle = '#1f3a5f'; g.font = 'bold 44px sans-serif';
        g.fillText(idx === 1 ? 'PROVINSI CONTOH' : 'KARTU IDENTITAS — SISI BELAKANG', cx + 60, cy + 90);
        g.font = '30px sans-serif'; g.fillStyle = '#222';
        const rows = idx === 1 ? ['NIK   : 3171 0000 0000 0001', 'Nama  : NAMA PEMEGANG KARTU', 'Lahir : KOTA, 01-01-1990', 'Alamat: JL. CONTOH NO. 12'] : ['Berlaku hingga: SEUMUR HIDUP', 'Gol. darah: O', 'Status: KAWIN', 'Kewarganegaraan: WNI'];
        rows.forEach((r, i) => g.fillText(r, cx + 60, cy + 180 + i * 60));
        if (idx === 1) { g.fillStyle = '#c9b07a'; g.fillRect(cx + cw - 300, cy + 140, 220, 280); g.fillStyle = '#7a6340'; g.beginPath(); g.arc(cx + cw - 190, cy + 240, 60, 0, 7); g.fill(); }
        g.restore();
        return c.toDataURL('image/png');
      }
      g.fillStyle = '#ffffff'; g.fillRect(70, 70, c.width - 140, c.height - 140);
      g.fillStyle = '#111'; g.font = 'bold 46px sans-serif';
      g.fillText(idx === 1 ? 'SURAT KETERANGAN' : 'LAMPIRAN ' + idx, 190, 220);
      g.font = '26px sans-serif'; g.fillStyle = '#333';
      for (let y = 300; y < c.height - 260; y += 46) {
        const w = 300 + ((y * 37) % 600);
        g.fillStyle = '#3a3a3a'; g.fillRect(190, y, w, 6);
        if (y % 3 === 0) g.fillRect(190 + w + 40, y, 120, 6);
      }
      // colour stamp + signature
      g.strokeStyle = 'rgba(200,30,40,0.85)'; g.lineWidth = 8; g.beginPath(); g.arc(880, 1420, 120, 0, Math.PI * 2); g.stroke();
      g.fillStyle = 'rgba(200,30,40,0.85)'; g.font = 'bold 34px sans-serif'; g.fillText('DISETUJUI', 790, 1432);
      g.strokeStyle = '#1b2a6b'; g.lineWidth = 5; g.beginPath(); g.moveTo(300, 1500); g.bezierCurveTo(360, 1400, 420, 1600, 520, 1470); g.bezierCurveTo(580, 1400, 600, 1560, 700, 1480); g.stroke();
      // scanner shadow / crease
      const sh = g.createLinearGradient(0, 0, 260, 0); sh.addColorStop(0, 'rgba(0,0,0,0.18)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sh; g.fillRect(70, 70, 260, c.height - 140);
      g.restore();
      return c.toDataURL('image/png');
    }, { kind, idx });
    const file = path.join(TMP, `${kind}${idx}.png`);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return file;
  };
  const files = [await draw('doc', 1), await draw('doc', 2), await draw('doc', 3), await draw('card', 1), await draw('card', 2)];
  await ctx.close();
  return files;
}

async function waitThumbs(page, n) {
  await page.waitForFunction((n) => document.querySelectorAll('aside img[src^="blob:"]').length >= n, n, { timeout: 30000 });
}

async function desktop(browser, samples) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  await attach(page);
  await page.goto(`${BASE}/scan`, { waitUntil: 'load' });
  await page.waitForSelector('text=MantaPageScan Studio');
  await page.screenshot({ path: `${OUT}/01-library-empty.png` });

  // Import 3 document pages
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Import images/i }).click()
  ]);
  await chooser.setFiles(samples.slice(0, 3));
  await page.waitForURL(/\/scan\/doc_/, { timeout: 20000 });
  await waitThumbs(page, 3);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-workbench.png` });

  // Enhance tray
  await page.getByRole('button', { name: 'Enhance', exact: true }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Enhance"]');
  await page.getByRole('button', { name: 'Text + stamps' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/03-enhance-tray.png` });
  await page.keyboard.press('Escape');

  // Crop tray
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Crop"]');
  await page.getByRole('button', { name: 'Auto-straighten' }).click();
  await page.waitForTimeout(900);
  // drag the NW handle a bit
  const handle = page.locator('.crop-handle').first();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 60, hb.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/04-crop-deskew.png` });
  await page.getByRole('button', { name: 'Apply crop' }).click();
  await page.waitForTimeout(800);

  // Multi-select + rotate via rail
  const thumbs = page.locator('aside [role="checkbox"]');
  await thumbs.nth(1).click();
  await thumbs.nth(2).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/05-multiselect.png` });
  await page.keyboard.press('Escape');

  // KTP: import 2 card images, assign roles, compose
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const [chooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Choose files' }).click()
  ]);
  await chooser2.setFiles(samples.slice(3, 5));
  await waitThumbs(page, 5);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'ID 2-in-1', exact: true }).click();
  await page.waitForSelector('[role="dialog"][aria-label="ID 2-in-1"]');
  // active page is the last imported (card2) → use as back; then select card1 → front
  const useBtns = page.locator('[role="dialog"][aria-label="ID 2-in-1"] button', { hasText: 'Use current page' });
  await useBtns.nth(1).click();
  await page.locator('aside button[aria-label="Page 4"]').click();
  await useBtns.nth(0).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/06-ktp-tray.png` });
  await page.getByRole('button', { name: 'Create 2-in-1 sheet' }).click();
  await waitThumbs(page, 6);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/07-ktp-sheet.png` });

  // Export → PDF download
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Export document"]');
  await page.screenshot({ path: `${OUT}/08-export-sheet.png` });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.getByRole('button', { name: /Download|Save as/ }).click()
  ]);
  const pdfPath = path.join(TMP, 'export.pdf');
  await download.saveAs(pdfPath);
  const head = fs.readFileSync(pdfPath).subarray(0, 5).toString();
  if (head !== '%PDF-') throw new Error('Exported file is not a PDF: ' + head);
  console.log('PDF export OK', fs.statSync(pdfPath).size, 'bytes');
  await page.waitForTimeout(1200);

  // TIFF export
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Export document"]');
  await page.getByRole('button', { name: 'TIFF' }).click();
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 90000 }),
    page.getByRole('button', { name: /Download|Save as/ }).click()
  ]);
  const tifPath = path.join(TMP, 'export.tif');
  await dl2.saveAs(tifPath);
  const tifHead = fs.readFileSync(tifPath).subarray(0, 4);
  if (tifHead[0] !== 0x49 || tifHead[2] !== 0x2a) throw new Error('Exported file is not a TIFF');
  console.log('TIFF export OK', fs.statSync(tifPath).size, 'bytes');
  await page.waitForTimeout(1000);

  // Undo works, rename, back to library (persistence)
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Back to documents/ }).click();
  await page.waitForSelector('text=Documents');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/09-library-with-docs.png` });

  // Reload → document persisted?
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=Documents');
  const cards = await page.locator('button[aria-label^="Open "]').count();
  if (cards < 1) throw new Error('Document did not persist across reload');
  await page.locator('button[aria-label^="Open "]').first().click();
  await page.waitForURL(/\/scan\/doc_/);
  await waitThumbs(page, 5);
  console.log('Persistence OK: reopened document with', await page.locator('aside img[src^="blob:"]').count(), 'pages');

  // Indonesian UI
  await page.getByTitle('Language').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/10-workbench-id.png` });
  await page.getByTitle('Bahasa').click();
  await ctx.close();
}

async function mobile(browser, samples) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  const page = await ctx.newPage();
  await attach(page);
  await page.goto(`${BASE}/scan`, { waitUntil: 'load' });
  await page.waitForSelector('text=Documents');
  await page.waitForTimeout(500);
  // fresh browser context = fresh IndexedDB: import first, then reopen from the library
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /Import images/i }).tap()
  ]);
  await chooser.setFiles(samples.slice(0, 3));
  await page.waitForURL(/\/scan\/doc_/, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0, null, { timeout: 30000 });
  await page.getByRole('button', { name: /Back to documents/ }).tap();
  await page.waitForSelector('text=Documents');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/11-mobile-library.png` });
  await page.locator('button[aria-label^="Open "]').first().tap();
  await page.waitForURL(/\/scan\/doc_/);
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0, null, { timeout: 30000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/12-mobile-workbench.png` });
  await page.getByRole('button', { name: 'Enhance', exact: true }).tap();
  await page.waitForSelector('[role="dialog"][aria-label="Enhance"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/13-mobile-enhance-sheet.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pages', exact: true }).tap();
  await page.waitForSelector('[role="dialog"][aria-label="Pages"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/14-mobile-pages-sheet.png` });
  await ctx.close();
}

const browser = await chromium.launch();
try {
  const samples = await makeSamples(browser);
  await desktop(browser, samples);
  await mobile(browser, samples);
} finally {
  await browser.close();
}
const real = errors.filter((e) => !/favicon|sw\.js|ServiceWorker|manifest|Failed to load resource/i.test(e));
if (real.length) {
  console.error('BROWSER ERRORS:\n' + real.join('\n'));
  process.exit(1);
}
console.log('E2E OK — screenshots in', OUT);
