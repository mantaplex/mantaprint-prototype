/** Translations for MantaPageScan Studio (merged into the global dictionary under `studio`). */
export const studioEn = {
  common: { pages: 'pages' },
  header: {
    home: 'Home', language: 'Language', saved: 'Saved on this device', saving: 'Saving…', saveError: 'Save failed',
    undo: 'Undo', redo: 'Redo', export: 'Export', togglePages: 'Show or hide pages', renameHint: 'Click to rename'
  },
  scanner: { connected: 'Scanner connected', notConnected: 'No scanner detected', notConnectedHint: 'Connect a USB scanner to the hub or import images instead.', needsFirmware: '{model} needs its firmware', needsFirmwareHint: 'Ask the hub admin to install the scanner firmware (Admin → Scanner). You can import images meanwhile.' },
  library: {
    tagline: 'Local-first scan & document workbench',
    heroTitle: 'Scan, tidy up, export — all on this device',
    heroDesc: 'Pages are acquired from the hub scanner and processed in this browser. Documents stay in this device\'s storage until you delete them, so you can come back and keep editing.',
    localBadge: '100% on-device processing · nothing is stored on the hub',
    newScan: 'New scan', importImages: 'Import images', recent: 'Documents', search: 'Search documents…',
    storageHint: 'Space used by documents on this device',
    emptyTitle: 'No documents yet', emptyDesc: 'Start a new scan or drop image files here to create your first document.',
    noResults: 'No documents match your search.',
    open: 'Open', rename: 'Rename', pin: 'Pin to top', unpin: 'Unpin', duplicate: 'Duplicate', delete: 'Delete', more: 'More actions',
    deleteTitle: 'Delete document?', deleteDesc: '"{title}" and all its pages will be removed from this device. This cannot be undone.',
    footerPrivacy: 'Documents live only in this browser\'s storage. Clearing site data removes them.'
  },
  tools: { pages: 'Pages', scan: 'Scan', import: 'Import', enhance: 'Enhance', crop: 'Crop', rotate: 'Rotate', ktp: 'ID 2-in-1', export: 'Export', print: 'Print', rotateLeft: 'Rotate left', rotateRight: 'Rotate right', select: 'Select', pan: 'Pan', draw: 'Draw', text: 'Text', shapes: 'Shapes', sign: 'Sign', redact: 'Redact', ocr: 'OCR', adjust: 'Adjust', find: 'Find', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit width' },
  draw: { pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', color: 'Colour', size: 'Size', thin: 'Thin', medium: 'Medium', thick: 'Thick', clearPage: 'Clear all drawings on page {n}', eraserHint: 'Drag over a drawing to remove it.' },
  shapes: { rect: 'Rectangle', rounded_rect: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', stroke: 'Stroke', width: 'Width', fill: 'Fill', noFill: 'No fill', solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', hint: 'Drag on the page to draw. Click once for a default size.' },
  sign: {
    signature: 'Signature', newSignature: 'New signature', createSignature: 'Create signature', check: 'Check', cross: 'Cross', date: 'Date', image: 'Image',
    padTitle: 'Draw your signature', padHint: 'Sign with a finger, pen or mouse inside the box.', clear: 'Clear', upload: 'Upload image', saveForLater: 'Keep for next time (this device only)', place: 'Place on page',
    removeSaved: 'Remove saved signature', empty: 'Draw something first.', placeHint: 'Placed in the middle of the page — drag it where it belongs.'
  },
  redact: { blackout: 'Blackout', whiteout: 'Whiteout', label: 'Label on the box (optional), e.g. CONFIDENTIAL', hint: 'Drag a box over the area. On export the area is painted into the page image and the recognised text under it is removed.' },
  ocr: {
    title: 'Text recognition (OCR)', language: 'Language', langs: { 'ind+eng': 'Indonesian + English', ind: 'Indonesian', eng: 'English' },
    thisPage: 'Recognise this page', allPages: 'Recognise all pages', remaining: '{n} page(s) without text', auto: 'Recognise new pages automatically',
    stateNone: 'Not recognised yet', stateStale: 'Page changed since recognition — run again', stateDone: '{n} words · {conf}% confidence', stateRunning: 'Recognising… {pct}%', stateQueued: 'Waiting…',
    copyPage: 'Copy page text', copyAll: 'Copy all text', copied: 'Text copied.', noText: 'No text found on this page.', done: 'Text recognised on {n} page(s).', failed: 'Text recognition failed: {msg}',
    privacy: 'Runs entirely in this browser. Pages never leave this device.', unsupported: 'This browser cannot run OCR (WebAssembly is blocked).', selectHint: 'Select text on the page with the Select tool, then copy it (Ctrl+C).'
  },
  adjust: { title: 'Adjust page' },
  objects: {
    title: 'Page objects', button: 'Objects', all: 'All pages', thisPage: 'This page', filter: 'Filter objects…', empty: 'No objects yet', emptyHint: 'Use Draw, Text, Shapes, Sign or Redact in the dock to add some.', noMatch: 'No matching objects',
    deselect: 'Deselect', page: 'P.{n}', opacity: 'Opacity', label: 'Label', text: 'Text', properties: 'Properties',
    types: { ink: 'Drawing', highlighter: 'Highlight', shape: 'Shape', text: 'Text', image: 'Image', signature: 'Signature', mark: 'Mark', redact: 'Redaction' }
  },
  obj: { duplicate: 'Duplicate', delete: 'Delete', bold: 'Bold', align: 'Alignment', smaller: 'Smaller text', larger: 'Larger text', editText: 'Edit text', fill: 'Fill', noFill: 'No fill', blackout: 'Black', whiteout: 'White', typeHere: 'Type here…' },
  find: { placeholder: 'Find in document…', none: 'No matches', of: '{i} of {n}', prev: 'Previous match', next: 'Next match', close: 'Close', needsOcr: 'Run OCR first to search the text.' },
  presets: {
    office: { title: 'Office document', desc: 'Clean paper background, sharp text, colour stamps kept.' },
    ktp: { title: 'ID card 2-in-1', desc: 'Front + back of an ID card on one A4 sheet.' },
    archive: { title: 'Archive (B/W)', desc: 'Pure black & white for very small files.' },
    photo: { title: 'Photo / true colour', desc: 'No processing, natural colours.' }
  },
  filters: { none: 'Original', clean: 'Clean', bw: 'Black & white', gray: 'Grayscale', dual_layer: 'Text + stamps', color: 'Vivid' },
  scan: {
    preset: 'Preset', paper: 'Paper', dpi: 'Resolution', recommended: 'recommended', color: 'Colour', colorMode: 'Colour', gray: 'Gray', source: 'Source', flatbed: 'Flatbed',
    scanPage: 'Scan page', scanning: 'Scanning…', phasePrepare: 'Preparing scanner…', phaseScanning: 'Scanning page…', phaseTransfer: 'Transferring to this device…',
    busy: 'Scanner is in use by {holder}. Try again in {sec}s.', failed: 'Scan failed.',
    privacyNote: 'The hub deletes its copy the moment the page arrives here.'
  },
  import: { drop: 'Drop images here', browse: 'Choose files', camera: 'Camera', note: '*HEIC is supported where the browser can decode it (ChromeOS, Android).' },
  enhance: { quick: 'Quick looks', mode: 'Mode', bgClean: 'Paper whitening', contrast: 'Contrast', brightness: 'Brightness', reset: 'Reset', applyAll: 'Apply to all pages' },
  crop: {
    hint: 'Drag the handles on the page to set the crop. Straighten with the slider or auto-deskew.',
    rotate: 'Rotate & straighten', autoDeskew: 'Auto-straighten', deskewing: 'Detecting…', straighten: 'Straighten', ratio: 'Crop presets',
    presets: { full: 'Full page', a4: 'A4', card: 'ID card', square: 'Square' }, apply: 'Apply crop', clear: 'Clear crop'
  },
  ktp: {
    hint: 'Mark one page as the front and one as the back. Each card is detected, cropped and placed on a white A4 sheet.',
    useCurrent: 'Use current page', outputDpi: 'Sheet resolution', compose: 'Create 2-in-1 sheet', composing: 'Composing…'
  },
  roles: { front: 'Front', back: 'Back', sheet: '2-in-1', normal: '' },
  rail: {
    pages: 'Pages', selectAll: 'Select all', clear: 'Clear', selected: 'selected', empty: 'Scan or import a page to get started.',
    page: 'Page', dragHint: 'Drag to reorder', moveUp: 'Move up', moveDown: 'Move down', duplicate: 'Duplicate'
  },
  stage: {
    emptyTitle: 'Nothing to show yet', emptyDesc: 'Use Scan or Import in the dock below to add the first page.',
    rendering: 'Rendering', original: 'Original', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to screen', compare: 'Hold to compare with original'
  },
  export: {
    title: 'Export document', format: 'Format', scope: 'Pages', allPages: 'All', selected: 'Selected', quality: 'Quality', qHigh: 'High', qBalanced: 'Balanced', qSmall: 'Small',
    pageSize: 'Page size', fitPaper: 'Fit to paper', trueSize: 'Scan size', filename: 'File name', zipHint: 'Several pages are packed into one ZIP file.',
    saveAs: 'Save as…', download: 'Download', working: 'Rendering…', done: 'Saved.',
    fsaNote: 'You choose where the file goes; nothing is uploaded.', downloadNote: 'The file is downloaded by your browser; nothing is uploaded.',
    searchable: 'Searchable text (OCR)', searchableHint: 'Adds the recognised text invisibly, so the PDF can be searched and copied.', textOnlyHint: 'Uses the recognised text (OCR). Pages without text are skipped.', ocrMissing: '{n} page(s) have no recognised text yet.', runOcr: 'Recognise now', objectsNote: 'Drawings, signatures and redactions are painted into the pages.'
  },
  print: { title: 'Print copy', desc: 'Send {n} page(s) to the hub printer on {paper} paper.', copies: 'Copies', send: 'Print', sending: 'Sending…', noPrinter: 'No printer is connected to the hub right now.' },
  workbench: { notFound: 'This document no longer exists on this device.', backToLibrary: 'Back to documents' },
  toasts: {
    noImages: 'Please choose image files (JPG, PNG, WEBP).', imported: '{n} page(s) imported.', scanned: 'Page {n} scanned.',
    duplicated: 'Document duplicated.', deleted: 'Document deleted.', appliedAll: 'Look applied to all pages.',
    deskewed: 'Straightened by {deg}°.', deskewFailed: 'Could not detect skew.', ktpDone: '2-in-1 sheet added as a new page.', ktpFailed: 'Could not compose the sheet.',
    exported: '{name} saved.', printed: 'Sent to the printer.', printFailed: 'Printing failed.', drawingsCleared: 'Drawings removed from page {n}.'
  }
};

export const studioId = {
  common: { pages: 'halaman' },
  header: {
    home: 'Beranda', language: 'Bahasa', saved: 'Tersimpan di perangkat ini', saving: 'Menyimpan…', saveError: 'Gagal menyimpan',
    undo: 'Urungkan', redo: 'Ulangi', export: 'Ekspor', togglePages: 'Tampilkan/sembunyikan halaman', renameHint: 'Klik untuk mengganti nama'
  },
  scanner: { connected: 'Scanner terhubung', notConnected: 'Scanner tidak terdeteksi', notConnectedHint: 'Hubungkan scanner USB ke hub, atau impor gambar.', needsFirmware: '{model} butuh firmware', needsFirmwareHint: 'Minta admin hub memasang firmware scanner (Admin → Scanner). Sementara itu Anda bisa impor gambar.' },
  library: {
    tagline: 'Workbench pindai & dokumen berbasis perangkat lokal',
    heroTitle: 'Pindai, rapikan, ekspor — semuanya di perangkat ini',
    heroDesc: 'Halaman diambil dari scanner hub lalu diproses di browser ini. Dokumen tersimpan di penyimpanan perangkat ini sampai Anda menghapusnya, jadi bisa dilanjutkan kapan saja.',
    localBadge: '100% diproses di perangkat · tidak ada yang disimpan di hub',
    newScan: 'Pindai baru', importImages: 'Impor gambar', recent: 'Dokumen', search: 'Cari dokumen…',
    storageHint: 'Ruang yang dipakai dokumen di perangkat ini',
    emptyTitle: 'Belum ada dokumen', emptyDesc: 'Mulai pindaian baru atau seret berkas gambar ke sini untuk membuat dokumen pertama.',
    noResults: 'Tidak ada dokumen yang cocok.',
    open: 'Buka', rename: 'Ganti nama', pin: 'Sematkan di atas', unpin: 'Lepas sematan', duplicate: 'Duplikat', delete: 'Hapus', more: 'Aksi lainnya',
    deleteTitle: 'Hapus dokumen?', deleteDesc: '"{title}" beserta semua halamannya akan dihapus dari perangkat ini. Tidak dapat dibatalkan.',
    footerPrivacy: 'Dokumen hanya tersimpan di penyimpanan browser ini. Menghapus data situs akan menghapusnya.'
  },
  tools: { pages: 'Halaman', scan: 'Pindai', import: 'Impor', enhance: 'Perbaiki', crop: 'Potong', rotate: 'Putar', ktp: 'KTP 2-in-1', export: 'Ekspor', print: 'Cetak', rotateLeft: 'Putar kiri', rotateRight: 'Putar kanan', select: 'Pilih', pan: 'Geser', draw: 'Gambar', text: 'Teks', shapes: 'Bentuk', sign: 'TTD', redact: 'Sensor', ocr: 'OCR', adjust: 'Atur', find: 'Cari', zoomIn: 'Perbesar', zoomOut: 'Perkecil', fit: 'Pas lebar' },
  draw: { pen: 'Pena', highlighter: 'Stabilo', eraser: 'Penghapus', color: 'Warna', size: 'Tebal', thin: 'Tipis', medium: 'Sedang', thick: 'Tebal', clearPage: 'Hapus semua coretan di hal. {n}', eraserHint: 'Sapukan ke coretan untuk menghapusnya.' },
  shapes: { rect: 'Kotak', rounded_rect: 'Kotak tumpul', ellipse: 'Elips', line: 'Garis', arrow: 'Panah', stroke: 'Garis', width: 'Tebal', fill: 'Isi', noFill: 'Tanpa isi', solid: 'Penuh', dashed: 'Putus-putus', dotted: 'Titik-titik', hint: 'Seret di halaman untuk menggambar. Klik sekali untuk ukuran bawaan.' },
  sign: {
    signature: 'Tanda tangan', newSignature: 'Baru', createSignature: 'Buat tanda tangan', check: 'Centang', cross: 'Silang', date: 'Tanggal', image: 'Gambar',
    padTitle: 'Gambar tanda tangan Anda', padHint: 'Tanda tangani dengan jari, pena, atau mouse di dalam kotak.', clear: 'Bersihkan', upload: 'Unggah gambar', saveForLater: 'Simpan untuk lain kali (hanya di perangkat ini)', place: 'Tempel di halaman',
    removeSaved: 'Hapus tanda tangan tersimpan', empty: 'Gambar tanda tangan dulu.', placeHint: 'Diletakkan di tengah halaman — seret ke posisinya.'
  },
  redact: { blackout: 'Hitam', whiteout: 'Putih', label: 'Label di kotak (opsional), mis. RAHASIA', hint: 'Tarik kotak di atas area. Saat ekspor, area itu dilukis permanen ke gambar halaman dan teks hasil OCR di bawahnya dihapus.' },
  ocr: {
    title: 'Pengenalan teks (OCR)', language: 'Bahasa', langs: { 'ind+eng': 'Indonesia + Inggris', ind: 'Indonesia', eng: 'Inggris' },
    thisPage: 'Kenali halaman ini', allPages: 'Kenali semua halaman', remaining: '{n} halaman belum dikenali', auto: 'Kenali halaman baru otomatis',
    stateNone: 'Belum dikenali', stateStale: 'Halaman berubah sejak dikenali — jalankan lagi', stateDone: '{n} kata · keyakinan {conf}%', stateRunning: 'Mengenali… {pct}%', stateQueued: 'Menunggu…',
    copyPage: 'Salin teks halaman', copyAll: 'Salin semua teks', copied: 'Teks disalin.', noText: 'Tidak ada teks di halaman ini.', done: 'Teks dikenali pada {n} halaman.', failed: 'Pengenalan teks gagal: {msg}',
    privacy: 'Berjalan sepenuhnya di browser ini. Halaman tidak pernah keluar dari perangkat.', unsupported: 'Browser ini tidak bisa menjalankan OCR (WebAssembly diblokir).', selectHint: 'Pilih teks di halaman dengan alat Pilih, lalu salin (Ctrl+C).'
  },
  adjust: { title: 'Atur halaman' },
  objects: {
    title: 'Objek halaman', button: 'Objek', all: 'Semua halaman', thisPage: 'Halaman ini', filter: 'Saring objek…', empty: 'Belum ada objek', emptyHint: 'Pakai Gambar, Teks, Bentuk, TTD, atau Sensor di dock untuk menambah.', noMatch: 'Tidak ada objek yang cocok',
    deselect: 'Batal pilih', page: 'Hal.{n}', opacity: 'Keburaman', label: 'Label', text: 'Teks', properties: 'Properti',
    types: { ink: 'Coretan', highlighter: 'Stabilo', shape: 'Bentuk', text: 'Teks', image: 'Gambar', signature: 'Tanda tangan', mark: 'Tanda', redact: 'Sensor' }
  },
  obj: { duplicate: 'Duplikat', delete: 'Hapus', bold: 'Tebal', align: 'Perataan', smaller: 'Perkecil teks', larger: 'Perbesar teks', editText: 'Ubah teks', fill: 'Isi', noFill: 'Tanpa isi', blackout: 'Hitam', whiteout: 'Putih', typeHere: 'Ketik di sini…' },
  find: { placeholder: 'Cari di dokumen…', none: 'Tidak ditemukan', of: '{i} dari {n}', prev: 'Sebelumnya', next: 'Berikutnya', close: 'Tutup', needsOcr: 'Jalankan OCR dulu untuk mencari teks.' },
  presets: {
    office: { title: 'Dokumen kantor', desc: 'Latar kertas bersih, teks tajam, stempel warna dipertahankan.' },
    ktp: { title: 'KTP 2-in-1', desc: 'Sisi depan + belakang KTP pada satu lembar A4.' },
    archive: { title: 'Arsip (hitam-putih)', desc: 'Hitam-putih murni untuk berkas sangat ringan.' },
    photo: { title: 'Foto / warna asli', desc: 'Tanpa pemrosesan, warna alami.' }
  },
  filters: { none: 'Asli', clean: 'Bersih', bw: 'Hitam-putih', gray: 'Abu-abu', dual_layer: 'Teks + stempel', color: 'Vivid' },
  scan: {
    preset: 'Preset', paper: 'Kertas', dpi: 'Resolusi', recommended: 'disarankan', color: 'Warna', colorMode: 'Warna', gray: 'Abu-abu', source: 'Sumber', flatbed: 'Flatbed',
    scanPage: 'Pindai halaman', scanning: 'Memindai…', phasePrepare: 'Menyiapkan scanner…', phaseScanning: 'Memindai halaman…', phaseTransfer: 'Mentransfer ke perangkat ini…',
    busy: 'Scanner sedang dipakai oleh {holder}. Coba lagi dalam {sec} detik.', failed: 'Pemindaian gagal.',
    privacyNote: 'Hub menghapus salinannya begitu halaman tiba di sini.'
  },
  import: { drop: 'Seret gambar ke sini', browse: 'Pilih berkas', camera: 'Kamera', note: '*HEIC didukung bila browser bisa mendekodenya (ChromeOS, Android).' },
  enhance: { quick: 'Tampilan cepat', mode: 'Mode', bgClean: 'Pemutihan kertas', contrast: 'Kontras', brightness: 'Kecerahan', reset: 'Reset', applyAll: 'Terapkan ke semua halaman' },
  crop: {
    hint: 'Seret pegangan pada halaman untuk mengatur potongan. Luruskan dengan slider atau otomatis.',
    rotate: 'Putar & luruskan', autoDeskew: 'Luruskan otomatis', deskewing: 'Mendeteksi…', straighten: 'Luruskan', ratio: 'Preset potong',
    presets: { full: 'Satu halaman', a4: 'A4', card: 'Kartu ID', square: 'Persegi' }, apply: 'Terapkan potongan', clear: 'Hapus potongan'
  },
  ktp: {
    hint: 'Tandai satu halaman sebagai sisi depan dan satu sebagai sisi belakang. Setiap kartu dideteksi, dipotong, dan diletakkan pada lembar A4 putih.',
    useCurrent: 'Pakai halaman ini', outputDpi: 'Resolusi lembar', compose: 'Buat lembar 2-in-1', composing: 'Menyusun…'
  },
  roles: { front: 'Depan', back: 'Belakang', sheet: '2-in-1', normal: '' },
  rail: {
    pages: 'Halaman', selectAll: 'Pilih semua', clear: 'Bersihkan', selected: 'dipilih', empty: 'Pindai atau impor halaman untuk memulai.',
    page: 'Halaman', dragHint: 'Seret untuk mengurutkan', moveUp: 'Naik', moveDown: 'Turun', duplicate: 'Duplikat'
  },
  stage: {
    emptyTitle: 'Belum ada yang ditampilkan', emptyDesc: 'Gunakan Pindai atau Impor pada dock di bawah untuk menambah halaman pertama.',
    rendering: 'Merender', original: 'Asli', zoomIn: 'Perbesar', zoomOut: 'Perkecil', fit: 'Pas ke layar', compare: 'Tahan untuk membandingkan dengan asli'
  },
  export: {
    title: 'Ekspor dokumen', format: 'Format', scope: 'Halaman', allPages: 'Semua', selected: 'Dipilih', quality: 'Kualitas', qHigh: 'Tinggi', qBalanced: 'Seimbang', qSmall: 'Kecil',
    pageSize: 'Ukuran halaman', fitPaper: 'Pas ke kertas', trueSize: 'Ukuran pindaian', filename: 'Nama berkas', zipHint: 'Beberapa halaman dikemas dalam satu berkas ZIP.',
    saveAs: 'Simpan sebagai…', download: 'Unduh', working: 'Merender…', done: 'Tersimpan.',
    fsaNote: 'Anda memilih lokasi berkas; tidak ada yang diunggah.', downloadNote: 'Berkas diunduh oleh browser; tidak ada yang diunggah.',
    searchable: 'Teks dapat dicari (OCR)', searchableHint: 'Menambahkan teks hasil OCR secara tak terlihat, sehingga PDF bisa dicari dan disalin.', textOnlyHint: 'Memakai teks hasil OCR. Halaman tanpa teks dilewati.', ocrMissing: '{n} halaman belum punya teks hasil OCR.', runOcr: 'Kenali sekarang', objectsNote: 'Coretan, tanda tangan, dan sensor dilukis ke halaman.'
  },
  print: { title: 'Cetak salinan', desc: 'Kirim {n} halaman ke printer hub pada kertas {paper}.', copies: 'Salinan', send: 'Cetak', sending: 'Mengirim…', noPrinter: 'Saat ini tidak ada printer yang terhubung ke hub.' },
  workbench: { notFound: 'Dokumen ini sudah tidak ada di perangkat ini.', backToLibrary: 'Kembali ke dokumen' },
  toasts: {
    noImages: 'Pilih berkas gambar (JPG, PNG, WEBP).', imported: '{n} halaman diimpor.', scanned: 'Halaman {n} dipindai.',
    duplicated: 'Dokumen diduplikasi.', deleted: 'Dokumen dihapus.', appliedAll: 'Tampilan diterapkan ke semua halaman.',
    deskewed: 'Diluruskan {deg}°.', deskewFailed: 'Kemiringan tidak terdeteksi.', ktpDone: 'Lembar 2-in-1 ditambahkan sebagai halaman baru.', ktpFailed: 'Gagal menyusun lembar.',
    exported: '{name} tersimpan.', printed: 'Terkirim ke printer.', printFailed: 'Pencetakan gagal.', drawingsCleared: 'Coretan di hal. {n} dihapus.'
  }
};
