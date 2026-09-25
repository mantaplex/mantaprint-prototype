import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export default function Toast({ toast, onClose, placement = 'default' }) {
  if (!toast) return null;

  const icons = {
    success: <CheckCircle2 className="w-5 h-5 text-manta-400 shrink-0" />,
    warning: <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />,
    error: <XCircle className="w-5 h-5 text-rose-400 shrink-0" />,
    info: <Info className="w-5 h-5 text-violet-300 shrink-0" />
  };

  const bgStyles = {
    success: 'bg-manta-950/80 border-manta-500/30 text-manta-100',
    warning: 'bg-amber-950/80 border-amber-500/30 text-amber-100',
    error: 'bg-rose-950/80 border-rose-500/30 text-rose-100',
    info: 'bg-violet-950/80 border-violet-500/30 text-violet-100'
  };

  return (
    <div className={`fixed z-50 max-w-md animate-bounce-short ${placement === 'above-dock' ? 'bottom-[108px] right-3 left-3 sm:left-auto sm:right-6' : 'bottom-6 right-6'}`}>
      <div className={`flex items-start gap-3 p-4 rounded-xl border shadow-2xl backdrop-blur-md ${bgStyles[toast.type || 'info']}`}>
        {icons[toast.type || 'info']}
        <div className="flex-1 text-sm font-medium pr-2">
          {toast.message}
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
