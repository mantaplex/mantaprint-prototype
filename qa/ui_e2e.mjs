// End-to-end smoke test + documentation screenshots for the hub homepage and admin console.
//
// Usage:
//   PORT=18090 node src/web/server/server.mjs &
//   BASE=http://127.0.0.1:18090 OUT=docs/images/ui node qa/ui_e2e.mjs
//
// Needs Playwright with Chromium (`npm i -g playwright`). The hub runs for real; only the
// hardware-dependent status (connected USB printers, scanner, jobs) is replaced with a
// realistic demo fixture so the screenshots show a working hub. Screenshots are page
// captures only (no browser window or address bar).
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18090';
const OUT = process.env.OUT || 'docs/images/ui';
const USER = process.env.ADMIN_USER || 'mantaprint';
const PASS = process.env.ADMIN_PASS || 'mantapgan';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const now = Date.now();

async function demoStatus() {
  const real = await (await fetch(`${BASE}/api/status`)).json();
  const base = (q, extra) => ({
    queue_name: q, name: q, location: '', custom_broadcast_name: '', markers: [], markers_supported: false,
    driver_info: null, hardware_telemetry: null, is_default: false, can_edit: true, device_id: '',
    ipp_url: `ipp://192.168.1.114:631/printers/${q}`, cups_url: `http://192.168.1.114:631/printers/${q}`,
    mdns_url: `ipp://mantaprint.local:631/printers/${q}`, ...extra
  });
  const printers = [
    base('Canon_G3030', { display_name: 'Canon G3030 series', raw_display_name: 'Canon G3030 series', mdns_name: 'Canon G3030 · Front desk', model: 'Canon G3030 series', vendor: 'Canon', protocol: 'usb', is_usb: true, connected: true, classification: 'active_usb', can_delete: false, is_published: true, is_default: true, state: 'processing', location: 'Front desk', device_uri: 'usb://Canon/G3030%20series?serial=ABC123' }),
    base('HP_LaserJet_P1102', { display_name: 'HP LaserJet P1102', raw_display_name: 'HP LaserJet P1102', mdns_name: 'HP LaserJet P1102', model: 'HP LaserJet Professional P1102', vendor: 'HP', protocol: 'usb', is_usb: true, connected: true, classification: 'active_usb', can_delete: false, is_published: true, state: 'idle', device_uri: 'usb://HP/LaserJet%20Professional%20P1102?serial=XYZ' }),
    base('Epson_L3210', { display_name: 'Epson L3210 (back office)', raw_display_name: 'Epson L3210 (back office)', mdns_name: 'Epson L3210', model: 'Epson L3210', vendor: 'Epson', protocol: 'ipp', is_usb: false, connected: false, classification: 'network', can_delete: true, is_published: false, state: 'disconnected', alert_description: 'Printer jaringan tidak merespons di 192.168.1.62:631', device_uri: 'ipp://192.168.1.62/ipp/print', network_reachability: { state: 'offline', host: '192.168.1.62', port: 631, latency_ms: null, checked_at: now } }),
    base('HP_LaserJet_1020', { display_name: 'HP LaserJet 1020', raw_display_name: 'HP LaserJet 1020', mdns_name: 'HP LaserJet 1020', model: 'HP LaserJet 1020', vendor: 'HP', protocol: 'usb', is_usb: true, connected: true, classification: 'active_usb', can_delete: false, is_published: false, state: 'idle', device_uri: 'usb://HP/LaserJet%201020?serial=DEMO1020', readiness: 'needs_firmware', readiness_reason: 'firmware_downloading', readiness_detail: '' })
  ];
  const job = { id: 'Canon_G3030-128', numeric_id: 128, printer: 'Canon_G3030', size: 482113, state: 'processing', status_message: 'Printing page 2 of 4', submitted_at: now - 40000 };
  return {
    ...real,
    system: { ...real.system, ip: '192.168.1.114', broadcast_ip: '192.168.1.114', hostname: 'mantaprint', mdns_host: 'mantaprint.local', uptime: '3d 4h', cpu_temp: 48.5, load: [0.42, 0.37, 0.31], ram: { total_mb: 1906, used_mb: 612, percent: 32 }, broadcast_network: { iface: 'eth0', type: 'eth', ip: '192.168.1.114' }, storage: { ...real.system.storage, emmc: { totalMb: 7280, usedMb: 3120, freeMb: 4160, percent: 43 }, microsd: { mounted: true, totalGb: 29.7, usedMb: 820, freeGb: 28.9, percent: 3 }, ram_spool_active: false } },
    services: { cups: true, avahi: true, ipp_usb: true },
    printer: { ...printers[0], current_job: job, active_jobs: [job], recent_jobs: [], jobs: [job] },
    printers,
    published_printers: printers.filter((p) => p.is_published),
    scanner: { connected: true, name: 'Canon PIXMA G3030 series', driver: 'eSCL', sources: ['Flatbed'], has_adf: false, duplex_capable: false },
    custom_mdns: { hostname: 'mantaprint', domain: 'local', mdns_host: 'mantaprint.local', custom_broadcast_names: { Canon_G3030: 'Canon G3030 · Front desk' } },
    queues: printers.map((p) => ({ name: p.queue_name, state: p.state === 'processing' ? 'processing' : 'idle' }))
  };
}

const demoJobs = [
  { id: 'Canon_G3030-128', numeric_id: 128, printer: 'Canon_G3030', title: 'Invoice-September.pdf', user: '192.168.1.42', size: 482113, state: 'processing', status_message: 'Printing page 2 of 4', submitted_at: now - 40000 },
  { id: 'HP_LaserJet_P1102-57', numeric_id: 57, printer: 'HP_LaserJet_P1102', title: 'Boarding pass.pdf', user: '192.168.1.77', size: 95110, state: 'completed', status_message: 'Printed', submitted_at: now - 900000 },
  { id: 'Canon_G3030-127', numeric_id: 127, printer: 'Canon_G3030', title: 'KTP_2in1.pdf', user: '192.168.1.42', size: 301877, state: 'completed', status_message: 'Printed', submitted_at: now - 1800000 },
  { id: 'Canon_G3030-126', numeric_id: 126, printer: 'Canon_G3030', title: 'Photo 4R.jpg', user: '192.168.1.58', size: 2301877, state: 'canceled', status_message: 'Cancelled', submitted_at: now - 3600000 }
];

// What a scan of a typical small-office LAN returns (see printer_manager.py discover-network).
const demoDiscovery = {
  success: true, scanned_at: Math.floor(now / 1000), tools: { avahi: true, lpinfo: true }, auto_adopt: false, running: false,
  candidates: [
    { id: '192.168.1.50|HP LaserJet 400 M401dn (1A2B3C)', name: 'HP LaserJet 400 M401dn (1A2B3C)', make_model: 'HP LaserJet 400 M401dn', host: '192.168.1.50', location: 'Back office', protocols: ['ipp', 'socket'], airprint: false, recommendation: 'driver', configured_queue: null, adopt: { uri: 'socket://192.168.1.50:9100', protocol: 'socket', confidence: 'exact', driver_desc: 'HP LaserJet 400 M401 Postscript (recommended)' } },
    { id: '192.168.1.77|Brother HL-L2350DW series', name: 'Brother HL-L2350DW series', make_model: 'Brother HL-L2350DW series', host: '192.168.1.77', location: '', protocols: ['socket'], airprint: false, recommendation: 'review', configured_queue: null, adopt: { uri: 'socket://192.168.1.77:9100', protocol: 'socket', confidence: 'fuzzy', driver_desc: 'HL-L2300D' } },
    { id: '192.168.1.80|EPSON LQ-2190', name: 'EPSON LQ-2190', make_model: 'EPSON LQ-2190', host: '192.168.1.80', location: 'Warehouse', protocols: ['lpd'], airprint: false, recommendation: 'generic', configured_queue: null, adopt: { uri: 'lpd://192.168.1.80:515/lp', protocol: 'lpd', confidence: 'none', driver_desc: 'Fallback Generic PCL (unverified)' } },
    { id: '192.168.1.64|EPSON L6270 Series', name: 'EPSON L6270 Series', make_model: 'EPSON L6270 Series', host: '192.168.1.64', location: 'Front desk', protocols: ['ipp', 'ipps'], airprint: true, recommendation: 'native', configured_queue: null, adopt: { uri: 'ipp://192.168.1.64:631/ipp/print', protocol: 'ipp', confidence: 'exact', driver_desc: 'IPP Everywhere (driverless)' } },
    { id: '192.168.1.62|EPSON L3210 Series', name: 'EPSON L3210 Series', make_model: 'EPSON L3210 Series', host: '192.168.1.62', location: '', protocols: ['ipp'], airprint: true, recommendation: 'native', configured_queue: 'Epson_L3210', adopt: { uri: 'ipp://192.168.1.62:631/ipp/print', protocol: 'ipp', confidence: 'exact', driver_desc: 'IPP Everywhere (driverless)' } }
  ]
};

async function withDemo(context, status) {
  const sse = `retry: 600000\n\ndata: ${JSON.stringify(status)}\n\n`;
  await context.route('**/api/status*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(status) }));
  await context.route('**/api/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: sse }));
  await context.route('**/api/jobs', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, active_jobs: demoJobs.filter((j) => j.state === 'processing'), jobs: demoJobs }) }));
  await context.route('**/api/jobs/demo-*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, job: { id: 'demo-1', state: 'processing', status_message: 'Printing' } }) }));
  await context.route('**/api/scanner/status', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, scanner: status.scanner, mutex: { is_busy: false }, portal_enabled: true, remote_pwa_api_enabled: true }) }));
  await context.route('**/api/scanner/clients', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, clients: [
    { client_id: 'c_7f3a', device_name: 'Front desk tablet', platform: 'Android', status: 'active', last_seen_at: new Date(now - 600000).toISOString(), last_seen_ip: '192.168.1.80' },
    { client_id: 'c_19bd', device_name: "Rina's iPhone", platform: 'iOS', status: 'revoked', last_seen_at: new Date(now - 86400000 * 3).toISOString(), last_seen_ip: '192.168.1.91' }
  ] }) }));
  await context.route('**/api/printers/discover?*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(r.request().url().includes('refresh=1') ? demoDiscovery : { ...demoDiscovery, scanned_at: null, candidates: [] }) }));
  await context.route('**/api/printers/discover/adopt', (r) => r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, ok: true, code: 'adopted', queue: 'HP_LaserJet_400_M401dn', readiness: 'ready' }) }));
  await context.route('**/api/network/status', async (r) => {
    const res = await r.fetch();
    const j = await res.json();
    j.ethernet = { ...j.ethernet, carrier: true, operstate: 'UP', ip: '192.168.1.114', prefix: 24, speed: '1000 Mb/s' };
    j.wifi = { ...j.wifi, state: 'DISCONNECTED', ssid: null };
    j.system = { ...j.system, default_gateway: '192.168.1.1', dns_servers: ['192.168.1.1', '1.1.1.1'] };
    await r.fulfill({ response: res, json: j });
  });
}

function watch(page) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|ServiceWorker|sw\.js/i.test(m.text())) errors.push(`console: ${m.text()}`); });
}

async function login(page) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { username: USER, password: PASS } });
  const { token } = await res.json();
  if (!token) throw new Error('login failed');
  await page.addInitScript((tk) => { try { localStorage.setItem('mantaprint_admin_token', tk); } catch {} }, token);
}

async function assertNoHorizontalScroll(page, label) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  if (sw > cw + 1) errors.push(`horizontal overflow on ${label}: ${sw}px > ${cw}px`);
}

const shot = (page, name, full = false) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

const browser = await chromium.launch();
try {
  const status = await demoStatus();

  // ---------- Desktop -----------------------------------------------------------------
  // ChromeOS is the main target device for the hub web app
  const CROS_UA = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: CROS_UA });
  await withDemo(desk, status);
  await desk.addInitScript(() => {
    try {
      if (!localStorage.getItem('mantaprint_my_jobs')) localStorage.setItem('mantaprint_my_jobs', JSON.stringify([{ id: 'demo-1', token: 'x', title: 'Invoice-September.pdf', printer: 'Canon G3030 · Front desk', at: Date.now() - 30000 }]));
    } catch {}
  });
  let page = await desk.newPage();
  watch(page);
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.getByText('Add a MantaPrint printer to your device').waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'home-desktop', true);

  // Picking a printer updates the addresses in the guide
  await page.getByRole('radio', { name: /HP LaserJet P1102/ }).click();
  await page.getByRole('tab', { name: 'Windows' }).click();
  await page.getByText('http://192.168.1.114:631/printers/HP_LaserJet_P1102').waitFor();
  await page.getByRole('tab', { name: 'macOS' }).click();
  await page.getByText('printers/HP_LaserJet_P1102', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'ChromeOS' }).click();

  // "Print a file" is a button that opens a dialog (real upload through the hub)
  await page.getByRole('button', { name: 'Print a file' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Print a file' });
  await dlg.waitFor();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dlg.getByRole('button', { name: 'Choose file' }).click()]);
  await chooser.setFiles({ name: 'Invoice-September.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') });
  await dlg.getByText('Invoice-September.pdf').waitFor();
  await page.waitForTimeout(300);
  await shot(page, 'home-print-dialog');
  await dlg.getByRole('button', { name: 'Print', exact: true }).click();
  await page.getByText(/was sent to the printer|could not be printed|Tidak ada printer/).first().waitFor({ timeout: 15000 });
  console.log('home print flow OK:', await page.locator('.fixed.z-50').last().innerText().catch(() => ''));

  // Admin
  await login(page);
  const sections = ['overview', 'printers', 'queue', 'scanner', 'network', 'settings', 'updates'];
  for (const s of sections) {
    await page.goto(`${BASE}/admin${s === 'overview' ? '' : `/${s}`}`, { waitUntil: 'load' });
    await page.locator('main h1').first().waitFor();
    await page.waitForTimeout(900);
    await shot(page, `admin-${s}`, true);
  }
  // Printer side sheet
  await page.goto(`${BASE}/admin/printers`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /Canon G3030 series/ }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'admin-printer-sheet');
  await page.keyboard.press('Escape');

  // Printer waiting on firmware: readiness card + "Provision firmware now"
  await page.getByRole('button', { name: /HP LaserJet 1020/ }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Provision firmware now' }).waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'admin-printer-firmware');
  await page.keyboard.press('Escape');
  // Network discovery: scan, then adopt the legacy LaserJet with its exact driver
  await page.getByRole('button', { name: 'Scan network' }).click();
  await page.getByText('HP LaserJet 400 M401dn').first().waitFor();
  await page.locator('text=Set up as Epson_L3210 >> visible=true').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'admin-printers-discovery', true);
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const adoptDlg = page.getByRole('dialog', { name: 'Add HP LaserJet 400 M401dn' });
  await adoptDlg.getByText('socket://192.168.1.50:9100').waitFor();
  await page.waitForTimeout(300);
  await shot(page, 'admin-adopt-printer');
  await adoptDlg.getByRole('button', { name: 'Add printer' }).click();
  await page.getByText('HP LaserJet 400 M401dn was added.').waitFor();
  await page.goto(`${BASE}/admin/printers`, { waitUntil: 'load' });
  await page.locator('main h1').first().waitFor();

  // Add printer dialog
  await page.getByRole('button', { name: 'Add network printer' }).click();
  await page.getByRole('dialog', { name: 'Add network printer' }).waitFor();
  await page.waitForTimeout(300);
  await shot(page, 'admin-add-printer');
  await page.keyboard.press('Escape');

  // Indonesian
  await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
  await page.getByTitle('Language').click();
  await page.waitForTimeout(600);
  await shot(page, 'admin-overview-id');
  await page.getByTitle('Bahasa').click();
  await desk.close();

  // ScanSnap plugged in without its firmware: admin card + Studio hint. The upload goes
  // to the real hub, with a deliberately truncated .nal so nothing gets installed.
  const fwScanner = { connected: false, name: 'No scanner', firmware_required: { model: 'Fujitsu ScanSnap S1300', filename: '1300_0C26.nal', usb_id: '04c5:11ed' } };
  const fwCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: CROS_UA });
  await withDemo(fwCtx, { ...status, scanner: fwScanner });
  await fwCtx.route('**/api/scanner/firmware', async (r) => {
    if (r.request().method() !== 'GET') return r.continue();
    const res = await r.fetch();
    const j = await res.json();
    const s1300 = j.devices.find((d) => d.filename === '1300_0C26.nal');
    s1300.connected = true;
    await r.fulfill({ response: res, json: { ...j, connected: [s1300], needs_firmware: [s1300] } });
  });
  page = await fwCtx.newPage();
  watch(page);
  await login(page);
  await page.goto(`${BASE}/admin/scanner`, { waitUntil: 'load' });
  await page.getByText('Fujitsu ScanSnap S1300 needs its firmware').waitFor();
  const [fwChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Upload firmware or installer' }).click()]);
  await fwChooser.setFiles({ name: '1300_0C26.nal', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096) });
  await page.getByText("That doesn't look like a ScanSnap firmware file").waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  await shot(page, 'admin-scanner-firmware', true);
  await page.goto(`${BASE}/scan`, { waitUntil: 'load' });
  await page.getByText('Fujitsu ScanSnap S1300 needs its firmware').first().waitFor();
  await fwCtx.close();

  // Login screen (fresh context, no token)
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await anon.newPage();
  watch(page);
  await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
  await page.getByText('Sign in to admin').waitFor();
  await shot(page, 'admin-login');
  await anon.close();

  // ---------- Phone -------------------------------------------------------------------
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  await withDemo(phone, status);
  await phone.addInitScript(() => {
    try { localStorage.setItem('mantaprint_my_jobs', JSON.stringify([{ id: 'demo-1', token: 'x', title: 'Invoice-September.pdf', printer: 'Canon G3030 · Front desk', at: Date.now() - 30000 }])); } catch {}
  });
  page = await phone.newPage();
  watch(page);
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.getByText('Add a MantaPrint printer to your device').waitFor();
  await page.waitForTimeout(600);
  await assertNoHorizontalScroll(page, 'home (phone)');
  await shot(page, 'home-phone', true);

  // iPhone: the iOS tab is preselected and offers the AirPrint profile
  const iphone = await browser.newContext({ ...devices['iPhone 13'] });
  await withDemo(iphone, status);
  const ipage = await iphone.newPage();
  watch(ipage);
  await ipage.goto(`${BASE}/`, { waitUntil: 'load' });
  await ipage.getByRole('tab', { name: 'iPhone / iPad', selected: true }).waitFor();
  await ipage.getByRole('button', { name: 'Download AirPrint profile' }).waitFor();
  await ipage.waitForTimeout(400);
  await assertNoHorizontalScroll(ipage, 'home (iPhone)');
  await shot(ipage, 'home-iphone', true);
  await iphone.close();
  await login(page);
  for (const s of ['overview', 'printers', 'queue', 'scanner', 'network', 'settings', 'updates']) {
    await page.goto(`${BASE}/admin${s === 'overview' ? '' : `/${s}`}`, { waitUntil: 'load' });
    await page.locator('main h1').first().waitFor();
    await page.waitForTimeout(700);
    await assertNoHorizontalScroll(page, `admin ${s} (phone)`);
    if (s === 'overview' || s === 'printers') await shot(page, `admin-${s}-phone`, true);
  }
  await page.goto(`${BASE}/admin/printers`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Scan network' }).tap();
  await page.getByText('HP LaserJet 400 M401dn').first().waitFor();
  await page.waitForTimeout(300);
  await assertNoHorizontalScroll(page, 'admin printers discovery (phone)');
  await page.getByRole('button', { name: /Canon G3030 series/ }).first().tap();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400);
  await shot(page, 'admin-printer-sheet-phone');
  await phone.close();
} finally {
  await browser.close();
}

if (errors.length) {
  console.error('BROWSER ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('UI E2E OK — screenshots in', OUT);
