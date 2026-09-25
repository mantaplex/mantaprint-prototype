/**
 * Prototype disclosure shown across the hub web app (home, admin, MantaPageScan Studio).
 * MantaPrint is published as a prototype: the badge is always visible and opens the risk
 * notice; the admin console additionally asks for an acknowledgement once per browser.
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Modal, Button } from '../ui/index.js';

const ACK_KEY = 'mantaprint.prototypeAck.v1';
const REPO_URL = 'https://github.com/mantaplex/mantaprint-prototype';

export function PrototypeNoticeBody() {
  return (
    <div className="space-y-3 text-xs leading-relaxed text-slate-300">
      <p className="text-sm font-semibold text-amber-200">
        MantaPrint is an experimental prototype. It has not been hardened, audited or penetration-tested.
      </p>
      <div>
        <p className="font-semibold text-slate-100">Known weaknesses include</p>
        <ul className="mt-1 list-disc pl-4 space-y-0.5">
          <li>Plain HTTP: logins, admin tokens and scanned pages cross the network unencrypted.</li>
          <li>A shared default admin password until you change it.</li>
          <li>CUPS remote administration is open on the local network.</li>
          <li>Updates are downloaded without signature checks.</li>
          <li>MantaPool fleet management has incomplete authentication.</li>
        </ul>
      </div>
      <div>
        <p className="font-semibold text-slate-100">Do not use it</p>
        <ul className="mt-1 list-disc pl-4 space-y-0.5">
          <li>for personal or sensitive documents (ID cards, bank or health records);</li>
          <li>in production, financial or other regulated environments;</li>
          <li>on networks reachable from the internet or by untrusted users.</li>
        </ul>
      </div>
      <p className="text-slate-400">
        Provided "AS IS", without warranty of any kind (MIT License). You use it at your own risk.
        Details: <a className="text-manta-300 underline" href={`${REPO_URL}/blob/main/docs/KNOWN-LIMITATIONS.md`} target="_blank" rel="noreferrer">known limitations</a>
        {' · '}
        <a className="text-manta-300 underline" href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">security policy</a>
      </p>
    </div>
  );
}

/** Always-visible amber "PROTOTYPE" pill; opens the notice. */
export function PrototypeBadge({ className = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md bg-amber-400/15 border border-amber-400/40 text-amber-300 text-[10px] font-extrabold tracking-wider ${className}`}
        title="Prototype - not for production or sensitive data. Click for details."
      >
        <AlertTriangle className="w-3 h-3" aria-hidden />
        PROTOTYPE
      </button>
      {/* Portaled: the badge sits inside blurred sticky headers, which would clip a fixed-position dialog. */}
      {open && createPortal(
        <Modal open onClose={() => setOpen(false)} title="MantaPrint is a prototype" footer={<Button variant="primary" onClick={() => setOpen(false)}>Close</Button>}>
          <PrototypeNoticeBody />
        </Modal>,
        document.body
      )}
    </>
  );
}

function readAck() {
  try { return localStorage.getItem(ACK_KEY) === '1'; } catch { return false; }
}

/** One-time (per browser) acknowledgement dialog for the admin console. */
export function PrototypeAckDialog() {
  const [acked, setAcked] = useState(readAck);
  if (acked) return null;
  const accept = () => {
    try { localStorage.setItem(ACK_KEY, '1'); } catch {}
    setAcked(true);
  };
  return (
    <Modal open onClose={accept} title="Before you continue: this is a prototype" footer={<Button variant="primary" onClick={accept}>I understand the risks</Button>}>
      <PrototypeNoticeBody />
    </Modal>
  );
}
