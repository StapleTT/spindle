import { type CSSProperties, useEffect, useId, useState } from 'react';
import { contrast, darkMode, lightMode } from './icons.js';
import {
  nextTheme,
  readTheme,
  saveTheme,
  type ThemePreference,
  watchTheme,
} from './theme.js';

// Spindle mark from the Claude Design export (SpindleLogo.dc.html). Colour comes
// from `currentColor`, so callers set it with CSS (normally var(--primary)).
const shape = 'translate(24 24) scale(0.86) translate(-22.4 -25)';
const waist =
  'M20.6 21.9C22 22.5 23 22.9 24.2 23.4C25.4 23.9 26.4 24.2 27.6 24.7';
export function SpindleLogo({ size = 34 }: { size?: number }) {
  const id = useId();
  return (
    <svg
      className="spindle-logo"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <mask
          id={`${id}s`}
          maskUnits="userSpaceOnUse"
          x="-10"
          y="-10"
          width="68"
          height="68"
        >
          <rect x="-10" y="-10" width="68" height="68" fill="#fff" />
          <g transform={shape}>
            <path
              d="M26.8 4.6L23 44.6L19.6 44.2Z"
              fill="#000"
              stroke="#000"
              strokeWidth="3.4"
              strokeLinejoin="round"
            />
            <rect x="0" y="17" width="48" height="14" fill="#fff" />
          </g>
        </mask>
        <mask
          id={`${id}m`}
          maskUnits="userSpaceOnUse"
          x="-10"
          y="-10"
          width="68"
          height="68"
        >
          <rect x="-10" y="-10" width="68" height="68" fill="#fff" />
          <path
            d={waist}
            transform={shape}
            stroke="#000"
            strokeWidth="8"
            strokeLinecap="round"
          />
        </mask>
      </defs>
      <g mask={`url(#${id}s)`}>
        <path
          d="M33 16.5C34 13.5 32.5 10.5 29.5 9.3C27.8 8.6 26 8.4 24 8.4C18.5 8.4 15 11.3 15 15.5C15 19.9 19.4 21.6 24.2 23.4C29.6 25.4 34.8 27.6 34.8 33C34.8 37 30.8 39.6 25 39.6C20 39.6 14.6 39.2 10 37.8"
          transform={shape}
          stroke="currentColor"
          strokeWidth="4.6"
          strokeLinecap="round"
        />
      </g>
      <g mask={`url(#${id}m)`}>
        <g transform={shape}>
          <path
            d="M26.8 4.6L23 44.6L19.6 44.2Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M15.6 43.5L27 45.3"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </g>
      </g>
      <path
        d={waist}
        transform={shape}
        stroke="currentColor"
        strokeWidth="4.6"
        strokeLinecap="butt"
      />
    </svg>
  );
}

// Material Symbols Rounded, drawn as a CSS mask so the icon follows currentColor.
export function Icon({ src }: { src: string }) {
  return (
    <span
      className="icon"
      aria-hidden="true"
      style={{ '--icon': `url("${src}")` } as CSSProperties}
    />
  );
}

const themeIcons = { system: contrast, light: lightMode, dark: darkMode };
function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  useEffect(() => watchTheme(setTheme), []);
  return [
    theme,
    (next: ThemePreference) => {
      saveTheme(next);
      setTheme(next);
    },
  ] as const;
}

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = nextTheme(theme);
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
      onClick={() => setTheme(next)}
    >
      <Icon src={themeIcons[theme]} />
    </button>
  );
}

// Settings › Appearance segmented control.
export function ThemeChoice() {
  const [theme, setTheme] = useTheme();
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">Theme</legend>
      {(['system', 'light', 'dark'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
        >
          <Icon src={themeIcons[option]} />
          {option[0]?.toUpperCase()}
          {option.slice(1)}
        </button>
      ))}
    </fieldset>
  );
}

const accents = 4;
// Account colour slot (1–4) by position, matching the drawer order.
export const accent = (index: number) => (index % accents) + 1;

export const initials = (name: string) =>
  name
    .replace(/["<].*$/, '')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('') || '?';

// List timestamps: time today, "Yesterday", then a short date.
export function shortTime(value: string) {
  const date = new Date(value);
  const today = new Date();
  const days = Math.round(
    (new Date(today.toDateString()).getTime() -
      new Date(date.toDateString()).getTime()) /
      86400000,
  );
  if (days === 0)
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
