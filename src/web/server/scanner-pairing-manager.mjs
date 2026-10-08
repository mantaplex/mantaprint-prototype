/**
 * MantaPrint Hub - Scanner Hardware Mutex Manager
 *
 * Provides ScannerHardwareLock: Asynchronous mutual exclusion lock with watchdog
 * for physical SANE / eSCL USB scanners used by MantaPage Scan Studio (/scan).
 */

import crypto from 'node:crypto';

/**
 * ScannerHardwareLock
 * Prevents concurrent SANE process execution which causes LIBUSB_ERROR_BUSY and motor jams.
 */
export class ScannerHardwareLock {
  constructor(timeoutMs = 90000) {
    this.locked = false;
    this.currentJob = null;
    this.lockAcquiredAt = 0;
    this.lockTimeoutMs = timeoutMs; // 90-second hardware watchdog
    this.activeProcess = null;
    this.watchdogTimer = null;
  }

  acquire(clientId, clientName = 'Scan Studio', options = {}) {
    const now = Date.now();

    // Auto-clear stale lock if previous scan timed out
    if (this.locked && (now - this.lockAcquiredAt > this.lockTimeoutMs)) {
      console.warn(`[ScannerLock] Auto-releasing stale scanner lock held by: ${this.currentJob?.clientName || 'Unknown'}`);
      this.forceRelease();
    }

    if (this.locked) {
      const elapsedSec = Math.round((now - this.lockAcquiredAt) / 1000);
      const estRemainingSec = Math.max(1, Math.round((this.lockTimeoutMs / 1000) - elapsedSec));
      return {
        acquired: false,
        error: 'SCANNER_BUSY',
        message: 'Scanner sedang digunakan oleh sesi lain.',
        holder: this.currentJob?.clientName || 'Sesi lain',
        elapsedSec,
        estimatedRemainingSec: estRemainingSec
      };
    }

    this.locked = true;
    this.lockAcquiredAt = now;
    this.currentJob = {
      jobId: `scan_${now}_${crypto.randomBytes(3).toString('hex')}`,
      clientId,
      clientName,
      options,
      startedAt: new Date(now).toISOString()
    };

    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.locked) {
        console.warn(`[ScannerLock] Watchdog timer fired: auto-releasing lock for ${this.currentJob?.clientName}`);
        this.forceRelease();
      }
    }, this.lockTimeoutMs);
    if (typeof this.watchdogTimer.unref === 'function') {
      this.watchdogTimer.unref();
    }

    return { acquired: true, job: this.currentJob };
  }

  registerActiveProcess(proc) {
    this.activeProcess = proc;
    if (proc && typeof proc.once === 'function') {
      proc.once('close', () => {
        if (this.activeProcess === proc) {
          this.activeProcess = null;
        }
      });
    }
  }

  release(clientId = null) {
    if (!this.locked) return true;
    if (clientId && this.currentJob && this.currentJob.clientId !== clientId) {
      console.warn(`[ScannerLock] Refusing release: Client ${clientId} is not lock holder (${this.currentJob.clientId})`);
      return false;
    }
    this.forceRelease();
    return true;
  }

  forceRelease() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.activeProcess && !this.activeProcess.killed) {
      try {
        this.activeProcess.kill('SIGKILL');
      } catch {}
    }
    this.locked = false;
    this.currentJob = null;
    this.lockAcquiredAt = 0;
    this.activeProcess = null;
  }

  getStatus() {
    if (!this.locked) {
      return { is_busy: false, holder: null };
    }
    const elapsedSec = Math.round((Date.now() - this.lockAcquiredAt) / 1000);
    return {
      is_busy: true,
      holder: this.currentJob?.clientName || 'Sesi lain',
      job_id: this.currentJob?.jobId,
      elapsed_sec: elapsedSec
    };
  }
}

export const scannerHardwareLock = new ScannerHardwareLock(90000);
