// Client-side map for the home page. Loaded only by src/pages/index.astro.
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import type * as GeoJSON from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 runs its tiles in a module worker; let Vite bundle it and tell MapLibre where it is.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import {
  loadJson, fmtInt, fmtNum, fmtMonth, escapeHtml, withBase,
  SEASON_LABEL, seasonOf,
  type Meta, type Hexes, type HexesMonthly, type Points, type Hotspot, type Timeseries, type Season,
} from './data';
import { countryName, setCountryNames } from './countries';
import { createTimeline, type Range } from './timeline';

maplibregl.setWorkerUrl(workerUrl);

type Metric = 'density' | 'on_posidonia' | 'large_on_posidonia';
type SeasonSel = 'ALL' | Season;

const MED_BBOX: [number, number, number, number] = [-6.0, 30.0, 36.5, 46.0];
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const POSIDONIA_MINZOOM = 8;
const POINTS_MINZOOM = 11;
/** Below this zoom hexes are drawn as centroid dots. */
const DOTS_MAXZOOM = 7;
const ATTRIBUTION =
  'Detections <a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">Global Fishing Watch</a> (CC0) · ' +
  'Seagrass <a href="https://emodnet.ec.europa.eu/en/seabed-habitats" target="_blank" rel="noopener">EMODnet</a> (CC-BY 4.0)';

const METRIC_LABEL: Record<Metric, (largeLen: number) => string> = {
  on_posidonia: () => 'Boats seen anchored on seagrass',
  large_on_posidonia: (l) => `Boats ≥ ${l} m anchored on seagrass`,
  density: () => 'Boats on seagrass per clear satellite image',
};

/** Fetch the basemap style; if OpenFreeMap is unreachable, fall back to a plain background so our data still renders. */
async function basemapStyle(): Promise<maplibregl.StyleSpecification | string> {
  const url = isDark() ? STYLE_DARK : STYLE_LIGHT;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as maplibregl.StyleSpecification;
  } catch (e) {
    console.warn('Basemap unavailable, using plain background', e);
    return {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': isDark() ? '#16252a' : '#dfe8ea' } }],
    };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () =>
  document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && darkQuery.matches);

interface State {
  metric: Metric;
  season: SeasonSel;
  showPosidonia: boolean;
  showPoints: boolean;
  /** Selected calendar months (indices into `calendar`), null = all. */
  range: Range;
}

const state: State = { metric: 'on_posidonia', season: 'ALL', showPosidonia: true, showPoints: true, range: null };

let meta: Meta | null = null;
let hexes: Hexes | null = null;
let monthly: HexesMonthly | null = null;
/** Continuous month calendar from the first to the last data month; idx points into meta.months (-1 = no data). */
let calendar: { month: string; idx: number }[] = [];
let hexIndex = new Map<string, number>();
let hexGeojson: GeoJSON.FeatureCollection | null = null;
let hexCentroids: GeoJSON.FeatureCollection | null = null;
let pointsGeojson: GeoJSON.FeatureCollection | null = null;
let posidoniaGeojson: GeoJSON.FeatureCollection | null = null;
let pointsLoading = false;
let posidoniaLoading = false;
let largeLen = 24;

function setStatus(msg: string | null) {
  const el = $('map-status');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<p class="pointer-events-auto max-w-sm rounded-lg bg-surface/95 px-4 py-3 text-center text-sm text-ink-2 shadow">${msg}</p>`;
}

// ---------- data -> features ----------

function buildHexGeojson(h: Hexes): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < h.h3.length; i++) {
    let ring: number[][];
    try { ring = cellToBoundary(h.h3[i], true); } catch { continue; }
    const props: Record<string, unknown> = { i, [VALUE_KEY]: null };
    features.push({ type: 'Feature', id: i, properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  return { type: 'FeatureCollection', features };
}

function buildPointsGeojson(p: Points): GeoJSON.FeatureCollection {
  const n = Math.min(p.lon?.length ?? 0, p.lat?.length ?? 0);
  const features: GeoJSON.Feature[] = new Array(n);
  for (let i = 0; i < n; i++) {
    features[i] = {
      type: 'Feature',
      properties: { m: p.month?.[i] ?? -1, L: p.length_m?.[i] ?? 0, c: p.country?.[i] ?? 'UNK' },
      geometry: { type: 'Point', coordinates: [p.lon[i], p.lat[i]] },
    };
  }
  return { type: 'FeatureCollection', features };
}

/** Quantile class breaks over positive, finite values. Returns ascending unique thresholds (<= 4). */
function quantileBreaks(values: number[], isCount: boolean): number[] {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return [];
  const qs = [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
  const rounded = qs.map((b) => (isCount ? Math.max(1, Math.ceil(b)) : Number(b.toPrecision(2))));
  const out: number[] = [];
  for (const b of rounded) if (b > (out.at(-1) ?? 0) && b <= v.at(-1)!) out.push(b);
  // first class starts at the minimum positive value; a break equal to it would create an empty class
  return out.filter((b) => b > v[0]);
}

/** Feature property holding the value currently shown (rewritten on every selection change). */
const VALUE_KEY = 'v';

interface Agg { on_posidonia: number[]; large_on_posidonia: number[]; density: number[] }
let aggCache: { key: string; agg: Agg } | null = null;

function buildCalendar(months: string[]): { month: string; idx: number }[] {
  if (!months.length) return [];
  const idx = new Map(months.map((m, k) => [m, k]));
  let [y, mo] = months[0].split('-').map(Number);
  const [ey, em] = months.at(-1)!.split('-').map(Number);
  const out: { month: string; idx: number }[] = [];
  while (y < ey || (y === ey && mo <= em)) {
    const m = `${y}-${String(mo).padStart(2, '0')}`;
    out.push({ month: m, idx: idx.get(m) ?? -1 });
    if (++mo > 12) { mo = 1; y++; }
  }
  return out;
}

/** meta.months indices inside the selected range and season, or null when nothing is filtered. */
function selectedMonthIdx(): number[] | null {
  if (state.range === null && state.season === 'ALL') return null;
  const [a, b] = state.range ?? [0, calendar.length - 1];
  const out: number[] = [];
  for (let c = a; c <= b; c++) {
    const e = calendar[c];
    if (e && e.idx >= 0 && (state.season === 'ALL' || seasonOf(e.month) === state.season)) out.push(e.idx);
  }
  return out;
}

/** Per-hex values for the current selection. */
function aggregate(): Agg {
  const h = hexes!;
  const sel = selectedMonthIdx();
  const key = sel === null ? 'all' : monthly ? sel.join(',') : `season:${state.season}`;
  if (aggCache?.key === key) return aggCache.agg;
  const num = (a: (number | null)[] | undefined) => (a ?? []).map((x) => (x == null ? NaN : x));
  const ratio = (on: number[], clear: number[] | undefined) => on.map((x, i) => (clear && clear[i] > 0 ? x / clear[i] : NaN));
  let agg: Agg;
  if (sel === null) {
    agg = { on_posidonia: num(h.on_posidonia), large_on_posidonia: num(h.large_on_posidonia), density: num(h.density) };
  } else if (monthly) {
    const n = h.h3.length;
    const M = monthly.months.length;
    const want = new Uint8Array(M);
    for (const k of sel) want[k] = 1;
    const on = new Array<number>(n).fill(0);
    const large = new Array<number>(n).fill(0);
    const clear = new Array<number>(n).fill(0);
    for (let r = 0; r < monthly.cell.length; r++) {
      if (!want[monthly.month[r]]) continue;
      on[monthly.cell[r]] += monthly.on_posidonia[r];
      large[monthly.cell[r]] += monthly.large_on_posidonia[r];
    }
    for (let i = 0; i < n; i++) for (const k of sel) clear[i] += monthly.clear_overpasses[i * M + k];
    agg = { on_posidonia: on, large_on_posidonia: large, density: ratio(on, clear) };
  } else {
    // Older build without hexes_monthly.json: no range selection, seasons come from hexes.json.
    const s = state.season as Season;
    const on = num(h.by_season?.[s]);
    agg = {
      on_posidonia: on,
      large_on_posidonia: h.by_season_large ? num(h.by_season_large[s]) : on.map(() => NaN),
      density: ratio(on, h.by_season_clear_overpasses?.[s]),
    };
  }
  aggCache = { key, agg };
  return agg;
}

function activeIsCount(): boolean {
  return state.metric !== 'density';
}

function activeValues(): number[] {
  return hexes ? aggregate()[state.metric] : [];
}

/** Copy the shown values into the hex features (centroid features share the same properties objects). */
function writeValues() {
  if (!hexGeojson) return;
  const v = activeValues();
  for (const f of hexGeojson.features) {
    const x = v[f.properties!.i as number];
    f.properties![VALUE_KEY] = Number.isFinite(x) ? x : null;
  }
}

const seasonWord = (s: Season) => SEASON_LABEL[s].split(' ')[0].toLowerCase();

function rangeLabel(): string {
  const r = state.range;
  const m = (c: number) => fmtMonth(calendar[c]?.month);
  return r === null ? 'All months' : r[0] === r[1] ? m(r[0]) : `${m(r[0])} – ${m(r[1])}`;
}

function periodLabel(): string {
  return state.season === 'ALL' ? rangeLabel() : `${rangeLabel()}, ${seasonWord(state.season)} only`;
}

/** Calendar range covering one year (clipped to the data span). */
function yearRange(year: string): Range {
  const idx = calendar.flatMap((e, c) => (e.month.startsWith(`${year}-`) ? [c] : []));
  return idx.length ? [idx[0], idx.at(-1)!] : null;
}

function ramp(): string[] {
  return [0, 1, 2, 3, 4].map((i) => cssVar(`--ramp-${i}`));
}

function zeroColor() { return isDark() ? 'rgba(180,195,192,0.18)' : 'rgba(68,87,92,0.12)'; }

let currentBreaks: number[] = [];

function fillColorExpr(): ExpressionSpecification {
  const key = VALUE_KEY;
  const isCount = activeIsCount();
  currentBreaks = quantileBreaks(activeValues(), isCount);
  const colors = ramp();
  // map N breaks onto N+1 colours spread over the 5-step ramp
  const nClasses = currentBreaks.length + 1;
  const pick = (k: number) => colors[nClasses === 1 ? 4 : Math.round((k * 4) / (nClasses - 1))];
  const step: unknown[] = ['step', ['to-number', ['get', key]], pick(0)];
  currentBreaks.forEach((b, k) => step.push(b, pick(k + 1)));
  return [
    'case',
    ['==', ['get', key], null], zeroColor(),
    ['<=', ['to-number', ['get', key]], 0], zeroColor(),
    step,
  ] as unknown as ExpressionSpecification;
}

function dotPaint() {
  const key = VALUE_KEY;
  const positive = ['>', ['coalesce', ['to-number', ['get', key]], 0], 0];
  return {
    'circle-color': fillColorExpr(),
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['case', positive, 3, 1.5], DOTS_MAXZOOM, ['case', positive, 6, 3]],
    'circle-stroke-color': cssVar('--hex-line'),
    'circle-stroke-width': 0.5,
    'circle-opacity': ['interpolate', ['linear'], ['zoom'], DOTS_MAXZOOM - 1, 1, DOTS_MAXZOOM, 0],
    'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], DOTS_MAXZOOM - 1, 1, DOTS_MAXZOOM, 0],
  } as unknown as NonNullable<maplibregl.CircleLayerSpecification['paint']>;
}

function renderLegend() {
  const el = $('legend');
  const title = $('legend-title');
  const isCount = activeIsCount();
  title.textContent = METRIC_LABEL[state.metric](largeLen);
  const vals = activeValues().filter((x) => Number.isFinite(x) && x > 0);
  if (!hexes || vals.length === 0) {
    el.innerHTML = '<p class="text-muted">No values to show.</p>';
    return;
  }
  const colors = ramp();
  const nClasses = currentBreaks.length + 1;
  const pick = (k: number) => colors[nClasses === 1 ? 4 : Math.round((k * 4) / (nClasses - 1))];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const f = (x: number) => (isCount ? fmtInt(x) : fmtNum(x, x < 0.1 ? 3 : 2));
  const rows: string[] = [];
  for (let k = 0; k < nClasses; k++) {
    const lo = k === 0 ? min : currentBreaks[k - 1];
    const hi = k === nClasses - 1 ? max : currentBreaks[k];
    const top = isCount && k !== nClasses - 1 ? Math.max(lo, hi - 1) : hi;
    const range = f(lo) === f(top) ? f(lo) : `${f(lo)} – ${f(top)}`;
    rows.push(`<div class="flex items-center gap-2"><span class="inline-block h-3 w-6 rounded-sm" style="background:${pick(k)}"></span><span>${range}</span></div>`);
  }
  rows.push(`<div class="flex items-center gap-2"><span class="inline-block h-3 w-6 rounded-sm border border-line" style="background:${zeroColor()}"></span><span>0${isCount ? '' : ' or no clear image'}</span></div>`);
  el.innerHTML = rows.join('');
  el.title = 'Classes are quantiles of non-zero cells';
}

// ---------- popups ----------

function hexPopupHtml(i: number): string {
  const h = hexes!;
  const row = (label: string, value: string) => `<tr><th class="py-0.5 pr-3 text-left font-normal text-muted">${label}</th><td class="py-0.5 text-right tabular font-medium">${value}</td></tr>`;
  const a = aggregate();
  const d = a.density[i];
  return `<div class="w-52 text-xs" title="H3 ${escapeHtml(h.h3[i])}">
    <div class="font-medium text-ink-2">${escapeHtml(countryName(h.country?.[i]))}</div>
    <div class="text-muted">${escapeHtml(periodLabel())}</div>
    <div class="mt-2 text-2xl font-semibold leading-none tabular">${fmtInt(a.on_posidonia[i])}</div>
    <div class="mb-3 mt-1 text-ink-2">boats anchored on seagrass</div>
    <table class="w-full">
      ${row(`≥ ${largeLen} m`, fmtInt(a.large_on_posidonia[i]))}
      ${row('Per clear image', Number.isFinite(d) ? fmtNum(d, 2) : 'n/a')}
      ${row('Seagrass here', `${fmtNum(h.posidonia_km2?.[i], 1)} km²`)}
    </table>
  </div>`;
}

function pointPopupHtml(f: MapGeoJSONFeature): string {
  const p = f.properties as { m: number; L: number; c: string };
  const month = meta?.months?.[p.m];
  const large = p.L >= largeLen;
  return `<div class="text-xs"><div class="font-semibold">${escapeHtml(fmtMonth(month ?? '?'))}</div>
    <div>${fmtNum(p.L, 1)} m${large ? ' <span class="font-semibold" style="color:var(--point-large)">· large</span>' : ''}</div>
    <div class="text-muted">${escapeHtml(countryName(p.c))}</div></div>`;
}

// ---------- map ----------

export async function initMap() {
  const [m, hx, hm, hs, ts] = await Promise.all([
    loadJson<Meta>('meta.json'),
    loadJson<Hexes>('hexes.json'),
    loadJson<HexesMonthly>('hexes_monthly.json'),
    loadJson<Hotspot[]>('hotspots.json'),
    loadJson<Timeseries>('timeseries.json'),
  ]);
  meta = m;
  if (ts?.by_country) setCountryNames(Object.fromEntries(Object.entries(ts.by_country).map(([k, v]) => [k, v.name])));
  largeLen = meta?.params?.large_length_m ?? 24;
  calendar = buildCalendar(meta?.months ?? []);
  if (hx && Array.isArray(hx.h3) && hx.h3.length > 0) {
    hexes = hx;
    hexIndex = new Map(hx.h3.map((id, i) => [id, i]));
    hexGeojson = buildHexGeojson(hx);
    // Res-7 hexes are only a few pixels wide at Mediterranean scale, so the overview uses centroid dots.
    hexCentroids = {
      type: 'FeatureCollection',
      features: hexGeojson.features.map((f) => {
        const [lat, lon] = cellToLatLng(hx.h3[f.properties!.i as number]);
        return { type: 'Feature', id: f.id, properties: f.properties, geometry: { type: 'Point', coordinates: [lon, lat] } };
      }),
    };
    const M = meta?.months?.length ?? 0;
    if (hm && M > 0 && hm.months?.join() === meta!.months.join() && hm.clear_overpasses?.length === hx.h3.length * M) monthly = hm;
    writeValues();
  }

  currentBreaks = quantileBreaks(activeValues(), activeIsCount());
  renderLegend();

  const bbox = (meta?.bbox && meta.bbox.length === 4 ? meta.bbox : MED_BBOX) as [number, number, number, number];
  let map: maplibregl.Map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: await basemapStyle(),
      bounds: [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      fitBoundsOptions: { padding: window.innerWidth >= 640 ? { top: 20, bottom: 20, left: 340, right: 20 } : { top: 10, bottom: 60, left: 10, right: 10 } },
      attributionControl: false,
      maxZoom: 16,
      dragRotate: false,
      pitchWithRotate: false,
    });
  } catch (e) {
    setStatus('The map could not be started. Your browser may not support WebGL.');
    console.error(e);
    return;
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }), 'bottom-right');

  const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: '280px', focusAfterOpen: false });
  const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '240px', className: 'pw-hover' });
  let pinned = false;
  /** Hex shown in the pinned popup, so it can follow selection changes. */
  let pinnedHex: number | null = null;
  popup.on('close', () => { pinned = false; pinnedHex = null; });

  const firstSymbolLayer = () => map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;

  function addOverlays() {
    const before = firstSymbolLayer();
    if (!map.getSource('posidonia')) {
      map.addSource('posidonia', { type: 'geojson', data: posidoniaGeojson ?? { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('posidonia-fill')) {
      map.addLayer({
        id: 'posidonia-fill', type: 'fill', source: 'posidonia', minzoom: POSIDONIA_MINZOOM,
        paint: { 'fill-color': cssVar('--seagrass'), 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.18, 12, 0.32] },
        layout: { visibility: state.showPosidonia ? 'visible' : 'none' },
      }, before);
      map.addLayer({
        id: 'posidonia-line', type: 'line', source: 'posidonia', minzoom: POSIDONIA_MINZOOM,
        paint: { 'line-color': cssVar('--seagrass'), 'line-width': 0.8, 'line-opacity': 0.7 },
        layout: { visibility: state.showPosidonia ? 'visible' : 'none' },
      }, before);
    }
    if (hexGeojson && !map.getSource('hexes')) {
      map.addSource('hexes', { type: 'geojson', data: hexGeojson });
      map.addLayer({
        id: 'hex-fill', type: 'fill', source: 'hexes',
        minzoom: DOTS_MAXZOOM - 1.5,
        paint: {
          'fill-color': fillColorExpr(),
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], DOTS_MAXZOOM - 1.5, 0, DOTS_MAXZOOM, 0.85, 10, 0.7, 12, 0.25],
        },
      }, before);
      map.addLayer({
        id: 'hex-line', type: 'line', source: 'hexes',
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], cssVar('--ink'), cssVar('--hex-line')],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            5, ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0],
            8, ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0.5],
            12, ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1]],
        },
      }, before);
    }
    if (hexCentroids && !map.getSource('hex-centroids')) {
      map.addSource('hex-centroids', { type: 'geojson', data: hexCentroids });
      map.addLayer({
        id: 'hex-dots', type: 'circle', source: 'hex-centroids', maxzoom: DOTS_MAXZOOM,
        layout: { 'circle-sort-key': ['to-number', ['get', VALUE_KEY]] },
        paint: dotPaint(),
      }, before);
    }
    if (!map.getSource('points')) {
      map.addSource('points', { type: 'geojson', data: pointsGeojson ?? { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'points', type: 'circle', source: 'points', minzoom: POINTS_MINZOOM,
        layout: { visibility: state.showPoints ? 'visible' : 'none', 'circle-sort-key': ['get', 'L'] },
        paint: {
          'circle-color': ['case', ['>=', ['get', 'L'], largeLen], cssVar('--point-large'), cssVar('--point-small')],
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            11, ['interpolate', ['linear'], ['get', 'L'], 8, 2, largeLen, 3.5, 60, 6],
            15, ['interpolate', ['linear'], ['get', 'L'], 8, 4, largeLen, 7, 60, 12]],
          'circle-stroke-color': cssVar('--surface'),
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
      });
      applyMonthFilter();
    }
  }

  function applyMonthFilter() {
    if (!map.getLayer('points')) return;
    const sel = selectedMonthIdx();
    map.setFilter('points', sel === null ? null : ['in', ['get', 'm'], ['literal', sel]]);
  }

  function refreshHexColors() {
    writeValues();
    if (hexGeojson) (map.getSource('hexes') as GeoJSONSource | undefined)?.setData(hexGeojson);
    if (hexCentroids) (map.getSource('hex-centroids') as GeoJSONSource | undefined)?.setData(hexCentroids);
    if (map.getLayer('hex-fill')) map.setPaintProperty('hex-fill', 'fill-color', fillColorExpr());
    if (map.getLayer('hex-dots')) {
      map.setPaintProperty('hex-dots', 'circle-color', fillColorExpr());
      map.setPaintProperty('hex-dots', 'circle-radius', dotPaint()['circle-radius']);
      map.setLayoutProperty('hex-dots', 'circle-sort-key', ['to-number', ['get', VALUE_KEY]]);
    }
    else currentBreaks = quantileBreaks(activeValues(), activeIsCount());
    renderLegend();
  }

  async function ensurePosidonia() {
    if (posidoniaGeojson || posidoniaLoading || !state.showPosidonia || map.getZoom() < POSIDONIA_MINZOOM - 0.5) return;
    posidoniaLoading = true;
    const g = await loadJson<GeoJSON.FeatureCollection>('posidonia.geojson');
    posidoniaGeojson = g && Array.isArray(g.features) ? g : { type: 'FeatureCollection', features: [] };
    (map.getSource('posidonia') as GeoJSONSource | undefined)?.setData(posidoniaGeojson);
  }

  async function ensurePoints() {
    if (pointsGeojson || pointsLoading || !state.showPoints || map.getZoom() < POINTS_MINZOOM - 1) return;
    pointsLoading = true;
    const p = await loadJson<Points>('points.json');
    pointsGeojson = p ? buildPointsGeojson(p) : { type: 'FeatureCollection', features: [] };
    (map.getSource('points') as GeoJSONSource | undefined)?.setData(pointsGeojson);
  }

  map.on('style.load', () => {
    addOverlays();
    renderLegend();
    ensurePosidonia();
    ensurePoints();
  });
  map.on('load', () => {
    if (!hexes) {
      setStatus(`No map data published yet. The data pipeline has not produced <code>hexes.json</code>. See <a class="text-sea underline" href="${withBase('about/')}">About</a>.`);
    } else {
      setStatus(null);
    }
  });
  map.on('error', (e) => {
    // Basemap/tile failures should not hide our own data; log only.
    console.warn('map error', e?.error ?? e);
  });
  map.on('moveend', () => { ensurePosidonia(); ensurePoints(); });

  // Follow OS theme changes: swap basemap, then re-add our layers (style.load).
  darkQuery.addEventListener('change', async () => {
    map.setStyle(await basemapStyle(), { diff: false });
  });

  // ----- hover & click -----
  let hoveredId: number | null = null;
  const canHover = window.matchMedia('(hover: hover)').matches;

  function setHover(id: number | null) {
    if (hoveredId !== null && map.getSource('hexes')) map.setFeatureState({ source: 'hexes', id: hoveredId }, { hover: false });
    hoveredId = id;
    if (id !== null && map.getSource('hexes')) map.setFeatureState({ source: 'hexes', id }, { hover: true });
  }

  map.on('mousemove', (e) => {
    const layers = ['points', 'hex-fill', 'hex-dots'].filter((l) => map.getLayer(l));
    const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    const pt = feats.find((f) => f.layer.id === 'points');
    const hx = feats.find((f) => f.layer.id === 'hex-fill' || f.layer.id === 'hex-dots');
    map.getCanvas().style.cursor = pt || hx ? 'pointer' : '';
    setHover(hx ? (hx.id as number) : null);
    if (!canHover) return;
    if (pt) {
      hover.setLngLat(e.lngLat).setHTML(pointPopupHtml(pt)).addTo(map);
    } else if (hx && !pinned) {
      hover.setLngLat(e.lngLat).setHTML(hexPopupHtml(hx.properties.i as number)).addTo(map);
    } else {
      hover.remove();
    }
  });
  map.getCanvas().addEventListener('mouseleave', () => { setHover(null); hover.remove(); });

  map.on('click', (e) => {
    const layers = ['points', 'hex-fill', 'hex-dots'].filter((l) => map.getLayer(l));
    const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    const pt = feats.find((f) => f.layer.id === 'points');
    const hx = feats.find((f) => f.layer.id === 'hex-fill' || f.layer.id === 'hex-dots');
    hover.remove();
    if (pt) {
      popup.setLngLat((pt.geometry as GeoJSON.Point).coordinates as [number, number]).setHTML(pointPopupHtml(pt)).addTo(map);
      pinned = true;
      pinnedHex = null;
    } else if (hx) {
      pinnedHex = hx.properties.i as number;
      popup.setLngLat(e.lngLat).setHTML(hexPopupHtml(pinnedHex)).addTo(map);
      pinned = true;
    } else {
      popup.remove();
    }
  });

  // ----- controls -----
  const panel = $('panel');
  const toggle = $('panel-toggle');
  const setOpen = (open: boolean) => {
    panel.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(panel.dataset.open !== 'true'));
  const isNarrow = () => window.matchMedia('(max-width: 639.98px)').matches;

  const tabs = [$('tab-layers'), $('tab-hotspots')];
  const panes = [$('pane-layers'), $('pane-hotspots')];
  tabs.forEach((t, k) => t.addEventListener('click', () => {
    tabs.forEach((x, j) => x.setAttribute('aria-selected', String(j === k)));
    panes.forEach((p, j) => { p.hidden = j !== k; });
    setOpen(true);
  }));

  // ----- time: timeline brush + season filter -----
  const seasonButtons = document.querySelectorAll<HTMLButtonElement>('#season-group button');
  const timelineValues = () => {
    const series = state.metric === 'large_on_posidonia' ? ts?.large_on_posidonia : ts?.anchored_on_posidonia;
    return calendar.map((e) => (e.idx < 0 ? NaN : series?.[e.idx] ?? NaN));
  };
  const timeline = createTimeline($('timeline'), calendar.map((e) => e.month), {
    interactive: monthly !== null,
    title: (c) => {
      const v = timelineValues()[c];
      const what = state.metric === 'large_on_posidonia' ? `boats ≥ ${largeLen} m` : 'boats';
      return `${fmtMonth(calendar[c].month)}: ${Number.isFinite(v) ? `${fmtInt(v)} ${what} on seagrass` : 'no data'}`;
    },
    onChange: (r) => { state.range = r; update(); },
  });

  function updateSeasonButtons() {
    const [a, b] = state.range ?? [0, calendar.length - 1];
    const avail = new Set<Season>();
    for (let c = a; c <= b; c++) if (calendar[c]?.idx >= 0) avail.add(seasonOf(calendar[c].month));
    if (state.season !== 'ALL' && !avail.has(state.season)) state.season = 'ALL';
    seasonButtons.forEach((btn) => {
      const ss = btn.dataset.season as SeasonSel;
      btn.setAttribute('aria-pressed', String(ss === state.season));
      if (ss === 'ALL') return;
      btn.disabled = !avail.has(ss);
      btn.title = avail.has(ss) ? SEASON_LABEL[ss] : `${SEASON_LABEL[ss]}: no data in the selected months`;
    });
  }

  const yearButtons = document.querySelectorAll<HTMLButtonElement>('#year-group button');
  const METRIC_SHORT: Record<Metric, string> = { on_posidonia: 'Boats', large_on_posidonia: `Boats ≥ ${largeLen} m`, density: 'Density' };

  /** Year whose full span equals the selected range, 'ALL' for no range, null for a custom range. */
  function selectedYear(): string | null {
    if (state.range === null) return 'ALL';
    const r = state.range;
    const y = calendar[r[0]].month.slice(0, 4);
    const yr = yearRange(y);
    return yr && yr[0] === r[0] && yr[1] === r[1] ? y : null;
  }

  /** Section headers show the current value, so a collapsed section still tells what is filtered. */
  function renderSummaries() {
    const year = selectedYear();
    yearButtons.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.year === year));
      if (b.dataset.year !== 'ALL') b.disabled = monthly === null;
    });
    $('sum-metric').textContent = METRIC_SHORT[state.metric];
    $('sum-year').textContent = year === 'ALL' ? 'All' : year ?? 'Custom range';
    $('time-label').textContent = state.range === null ? 'All' : rangeLabel();
    $('sum-season').textContent = state.season === 'ALL' ? 'All' : SEASON_LABEL[state.season];
    $('time-reset').hidden = state.range === null;
  }

  /** Re-render everything that depends on metric, range or season. */
  function update() {
    updateSeasonButtons();
    refreshHexColors();
    applyMonthFilter();
    timeline.setRange(state.range);
    timeline.setActive((c) => calendar[c].idx >= 0 && (state.season === 'ALL' || seasonOf(calendar[c].month) === state.season));
    timeline.setValues(timelineValues());
    renderSummaries();
    if (pinnedHex !== null) popup.setHTML(hexPopupHtml(pinnedHex));
  }

  document.querySelectorAll<HTMLInputElement>('input[name="metric"]').forEach((r) =>
    r.addEventListener('change', () => { if (r.checked) { state.metric = r.value as Metric; update(); } }));
  seasonButtons.forEach((b) => b.addEventListener('click', () => {
    state.season = b.dataset.season as SeasonSel;
    update();
  }));
  yearButtons.forEach((b) => b.addEventListener('click', () => {
    state.range = b.dataset.year === 'ALL' ? null : yearRange(b.dataset.year!);
    update();
  }));
  $('time-reset').addEventListener('click', () => {
    state.range = null;
    update();
  });
  update();

  $<HTMLInputElement>('toggle-posidonia').addEventListener('change', (e) => {
    state.showPosidonia = (e.target as HTMLInputElement).checked;
    for (const id of ['posidonia-fill', 'posidonia-line']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.showPosidonia ? 'visible' : 'none');
    ensurePosidonia();
  });
  $<HTMLInputElement>('toggle-points').addEventListener('change', (e) => {
    state.showPoints = (e.target as HTMLInputElement).checked;
    if (map.getLayer('points')) map.setLayoutProperty('points', 'visibility', state.showPoints ? 'visible' : 'none');
    ensurePoints();
  });
  // ----- hotspots -----
  const list = $('hotspot-list');
  if (!hs || !Array.isArray(hs) || hs.length === 0) {
    list.innerHTML = '<li class="px-2 py-4 text-center text-xs text-muted">No hotspots published yet.</li>';
  } else {
    list.innerHTML = hs.map((h, k) => `
      <li><button type="button" data-k="${k}" class="hs flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-2">
        <span class="mt-0.5 w-5 shrink-0 text-right text-xs tabular text-muted">${k + 1}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-ink">${escapeHtml(h.place ?? `${fmtNum(Math.abs(h.lat), 2)}° ${h.lat >= 0 ? 'N' : 'S'}, ${fmtNum(Math.abs(h.lon), 2)}° ${h.lon >= 0 ? 'E' : 'W'}`)}</span>
          <span class="block text-xs text-muted">${escapeHtml(countryName(h.country))} · peak ${escapeHtml(fmtMonth(h.peak_month))}</span>
        </span>
        <span class="shrink-0 text-right tabular">
          <span class="block font-semibold text-ink">${fmtInt(h.on_posidonia)}</span>
          <span class="block text-[11px] text-muted">${fmtInt(h.large_on_posidonia)} large</span>
        </span>
      </button></li>`).join('');
    list.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.hs');
      if (!btn) return;
      const h = hs[Number(btn.dataset.k)];
      if (isNarrow()) setOpen(false);
      map.flyTo({ center: [h.lon, h.lat], zoom: 11.5, essential: true, padding: isNarrow() ? 0 : { left: 340, top: 0, right: 0, bottom: 0 } });
      const i = hexIndex.get(h.h3);
      if (i !== undefined) {
        map.once('moveend', () => {
          popup.setLngLat([h.lon, h.lat]).setHTML(hexPopupHtml(i)).addTo(map);
          pinned = true;
          pinnedHex = i;
        });
      }
    });
  }

}
