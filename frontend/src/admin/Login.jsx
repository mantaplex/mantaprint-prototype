import React, { useState } from 'react';
import { ArrowLeft, Loader2, LogIn, Shield } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext.jsx';
import AppHeader from '../shell/AppHeader.jsx';
import { Button, Field, TextInput } from '../ui/index.js';
import { ADMIN_TOKEN_KEY } from '../shell/api.js';

export default function Login({ onSuccess, onCancel }) {
  const { t } = useI18n();
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.trim(), password: pass }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success || !json.token) throw new Error(t('adm.login.invalid'));
      try { localStorage.setItem(ADMIN_TOKEN_KEY, json.token); } catch {}
      onSuccess(json.token, json.user || user.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[#070a11] text-slate-100 flex flex-col">
      <AppHeader
        leading={
          <button type="button" onClick={onCancel} className="h-9 w-9 rounded-xl hover:bg-white/10 flex items-center justify-center text-slate-300" aria-label={t('adm.header.home')}>
            <ArrowLeft className="w-4 h-4" />
          </button>
        }
      />
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <form onSubmit={submit} className="w-full max-w-sm rounded-3xl bg-slate-900/70 border border-white/[0.07] p-6 sm:p-7">
          <div className="h-11 w-11 rounded-2xl bg-manta-500/10 border border-manta-500/25 text-manta-300 flex items-center justify-center"><Shield className="w-5 h-5" /></div>
          <h1 className="mt-4 text-lg font-extrabold">{t('adm.login.title')}</h1>
          <p className="text-xs text-slate-400 mt-1">{t('adm.login.desc')}</p>
          <div className="mt-5 space-y-3">
            <Field label={t('adm.login.username')}><TextInput autoFocus autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} /></Field>
            <Field label={t('adm.login.password')}><TextInput type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
          </div>
          {error && <p className="mt-3 text-xs text-rose-300" role="alert">{error}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full mt-5" icon={busy ? Loader2 : LogIn} disabled={busy || !user || !pass}>{t('adm.login.submit')}</Button>
          <p className="mt-4 text-[11px] leading-relaxed text-amber-200/80">
            Prototype software: traffic to this hub is unencrypted HTTP and the default password is shared by every install.
            Change it after signing in and keep this hub on an isolated network.
          </p>
        </form>
      </main>
    </div>
  );
}
