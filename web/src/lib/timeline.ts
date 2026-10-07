// Month timeline brush for the map panel: one bar per calendar month, drag (or arrow keys) to pick a range.

/** Inclusive [start, end] indices into the calendar, or null for "all months". */
export type Range = [number, number] | null;

export interface Timeline {
  setValues(values: number[]): void;
  setRange(range: Range): void;
  /** Months outside the active set (e.g. other seasons) are drawn muted even inside the range. */
  setActive(isActive: (c: number) => boolean): void;
}

/**
 * ``months`` is a continuous 'YYYY-MM' calendar; ``values[c]`` is NaN for months without data.
 * ``onChange`` fires (at most once per frame) while dragging and on every keyboard step.
 */
export function createTimeline(
  root: HTMLElement,
  months: string[],
  opts: { interactive: boolean; title: (c: number) => string; onChange: (r: Range) => void },
): Timeline {
  const n = months.length;
  let values: number[] = new Array(n).fill(NaN);
  let range: Range = null;
  let isActive: (c: number) => boolean = () => true;

  // Each month gets a fixed slot, so long spans scroll sideways instead of shrinking the bars.
  root.innerHTML = `
    <div class="tl-scroll">
      <div class="tl-track" style="min-width:max(100%, ${n * MONTH_PX}px)">
        <div class="tl-bars" ${opts.interactive ? 'tabindex="0"' : 'aria-disabled="true"'}>
          ${months.map((_, c) => `<div class="tl-bar" data-c="${c}"><span></span></div>`).join('')}
        </div>
        <div class="tl-axis" aria-hidden="true">${axisLabels(months)}</div>
      </div>
    </div>`;
  const scrollEl = root.querySelector<HTMLElement>('.tl-scroll')!;
  const barsEl = root.querySelector<HTMLElement>('.tl-bars')!;
  const bars = Array.from(barsEl.children) as HTMLElement[];

  function paint() {
    const max = Math.max(1, ...values.filter(Number.isFinite));
    bars.forEach((b, c) => {
      const v = values[c];
      const fill = b.firstElementChild as HTMLElement;
      const missing = !Number.isFinite(v);
      b.classList.toggle('tl-missing', missing);
      fill.style.height = missing ? '' : `${Math.max(v > 0 ? 6 : 2, (v / max) * 100)}%`;
      const inRange = range === null || (c >= range[0] && c <= range[1]);
      b.classList.toggle('tl-on', inRange && isActive(c));
      b.title = opts.title(c);
    });
  }

  /** Scroll the range into view (centred) unless it is already fully visible. */
  function reveal(r: Range) {
    if (r === null) return;
    const w = barsEl.clientWidth / n;
    const left = r[0] * w;
    const right = (r[1] + 1) * w;
    const { scrollLeft, clientWidth } = scrollEl;
    if (left >= scrollLeft && right <= scrollLeft + clientWidth) return;
    scrollEl.scrollTo({ left: (left + right) / 2 - clientWidth / 2, behavior: 'smooth' });
  }

  if (opts.interactive) {
    let anchor = -1;
    let before: Range = null;
    let moved = false;
    let frame = 0;
    const emit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => opts.onChange(range));
    };
    const at = (x: number) => {
      const r = barsEl.getBoundingClientRect();
      return Math.min(n - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * n)));
    };
    const set = (r: Range) => { range = r; paint(); emit(); };

    barsEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      barsEl.setPointerCapture(e.pointerId);
      anchor = at(e.clientX);
      before = range;
      moved = false;
      set([anchor, anchor]);
    });
    barsEl.addEventListener('pointermove', (e) => {
      if (anchor < 0) return;
      const c = at(e.clientX);
      if (c !== anchor) moved = true;
      if (range && range[0] === Math.min(anchor, c) && range[1] === Math.max(anchor, c)) return;
      set([Math.min(anchor, c), Math.max(anchor, c)]);
    });
    const end = () => {
      if (anchor < 0) return;
      // clicking the single selected month again clears the selection
      if (!moved && before && before[0] === anchor && before[1] === anchor) set(null);
      anchor = -1;
    };
    barsEl.addEventListener('pointerup', end);
    // touch swipes scroll the timeline (touch-action: pan-x), which cancels the pointer: undo the tap selection
    barsEl.addEventListener('pointercancel', () => {
      if (anchor < 0) return;
      anchor = -1;
      set(before);
    });

    barsEl.addEventListener('keydown', (e) => {
      const clamp = (c: number) => Math.min(n - 1, Math.max(0, c));
      let next: Range | undefined;
      if (e.key === 'Escape') next = null;
      else if (e.key === 'Home') next = [0, 0];
      else if (e.key === 'End') next = [n - 1, n - 1];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const d = e.key === 'ArrowRight' ? 1 : -1;
        if (range === null) next = [n - 1, n - 1];
        else if (e.shiftKey) next = [range[0], Math.max(range[0], clamp(range[1] + d))];
        else { const c = clamp((d > 0 ? range[1] : range[0]) + d); next = [c, c]; }
      }
      if (next === undefined) return;
      e.preventDefault();
      set(next);
      reveal(next);
    });
  }

  paint();
  // start at the most recent months
  requestAnimationFrame(() => { scrollEl.scrollLeft = scrollEl.scrollWidth; });
  return {
    setValues(v) { values = v; paint(); },
    setRange(r) { range = r; paint(); reveal(r); },
    setActive(f) { isActive = f; paint(); },
  };
}

/** Width of one month slot in px (bar + gap). */
const MONTH_PX = 10;

/** Year labels at each January, plus the first month when the first January is far enough away. */
function axisLabels(months: string[]): string {
  const n = months.length;
  const firstJan = months.findIndex((x) => x.endsWith('-01'));
  const out: string[] = [];
  months.forEach((m, c) => {
    const labelFirst = c === 0 && (firstJan < 0 || firstJan >= 3);
    if (!m.endsWith('-01') && !labelFirst) return;
    out.push(`<span style="left:${((c / n) * 100).toFixed(2)}%">${m.slice(0, 4)}</span>`);
  });
  return out.join('');
}
