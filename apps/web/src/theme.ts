// Theme preference shared by the app and landing page. The inline script in each
// HTML entry applies the same rule before first paint to avoid a wrong-theme flash.
export type ThemePreference = 'system' | 'light' | 'dark';
const key = 'spindle-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference = readTheme()) {
  const dark =
    preference === 'dark' || (preference === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function saveTheme(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, preference);
  } catch {
    /* The choice still applies to this page without storage. */
  }
  applyTheme(preference);
}

export const nextTheme = (preference: ThemePreference): ThemePreference =>
  preference === 'system'
    ? 'light'
    : preference === 'light'
      ? 'dark'
      : 'system';

// Follows system changes and choices made in other tabs.
export function watchTheme(onChange: (preference: ThemePreference) => void) {
  const update = () => {
    const preference = readTheme();
    applyTheme(preference);
    onChange(preference);
  };
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) update();
  };
  const query = media();
  query.addEventListener('change', update);
  window.addEventListener('storage', storage);
  return () => {
    query.removeEventListener('change', update);
    window.removeEventListener('storage', storage);
  };
}
