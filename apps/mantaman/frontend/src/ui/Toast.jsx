import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random().toString(36).slice(2, 6);
    setToasts((prev) => [...prev, { id, message, type }]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2.5 max-w-sm w-full pointer-events-none px-4 sm:px-0">
        {toasts.map((toast) => {
          const typeConfig = {
            success: {
              icon: CheckCircle2,
              border: 'border-manta-500/40',
              bg: 'bg-slate-900/95',
              text: 'text-manta-300',
              iconColor: 'text-manta-400'
            },
            error: {
              icon: AlertCircle,
              border: 'border-rose-500/40',
              bg: 'bg-slate-900/95',
              text: 'text-rose-200',
              iconColor: 'text-rose-400'
            },
            warning: {
              icon: AlertTriangle,
              border: 'border-amber-500/40',
              bg: 'bg-slate-900/95',
              text: 'text-amber-200',
              iconColor: 'text-amber-400'
            },
            info: {
              icon: Info,
              border: 'border-white/10',
              bg: 'bg-slate-900/95',
              text: 'text-slate-200',
              iconColor: 'text-cyan-400'
            }
          };
          const cfg = typeConfig[toast.type] || typeConfig.info;
          const Icon = cfg.icon;

          return (
            <div
              key={toast.id}
              className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-2xl ${cfg.bg} border ${cfg.border} shadow-2xl backdrop-blur-md animate-slide-up text-xs font-sans`}
            >
              <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${cfg.iconColor}`} />
              <div className={`flex-1 min-w-0 ${cfg.text} leading-relaxed font-medium`}>
                {toast.message}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="text-slate-500 hover:text-white shrink-0 p-0.5 rounded transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      showToast: (msg) => console.log('[Toast fallback]', msg)
    };
  }
  return ctx;
}
