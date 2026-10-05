/** Light / dark / auto, per browser in localStorage, shown as `data-theme` on <html>; auto follows the OS. */
export type ThemePref = 'auto' | 'light' | 'dark';
export const THEME_PREFS: ThemePref[] = ['auto', 'light', 'dark'];

const KEY = 'synoikia.theme';

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function setTheme(pref: ThemePref) {
  try {
    if (pref === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage blocked: the choice still applies to this page */
  }
  applyTheme(pref);
}
