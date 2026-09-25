import React, { createContext, useContext, useState, useEffect } from 'react';
import { translations } from './translations.js';

const I18nContext = createContext(null);

export function I18nProvider({ children, initialLanguage = 'en' }) {
  // System Language from appliance configuration / hardware backend
  const [systemLang, setSystemLang] = useState(() => {
    return ['en', 'id'].includes(initialLanguage) ? initialLanguage : 'en';
  });

  // User Session Language: strictly user-scoped in browser localStorage
  const [lang, setLangState] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('mantaprint_user_lang') || localStorage.getItem('mantaprint_language');
      if (stored && ['en', 'id'].includes(stored)) return stored;
    }
    return ['en', 'id'].includes(initialLanguage) ? initialLanguage : 'en';
  });

  // When appliance reports a change in system default language, update systemLang.
  // Crucial: NEVER overwrite user's chosen session language if already set in localStorage!
  useEffect(() => {
    if (initialLanguage && ['en', 'id'].includes(initialLanguage)) {
      setSystemLang(initialLanguage);
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem('mantaprint_user_lang') || localStorage.getItem('mantaprint_language');
        if (!stored) {
          // Only first-time visitors without explicit preference adopt the appliance default
          setLangState(initialLanguage);
        }
      }
    }
  }, [initialLanguage]);

  const setLanguage = (newLang) => {
    const valid = ['en', 'id'].includes(newLang) ? newLang : 'en';
    setLangState(valid);
    if (typeof window !== 'undefined') {
      localStorage.setItem('mantaprint_user_lang', valid);
      try { localStorage.removeItem('mantaprint_language'); } catch {}
    }
  };

  // Helper t('section.key', paramsOrFallback)
  const t = (keyPath, paramsOrFallback = {}) => {
    if (!keyPath) return '';
    const keys = keyPath.split('.');
    let curr = translations[lang] || translations.en;
    let found = true;
    for (const k of keys) {
      if (curr && typeof curr === 'object' && k in curr) {
        curr = curr[k];
      } else {
        found = false;
        break;
      }
    }

    if (!found) {
      // Fallback to English
      let enCurr = translations.en;
      for (const ek of keys) {
        if (enCurr && typeof enCurr === 'object' && ek in enCurr) {
          enCurr = enCurr[ek];
        } else {
          curr = typeof paramsOrFallback === 'string' ? paramsOrFallback : keyPath;
          break;
        }
      }
      if (typeof enCurr === 'string') {
        curr = enCurr;
      }
    }

    if (typeof curr === 'string' && paramsOrFallback && typeof paramsOrFallback === 'object') {
      return curr.replace(/{([^{}]+)}/g, (match, key) => {
        return paramsOrFallback[key] !== undefined ? paramsOrFallback[key] : match;
      });
    }

    return typeof curr === 'string' ? curr : (typeof paramsOrFallback === 'string' ? paramsOrFallback : keyPath);
  };

  return (
    <I18nContext.Provider value={{
      lang,
      systemLang,
      setLanguage,
      t,
      isId: lang === 'id',
      isEn: lang === 'en',
      isSystemId: systemLang === 'id',
      isSystemEn: systemLang === 'en'
    }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback if rendered outside provider
    return {
      lang: 'en',
      systemLang: 'en',
      setLanguage: () => {},
      t: (key) => key,
      isId: false,
      isEn: true,
      isSystemId: false,
      isSystemEn: true
    };
  }
  return ctx;
}
