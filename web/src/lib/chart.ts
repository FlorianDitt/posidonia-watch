// Tiny hand-rolled SVG line chart (no dependencies, ~3 KB min).
// Features: nice y ticks, year ticks on x, crosshair + tooltip on pointer and keyboard (← →), resize-aware.
import { fmtInt, fmtMonth, escapeHtml } from './data';

export interface Series {
  label: string;
  values: (number | null)[];
  /** CSS colour, typically var(--series-1) */
  color: string;
  dashed?: boolean;
}

export interface ChartOptions {
  months: string[];
  series: Series[];
  height: number;
  yLabel: string;
  ariaLabel: string;
  compact?: boolean;
  /** Force a y maximum (shared scales across small multiples). */
  yMax?: number;
  /** Write series labels at the right end of each line. */
  directLabels?: boolean;
}

const NS = 'http://www.w3.org/2000/svg';

function niceStep(max: number, count: number): number {
  const raw = max / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

export function niceMax(max: number, count = 4): number {
  if (!(max > 0)) return 1;
  const step = Math.max(1, niceStep(max, count));
  return Math.ceil(max / step) * step;
}

const fmtTick = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : fmtInt(v));

export function lineChart(container: HTMLElement, opts: ChartOptions): () => void {
  container.classList.add('relative');
  container.innerHTML = '';
  const tooltip = document.createElement('div');
  tooltip.className =
    'pointer-events-none absolute z-10 hidden min-w-36 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md tabular';
  tooltip.setAttribute('role', 'status');
  tooltip.setAttribute('aria-live', 'polite');

  let svg: SVGSVGElement | null = null;
  let activeIdx: number | null = null;
  let geom: { x: (i: number) => number; y: (v: number) => number; left: number; right: number; top: number; bottom: number; width: number } | null = null;

  const n = opts.months.length;

  function render() {
    const width = Math.max(240, container.clientWidth);
    const height = opts.height;
    const labelW = opts.directLabels ? Math.min(130, width * 0.28) : 0;
    const m = { top: 12, right: 12 + labelW, bottom: opts.compact ? 22 : 30, left: opts.compact ? 36 : 48 };
    const dataMax = Math.max(0, ...opts.series.flatMap((s) => s.values.map((v) => (v == null ? 0 : v))));
    const yMax = opts.yMax ?? niceMax(dataMax, opts.compact ? 2 : 4);
    const step = Math.max(1, niceStep(yMax, opts.compact ? 2 : 4));
    const x = (i: number) => m.left + (n <= 1 ? 0 : (i / (n - 1)) * (width - m.left - m.right));
    const y = (v: number) => m.top + (1 - v / yMax) * (height - m.top - m.bottom);
    geom = { x, y, left: m.left, right: width - m.right, top: m.top, bottom: height - m.bottom, width };

    const parts: string[] = [];
    // grid + y ticks
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`);
      parts.push(`<text x="${m.left - 6}" y="${y(v)}" dy="0.32em" text-anchor="end" fill="var(--muted)" font-size="11">${fmtTick(v)}</text>`);
    }
    // x ticks: January of each year (or first month), plus quarters when the range is short
    const short = n <= 15 && !opts.compact;
    opts.months.forEach((mo, i) => {
      const isJan = mo.endsWith('-01');
      const isQuarter = ['-04', '-07', '-10'].some((q) => mo.endsWith(q));
      if (!(isJan || i === 0 || (short && isQuarter))) return;
      if (i === 0 && !isJan && n > 1 && opts.months.findIndex((q) => q.endsWith('-01')) < 3 && opts.months.findIndex((q) => q.endsWith('-01')) >= 0) return;
      const label = isJan || i === 0 ? (short ? fmtMonth(mo) : mo.slice(0, 4)) : fmtMonth(mo).slice(0, 3);
      parts.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${height - m.bottom}" y2="${height - m.bottom + 4}" stroke="var(--muted)"/>`);
      parts.push(`<text x="${x(i)}" y="${height - m.bottom + 16}" text-anchor="middle" fill="var(--muted)" font-size="11">${escapeHtml(label)}</text>`);
    });
    parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${height - m.bottom}" y2="${height - m.bottom}" stroke="var(--muted)" stroke-width="1"/>`);
    // lines
    for (const s of opts.series) {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="4 3"' : ''}/>`);
    }
    // direct labels at last value, nudged apart
    if (opts.directLabels) {
      const ends = opts.series.map((s) => {
        let i = s.values.length - 1;
        while (i >= 0 && s.values[i] == null) i--;
        return { s, yy: i >= 0 ? y(s.values[i]!) : y(0) };
      }).sort((a, b) => a.yy - b.yy);
      for (let k = 1; k < ends.length; k++) if (ends[k].yy - ends[k - 1].yy < 14) ends[k].yy = ends[k - 1].yy + 14;
      for (const e of ends) {
        parts.push(`<circle cx="${width - m.right + 8}" cy="${e.yy}" r="4" fill="${e.s.color}"/>`);
        parts.push(`<text x="${width - m.right + 16}" y="${e.yy}" dy="0.32em" fill="var(--ink-2)" font-size="12">${escapeHtml(e.s.label)}</text>`);
      }
    }
    // y-axis label
    if (!opts.compact) {
      parts.push(`<text transform="translate(12 ${(m.top + height - m.bottom) / 2}) rotate(-90)" text-anchor="middle" fill="var(--muted)" font-size="11">${escapeHtml(opts.yLabel)}</text>`);
    }
    // crosshair layer
    parts.push('<g class="hover-layer"></g>');

    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', `0 0 ${width} ${height}`);
    el.setAttribute('width', String(width));
    el.setAttribute('height', String(height));
    el.setAttribute('role', 'img');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `${opts.ariaLabel}. Use left and right arrow keys to read monthly values.`);
    el.style.display = 'block';
    el.style.touchAction = 'pan-y';
    el.innerHTML = parts.join('');
    svg?.remove();
    svg = el;
    container.prepend(el);
    if (!tooltip.isConnected) container.append(tooltip);
    attach(el);
    if (activeIdx != null) show(activeIdx);
  }

  function show(i: number) {
    if (!svg || !geom || n === 0) return;
    activeIdx = Math.max(0, Math.min(n - 1, i));
    const g = svg.querySelector('.hover-layer')!;
    const cx = geom.x(activeIdx);
    let html = `<line x1="${cx}" x2="${cx}" y1="${geom.top}" y2="${geom.bottom}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2"/>`;
    for (const s of opts.series) {
      const v = s.values[activeIdx];
      if (v == null) continue;
      html += `<circle cx="${cx}" cy="${geom.y(v)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
    }
    g.innerHTML = html;
    tooltip.innerHTML =
      `<div class="mb-1 font-semibold text-ink">${escapeHtml(fmtMonth(opts.months[activeIdx]))}</div>` +
      opts.series
        .map((s) => `<div class="flex items-center gap-2"><span class="inline-block h-0.5 w-3" style="background:${s.color}"></span><span class="flex-1 text-ink-2">${escapeHtml(s.label)}</span><span class="font-medium text-ink">${fmtInt(s.values[activeIdx!])}</span></div>`)
        .join('');
    tooltip.classList.remove('hidden');
    const tw = tooltip.offsetWidth;
    const left = cx + 12 + tw > geom.width ? cx - 12 - tw : cx + 12;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = `${geom.top}px`;
  }

  function hide() {
    activeIdx = null;
    tooltip.classList.add('hidden');
    svg?.querySelector('.hover-layer')?.replaceChildren();
  }

  function idxFromEvent(e: PointerEvent): number {
    const rect = svg!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * geom!.width;
    const frac = (px - geom!.left) / Math.max(1, geom!.right - geom!.left);
    return Math.round(frac * (n - 1));
  }

  function attach(el: SVGSVGElement) {
    el.addEventListener('pointermove', (e) => show(idxFromEvent(e)));
    el.addEventListener('pointerdown', (e) => show(idxFromEvent(e)));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        show((activeIdx ?? (e.key === 'ArrowRight' ? -1 : n)) + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Escape') hide();
    });
  }

  render();
  let lastW = container.clientWidth;
  const ro = new ResizeObserver(() => {
    if (container.clientWidth !== lastW) { lastW = container.clientWidth; render(); }
  });
  ro.observe(container);
  return () => ro.disconnect();
}
