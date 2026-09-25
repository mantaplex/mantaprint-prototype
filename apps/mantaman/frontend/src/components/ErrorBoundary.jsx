import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('MantaPool UI ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#070A0F] text-slate-100 flex items-center justify-center p-6 font-mono">
          <div className="max-w-lg w-full bg-slate-900 border border-rose-500/40 rounded-3xl p-6 shadow-2xl space-y-4 text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <AlertTriangle className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-white">MantaPool Console Render Exception</h2>
            <div className="p-3 bg-black/60 rounded-xl text-xs text-rose-300 text-left overflow-x-auto whitespace-pre-wrap border border-rose-950">
              {this.state.error?.message || 'Unknown runtime error'}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow flex items-center justify-center gap-2 mx-auto transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Muat Ulang Konsol</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
