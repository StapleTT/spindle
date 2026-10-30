import alternateEmail from '@material-symbols/svg-400/rounded/alternate_email.svg';
import arrowForward from '@material-symbols/svg-400/rounded/arrow_forward.svg';
import bolt from '@material-symbols/svg-400/rounded/bolt.svg';
import businessCenter from '@material-symbols/svg-400/rounded/business_center.svg';
import check from '@material-symbols/svg-400/rounded/check.svg';
import cloud from '@material-symbols/svg-400/rounded/cloud.svg';
import contentCopy from '@material-symbols/svg-400/rounded/content_copy.svg';
import contrast from '@material-symbols/svg-400/rounded/contrast.svg';
import coronavirus from '@material-symbols/svg-400/rounded/coronavirus.svg';
import darkMode from '@material-symbols/svg-400/rounded/dark_mode.svg';
import devices from '@material-symbols/svg-400/rounded/devices.svg';
import dns from '@material-symbols/svg-400/rounded/dns.svg';
import draft from '@material-symbols/svg-400/rounded/draft.svg';
import editNote from '@material-symbols/svg-400/rounded/edit_note.svg';
import inbox from '@material-symbols/svg-400/rounded/inbox.svg';
import key from '@material-symbols/svg-400/rounded/key.svg';
import lightMode from '@material-symbols/svg-400/rounded/light_mode.svg';
import lock from '@material-symbols/svg-400/rounded/lock.svg';
import mail from '@material-symbols/svg-400/rounded/mail.svg';
import notificationsActive from '@material-symbols/svg-400/rounded/notifications_active.svg';
import outbox from '@material-symbols/svg-400/rounded/outbox.svg';
import search from '@material-symbols/svg-400/rounded/search.svg';
import shield from '@material-symbols/svg-400/rounded/shield.svg';
import stacks from '@material-symbols/svg-400/rounded/stacks.svg';
import terminal from '@material-symbols/svg-400/rounded/terminal.svg';
import undo from '@material-symbols/svg-400/rounded/undo.svg';
import verifiedUser from '@material-symbols/svg-400/rounded/verified_user.svg';
import webAssetOff from '@material-symbols/svg-400/rounded/web_asset_off.svg';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/jetbrains-mono';
import './landing.css';
import { nextTheme, readTheme, saveTheme, watchTheme } from './theme.js';

// Only icons imported here are bundled; add one before using a new data-icon.
const icons: Record<string, string> = {
  alternate_email: alternateEmail,
  arrow_forward: arrowForward,
  bolt: bolt,
  business_center: businessCenter,
  check: check,
  cloud: cloud,
  content_copy: contentCopy,
  contrast: contrast,
  coronavirus: coronavirus,
  dark_mode: darkMode,
  devices: devices,
  dns: dns,
  draft: draft,
  edit_note: editNote,
  inbox: inbox,
  key: key,
  light_mode: lightMode,
  lock: lock,
  mail: mail,
  notifications_active: notificationsActive,
  outbox: outbox,
  search: search,
  shield: shield,
  stacks: stacks,
  terminal: terminal,
  undo: undo,
  verified_user: verifiedUser,
  web_asset_off: webAssetOff,
};

function paintIcon(element: HTMLElement) {
  const url = icons[element.dataset.icon ?? ''];
  if (url) element.style.setProperty('--icon', `url("${url}")`);
}
for (const element of document.querySelectorAll<HTMLElement>('[data-icon]'))
  paintIcon(element);

const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
const toggleIcon = toggle?.querySelector<HTMLElement>('[data-icon]');
const themeIcons = {
  system: 'contrast',
  light: 'light_mode',
  dark: 'dark_mode',
};
function showTheme(theme = readTheme()) {
  if (!toggle || !toggleIcon) return;
  toggle.setAttribute(
    'aria-label',
    `Theme: ${theme}. Switch to ${nextTheme(theme)}`,
  );
  toggle.title = `Theme: ${theme}`;
  toggleIcon.dataset.icon = themeIcons[theme];
  paintIcon(toggleIcon);
}
toggle?.addEventListener('click', () => {
  const theme = nextTheme(readTheme());
  saveTheme(theme);
  showTheme(theme);
});
watchTheme(showTheme);
showTheme();

const header = document.querySelector('.site-header');
const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const tabs = [
  ...document.querySelectorAll<HTMLButtonElement>('[data-install-tab]'),
];
function selectTab(tab: HTMLButtonElement) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(
      item.getAttribute('aria-controls') ?? '',
    );
    if (panel) panel.hidden = !selected;
  }
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next =
      tabs[
        (tabs.indexOf(tab) +
          (event.key === 'ArrowRight' ? 1 : -1) +
          tabs.length) %
          tabs.length
      ];
    if (!next) return;
    selectTab(next);
    next.focus();
  });
}

const copy = document.querySelector<HTMLButtonElement>('[data-copy]');
const copyLabel = copy?.querySelector('[data-copy-label]');
copy?.addEventListener('click', async () => {
  const code = copy.parentElement?.querySelector('pre:not([hidden]) code');
  if (!code || !copyLabel) return;
  // Copies the commands only, without comment spans.
  const commands = [...code.childNodes]
    .filter((node) => !(node instanceof HTMLElement))
    .map((node) => node.textContent)
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  try {
    await navigator.clipboard.writeText(commands);
    copyLabel.textContent = 'Copied';
  } catch {
    copyLabel.textContent = 'Copy failed';
  }
  setTimeout(() => {
    copyLabel.textContent = 'Copy';
  }, 1600);
});
