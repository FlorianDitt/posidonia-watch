// Month timeline brush for the map panel: one bar per calendar month, drag (or arrow keys) to pick a range.
// The selected range is drawn as a window with handles: drag a handle to resize it, drag inside it to move it.

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
  opts: {
    interactive: boolean;
    title: (c: number) => string;
    /** Text shown inside the selection window. */
    label: (r: [number, number]) => string;
    onChange: (r: Range) => void;
  },
): Timeline {
  const n = months.length;
  let values: number[] = new Array(n).fill(NaN);
  let range: Range = null;
  let isActive: (c: number) => boolean = () => true;
  /** True while the pointer drags the range, so echoes of our own onChange don't scroll the view. */
  let dragging = false;

  // Each month gets a fixed slot, so long spans scroll sideways instead of shrinking the bars.
  root.innerHTML = `
    <div class="tl-scroll">
      <div class="tl-track" style="min-width:max(100%, ${n * MONTH_PX}px)">
        <div class="tl-plot">
          <div class="tl-axis" aria-hidden="true">${axisLabels(months)}</div>
          <div class="tl-win" hidden></div>
          <div class="tl-bars" ${opts.interactive ? 'tabindex="0"' : 'aria-disabled="true"'}>
            ${months.map((_, c) => `<div class="tl-bar" data-c="${c}"><span></span></div>`).join('')}
          </div>
          <div class="tl-frame" hidden aria-hidden="true">
            <span class="tl-handle" data-h="0"></span><span class="tl-handle" data-h="1"></span><span class="tl-win-label"></span>
          </div>
        </div>
      </div>
    </div>`;
  const scrollEl = root.querySelector<HTMLElement>('.tl-scroll')!;
  const plotEl = root.querySelector<HTMLElement>('.tl-plot')!;
  const winEl = root.querySelector<HTMLElement>('.tl-win')!;
  const winLabel = root.querySelector<HTMLElement>('.tl-win-label')!;
  const frameEl = root.querySelector<HTMLElement>('.tl-frame')!;
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
      b.classList.toggle('tl-in', range !== null && range[1] > range[0] && inRange);
      b.title = opts.title(c);
    });
    winEl.hidden = frameEl.hidden = range === null;
    if (range === null) return;
    for (const el of [winEl, frameEl]) {
      el.style.left = `${(range[0] / n) * 100}%`;
      el.style.width = `${((range[1] - range[0] + 1) / n) * 100}%`;
    }
    winLabel.textContent = opts.label(range);
  }

  /** Scroll the range into view (centred) unless it is already fully visible. */
  function reveal(r: Range) {
    if (r === null) return;
    const { scrollLeft, clientWidth } = scrollEl;
    const offset = barsEl.getBoundingClientRect().left - scrollEl.getBoundingClientRect().left + scrollLeft;
    const w = barsEl.clientWidth / n;
    const left = offset + r[0] * w;
    const right = offset + (r[1] + 1) * w;
    if (left >= scrollLeft && right <= scrollLeft + clientWidth) return;
    scrollEl.scrollTo({ left: (left + right) / 2 - clientWidth / 2, behavior: 'smooth' });
  }

  if (opts.interactive) {
    // 'new': drag out a fresh range from `anchor`; 'resize': same, anchored at the edge opposite the handle;
    // 'move': slide the whole range by the distance from `grab`.
    let mode: 'new' | 'resize' | 'move' | null = null;
    let anchor = -1;
    let grab = -1;
    let start: [number, number] = [0, 0];
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
    const end = () => { mode = null; requestAnimationFrame(() => { dragging = false; }); };
    const same = (a: Range, b: [number, number]) => a !== null && a[0] === b[0] && a[1] === b[1];

    plotEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const c = at(e.clientX);
      const handle = (e.target as HTMLElement).closest<HTMLElement>('.tl-handle');
      before = range;
      moved = false;
      if (handle && range) {
        mode = 'resize';
        anchor = handle.dataset.h === '0' ? range[1] : range[0];
        moved = true;
      } else if (range && range[1] > range[0] && c >= range[0] && c <= range[1]) {
        mode = 'move';
        grab = c;
        start = range;
      } else {
        mode = 'new';
        anchor = c;
        set([c, c]);
      }
      dragging = true;
      plotEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    plotEl.addEventListener('pointermove', (e) => {
      if (mode === null) return;
      const c = at(e.clientX);
      let next: [number, number];
      if (mode === 'move') {
        if (c === grab && !moved) return;
        moved = true;
        const len = start[1] - start[0];
        const s0 = Math.min(n - 1 - len, Math.max(0, start[0] + c - grab));
        next = [s0, s0 + len];
      } else {
        if (c !== anchor) moved = true;
        next = [Math.min(anchor, c), Math.max(anchor, c)];
      }
      if (!same(range, next)) set(next);
    });
    plotEl.addEventListener('pointerup', () => {
      if (mode === null) return;
      // a click inside a multi-month range picks that month; clicking the single selected month again clears it
      if (mode === 'move' && !moved) set([grab, grab]);
      else if (mode === 'new' && !moved && before && before[0] === anchor && before[1] === anchor) set(null);
      end();
    });
    // touch swipes on the bars scroll the timeline (touch-action: pan-x), which cancels the pointer
    plotEl.addEventListener('pointercancel', () => {
      if (mode === null) return;
      set(before);
      end();
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
    setRange(r) {
      // only external changes (year picker, reset) scroll; the pointer already shows where the range is
      const external = !dragging && !(r === range || (r && range && r[0] === range[0] && r[1] === range[1]));
      range = r;
      paint();
      if (external) reveal(r);
    },
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
