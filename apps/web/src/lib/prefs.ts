/** Per-browser UI preferences. Holds no credentials or business data. */

export type ThemePref = 'light' | 'dark' | 'system';
export type SendKey = 'enter' | 'mod-enter';

const read = (key: string) => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
};

export const prefs = {
  theme: (): ThemePref => {
    const v = read('prowess-theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  },
  setTheme(theme: ThemePref) {
    write('prowess-theme', theme === 'system' ? null : theme);
    document.documentElement.dataset.theme = theme;
  },
  sendKey: (): SendKey => (read('prowess-send-key') === 'mod-enter' ? 'mod-enter' : 'enter'),
  setSendKey: (v: SendKey) => write('prowess-send-key', v),
  sidebarCollapsed: () => read('prowess-sidebar') === 'collapsed',
  setSidebarCollapsed: (v: boolean) => write('prowess-sidebar', v ? 'collapsed' : null),
  /** Development only: selects a fictitious user; ignored by the server outside AUTH_MODE=dev. */
  devUser: () => read('prowess-dev-user'),
  setDevUser: (v: string | null) => write('prowess-dev-user', v),
};
