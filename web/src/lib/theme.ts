// 'system' follows prefers-color-scheme; 'light'/'dark' are stored per browser and set data-theme on <html>,
// which global.css keys the palette on. Base.astro applies the stored choice inline before first paint.
// Listeners (the map's basemap) are told via a 'themechange' event on window.

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const BAR_COLOR = { light: '#f6f7f4', dark: '#0d1719' };

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function store(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked: the choice still applies for this page view
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  // both theme-color metas carry a media query, so a forced theme has to overwrite both
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = choice === 'system' ? BAR_COLOR[m.media.includes('dark') ? 'dark' : 'light'] : BAR_COLOR[choice];
  });
  window.dispatchEvent(new Event('themechange'));
}

/** Cycles system → light → dark on click; the button holds one icon per choice, marked data-icon. */
export function initThemeToggle(btn: HTMLButtonElement) {
  let choice = stored();
  const render = () => {
    const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    btn.querySelectorAll<SVGElement>('[data-icon]').forEach((i) => i.classList.toggle('hidden', i.dataset.icon !== choice));
    const text = `Theme: ${LABEL[choice]}. Switch to ${LABEL[next].toLowerCase()}`;
    btn.setAttribute('aria-label', text);
    btn.title = text;
  };
  apply(choice);
  render();
  btn.addEventListener('click', () => {
    choice = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    store(choice);
    apply(choice);
    render();
  });
}
