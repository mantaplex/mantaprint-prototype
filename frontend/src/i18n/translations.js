/**
 * MantaPrint Hub — central localization dictionary.
 * Languages: 'en' (default) and 'id' (Bahasa Indonesia).
 *
 *   common.*  shared words
 *   hub.*     homepage            (./ui.js)
 *   adm.*     admin console       (./ui.js)
 *   studio.*  MantaPageScan Studio (../scan/i18n.js)
 */
import { studioEn, studioId } from '../scan/i18n.js';
import { hubEn, hubId, admEn, admId } from './ui.js';

export const translations = {
  en: {
    common: {
      "appName": "MantaPrint Hub",
      "save": "Save",
      "apply": "Apply Changes",
      "cancel": "Cancel",
      "delete": "Delete",
      "close": "Close",
      "loading": "Loading...",
      "refresh": "Refresh",
      "status": "Status",
      "online": "Online",
      "offline": "Offline",
      "ready": "Ready",
      "busy": "Busy",
      "error": "Error",
      "success": "Success",
      "active": "Active",
      "inactive": "Inactive",
      "reboot": "Reboot System",
      "rebootPrompt": "Are you sure you want to reboot the MantaPrint Hub appliance?",
      "rebooting": "Rebooting system...",
      "rebootInitiated": "Appliance reboot initiated. The system will come back online shortly.",
      "copy": "Copy",
      "copied": "Copied"
    },
    hub: hubEn,
    adm: admEn,
    studio: studioEn
  },
  id: {
    common: {
      "appName": "MantaPrint Hub",
      "save": "Simpan",
      "apply": "Terapkan Perubahan",
      "cancel": "Batal",
      "delete": "Hapus",
      "close": "Tutup",
      "loading": "Memuat...",
      "refresh": "Segarkan",
      "status": "Status",
      "online": "Online",
      "offline": "Offline",
      "ready": "Siap",
      "busy": "Sibuk",
      "error": "Kesalahan",
      "success": "Berhasil",
      "active": "Aktif",
      "inactive": "Tidak Aktif",
      "reboot": "Reboot Sistem",
      "rebootPrompt": "Apakah Anda yakin ingin me-reboot perangkat MantaPrint Hub?",
      "rebooting": "Memulai reboot sistem...",
      "rebootInitiated": "Reboot sistem sedang berjalan. Perangkat akan segera online kembali.",
      "copy": "Salin",
      "copied": "Tersalin"
    },
    hub: hubId,
    adm: admId,
    studio: studioId
  }
};
