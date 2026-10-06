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

  root.innerHTML = `
    <div class="tl-bars" ${opts.interactive ? 'tabindex="0"' : 'aria-disabled="true"'}>
      ${months.map((_, c) => `<div class="tl-bar" data-c="${c}"><span></span></div>`).join('')}
    </div>
    <div class="tl-axis" aria-hidden="true">${axisLabels(months)}</div>`;
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
    barsEl.addEventListener('pointercancel', end);

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
    });
  }

  paint();
  return {
    setValues(v) { values = v; paint(); },
    setRange(r) { range = r; paint(); },
    setActive(f) { isActive = f; paint(); },
  };
}

/** Year labels at each January, plus the first month when the first January is far enough away. */
function axisLabels(months: string[]): string {
  const n = months.length;
  const firstJan = months.findIndex((x) => x.endsWith('-01'));
  const out: string[] = [];
  months.forEach((m, c) => {
    const labelFirst = c === 0 && (firstJan < 0 || firstJan >= 3);
    if (!m.endsWith('-01') && !labelFirst) return;
    const pos = c / n;
    const style = pos > 0.85 ? 'right:0' : `left:${(pos * 100).toFixed(2)}%`;
    out.push(`<span style="${style}">${m.slice(0, 4)}</span>`);
  });
  return out.join('');
}
