import { useEffect, useRef, useState } from 'react';

const currentTheme = () =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

type ThemedContent = { source: string; url: string; theme: string };

export function useThemedContentUrl(
  url: string | null,
  renew: (signal: AbortSignal) => Promise<string>,
) {
  const initial = useRef({ url, theme: currentTheme() });
  if (initial.current.url !== url)
    initial.current = { url, theme: currentTheme() };
  const [replacement, setReplacement] = useState<ThemedContent | null>(null);
  const selected = replacement?.source === url ? replacement : null;
  const theme = selected?.theme ?? initial.current.theme;
  const latest = useRef({ url, renew, theme });
  latest.current = { url, renew, theme };
  useEffect(() => {
    let request: AbortController | undefined;
    const observer = new MutationObserver(() => {
      const next = currentTheme(),
        source = latest.current.url;
      if (!source || next === latest.current.theme) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      // Renew through the authenticated API before reloading an expired content grant.
      void latest.current
        .renew(controller.signal)
        .then((fresh) => {
          if (
            !controller.signal.aborted &&
            latest.current.url === source &&
            currentTheme() === next
          )
            setReplacement({ source, url: fresh, theme: next });
        })
        .catch(() => {
          /* Keep the readable cached frame during an outage. */
        });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      observer.disconnect();
      request?.abort();
    };
  }, []);
  const source = selected?.url ?? url;
  if (!source) return null;
  const themed = new URL(source);
  themed.searchParams.set('theme', theme);
  return themed.href;
}
