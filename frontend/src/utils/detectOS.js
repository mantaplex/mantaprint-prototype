/**
 * Utility to automatically detect user's client operating system
 */
export function detectOS() {
  if (typeof window === 'undefined' || !navigator) return 'android';

  const userAgent = navigator.userAgent || navigator.vendor || window.opera || '';
  const platform = navigator.platform || '';

  // Android detection
  if (/android/i.test(userAgent)) {
    return 'android';
  }

  // iOS detection (iPhone, iPad, iPod)
  if (/iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }

  // macOS
  if (/Macintosh|MacIntel|MacPPC|Mac68K/i.test(userAgent) && navigator.maxTouchPoints <= 1) {
    return 'macos';
  }

  // Windows
  if (/Win32|Win64|Windows|WinCE/i.test(userAgent)) {
    return 'windows';
  }

  // Chrome OS
  if (/CrOS/.test(userAgent)) {
    return 'chromeos';
  }

  // Linux
  if (/Linux/i.test(platform) && !/android/i.test(userAgent)) {
    return 'linux';
  }

  return 'android'; // Default fallback
}
