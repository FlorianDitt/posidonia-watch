// Dropdown for the map panel, styled like the rest of the panel (a native <select> pops up an OS-styled list).
// Markup is rendered by the page: .dd > button.dd-btn (with .dd-value) + ul.dd-list[role=listbox] > li[role=option][data-value].

export interface Select {
  /** Shows the option with this value, or `fallback` in the button when no option matches (e.g. a custom range). */
  setValue(value: string | null, fallback?: string): void;
  setDisabled(disabled: boolean): void;
}

export function createSelect(root: HTMLElement, onChange: (value: string) => void): Select {
  const btn = root.querySelector<HTMLButtonElement>('.dd-btn')!;
  const valueEl = root.querySelector<HTMLElement>('.dd-value')!;
  const list = root.querySelector<HTMLUListElement>('.dd-list')!;
  const options = Array.from(list.querySelectorAll<HTMLLIElement>('[role="option"]'));
  let value: string | null = options.find((o) => o.getAttribute('aria-selected') === 'true')?.dataset.value ?? null;
  let active = -1;

  const isOpen = () => !list.hidden;

  function setActive(k: number) {
    active = Math.max(0, Math.min(options.length - 1, k));
    options.forEach((o, i) => o.classList.toggle('dd-active', i === active));
    list.setAttribute('aria-activedescendant', options[active].id);
    options[active].scrollIntoView({ block: 'nearest' });
  }

  /**
   * Fixed positioning so the list is not clipped by the scrolling panel; opens upwards when there is no room below.
   * Its height is capped to the room on that side, so it never runs off-screen (and it scrolls itself, not the page).
   */
  function place() {
    const r = btn.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    list.style.maxHeight = '';
    const below = window.innerHeight - r.bottom;
    const h = Math.min(list.scrollHeight, 320);
    const up = below < h + 8 && r.top > below;
    if (up) {
      list.style.top = '';
      list.style.bottom = `${window.innerHeight - r.top + 4}px`;
    } else {
      list.style.bottom = '';
      list.style.top = `${r.bottom + 4}px`;
    }
    list.style.maxHeight = `${Math.min(320, Math.max(64, (up ? r.top : below) - 12))}px`;
  }

  function open() {
    if (btn.disabled || isOpen()) return;
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    setActive(Math.max(0, options.findIndex((o) => o.dataset.value === value)));
    list.focus();
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
  }

  function close() {
    if (!isOpen()) return;
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
  }

  const onOutside = (e: Event) => { if (!root.contains(e.target as Node)) close(); };
  const onScroll = (e: Event) => { if (e.target !== list) close(); };

  function choose(k: number) {
    close();
    btn.focus();
    const v = options[k].dataset.value!;
    if (v !== value) { api.setValue(v); onChange(v); }
  }

  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  list.addEventListener('keydown', (e) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive(active + 1),
      ArrowUp: () => setActive(active - 1),
      Home: () => setActive(0),
      End: () => setActive(options.length - 1),
      Enter: () => choose(active),
      ' ': () => choose(active),
      Escape: () => { close(); btn.focus(); },
      Tab: () => close(),
    };
    const f = keys[e.key];
    if (!f) return;
    if (e.key !== 'Tab') e.preventDefault();
    f();
  });
  options.forEach((o, k) => {
    o.addEventListener('pointermove', () => { if (active !== k) setActive(k); });
    o.addEventListener('click', () => choose(k));
  });

  const api: Select = {
    setValue(v, fallback = '') {
      value = v;
      const match = options.find((o) => o.dataset.value === v);
      options.forEach((o) => o.setAttribute('aria-selected', String(o === match)));
      valueEl.textContent = match ? match.textContent : fallback;
    },
    setDisabled(d) {
      btn.disabled = d;
      if (d) close();
    },
  };
  return api;
}
