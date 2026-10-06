// Client-side map for the home page. Loaded only by src/pages/index.astro.
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import type * as GeoJSON from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 runs its tiles in a module worker; let Vite bundle it and tell MapLibre where it is.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { cellToBoundary } from 'h3-js';
import {
  loadJson, fmtInt, fmtNum, fmtMonth, escapeHtml, withBase,
  SEASONS, SEASON_LABEL,
  type Meta, type Hexes, type Points, type Hotspot, type Timeseries, type Season,
} from './data';
import { countryName, setCountryNames } from './countries';

maplibregl.setWorkerUrl(workerUrl);

type Metric = 'density' | 'on_posidonia' | 'large_on_posidonia';
type SeasonSel = 'ALL' | Season;

const MED_BBOX: [number, number, number, number] = [-6.0, 30.0, 36.5, 46.0];
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const POSIDONIA_MINZOOM = 8;
const POINTS_MINZOOM = 11;
const ATTRIBUTION =
  'Detections <a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">Global Fishing Watch</a> (CC0) · ' +
  'Seagrass <a href="https://emodnet.ec.europa.eu/en/seabed-habitats" target="_blank" rel="noopener">EMODnet</a> (CC-BY 4.0)';

const METRIC_LABEL: Record<Metric, string> = {
  density: 'Boats on Posidonia per clear image',
  on_posidonia: 'Detections anchored on Posidonia',
  large_on_posidonia: 'Large vessels on Posidonia',
};

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
  month: number | null;
}

const state: State = { metric: 'density', season: 'ALL', showPosidonia: true, showPoints: true, month: null };

let meta: Meta | null = null;
let hexes: Hexes | null = null;
let hexIndex = new Map<string, number>();
let hexGeojson: GeoJSON.FeatureCollection | null = null;
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
    const props: Record<string, unknown> = {
      i,
      density: h.density?.[i] ?? null,
      on_posidonia: h.on_posidonia?.[i] ?? 0,
      large_on_posidonia: h.large_on_posidonia?.[i] ?? 0,
    };
    for (const s of SEASONS) props[`s_${s}`] = h.by_season?.[s]?.[i] ?? 0;
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

function activeKey(): string {
  return state.season === 'ALL' ? state.metric : `s_${state.season}`;
}

function activeValues(): number[] {
  if (!hexes) return [];
  if (state.season !== 'ALL') return hexes.by_season?.[state.season] ?? [];
  return (hexes[state.metric] ?? []).map((x) => (x == null ? NaN : x));
}

function ramp(): string[] {
  return [0, 1, 2, 3, 4].map((i) => cssVar(`--ramp-${i}`));
}

function zeroColor() { return isDark() ? 'rgba(180,195,192,0.18)' : 'rgba(68,87,92,0.12)'; }

let currentBreaks: number[] = [];

function fillColorExpr(): ExpressionSpecification {
  const key = activeKey();
  const isCount = key !== 'density';
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

function renderLegend() {
  const el = $('legend');
  const title = $('legend-title');
  const key = activeKey();
  const isCount = key !== 'density';
  title.textContent = state.season === 'ALL' ? METRIC_LABEL[state.metric] : `On Posidonia, ${SEASON_LABEL[state.season as Season].toLowerCase()}`;
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
    const range = isCount
      ? (k === nClasses - 1 ? `${f(lo)} – ${f(hi)}` : `${f(lo)} – ${f(Math.max(lo, hi - 1))}`)
      : `${f(lo)} – ${f(hi)}`;
    rows.push(`<div class="flex items-center gap-2"><span class="inline-block h-3 w-6 rounded-sm" style="background:${pick(k)}"></span><span>${range}</span></div>`);
  }
  rows.push(`<div class="flex items-center gap-2"><span class="inline-block h-3 w-6 rounded-sm border border-line" style="background:${zeroColor()}"></span><span>0${key === 'density' ? ' or no clear image' : ''}</span></div>`);
  rows.push('<p class="pt-1 text-muted">Classes are quantiles of non-zero cells.</p>');
  el.innerHTML = rows.join('');
}

// ---------- popups ----------

function seasonBars(i: number): string {
  if (!hexes?.by_season) return '';
  const vals = SEASONS.map((s) => hexes!.by_season[s]?.[i] ?? 0);
  const max = Math.max(1, ...vals);
  const bars = SEASONS.map((s, k) => {
    const h = Math.round((vals[k] / max) * 36);
    return `<div class="flex flex-1 flex-col items-center gap-0.5" title="${SEASON_LABEL[s]}: ${vals[k]}">
      <span class="text-[10px] tabular text-ink-2">${fmtInt(vals[k])}</span>
      <div class="flex h-9 w-full items-end"><div class="w-full rounded-t-sm" style="height:${Math.max(h, vals[k] > 0 ? 2 : 0)}px;background:var(--sea)"></div></div>
      <span class="text-[10px] text-muted">${s}</span></div>`;
  }).join('');
  return `<div class="mt-2 border-t border-line pt-2"><div class="mb-1 text-[11px] text-muted">On Posidonia by season</div><div class="flex gap-1.5" role="img" aria-label="Detections by season: ${SEASONS.map((s, k) => `${s} ${vals[k]}`).join(', ')}">${bars}</div></div>`;
}

function hexPopupHtml(i: number): string {
  const h = hexes!;
  const row = (label: string, value: string) => `<tr><th class="py-0.5 pr-3 text-left font-normal text-muted">${label}</th><td class="py-0.5 text-right tabular font-medium">${value}</td></tr>`;
  const d = h.density?.[i];
  return `<div class="w-56 text-xs">
    <div class="text-sm font-semibold">${escapeHtml(countryName(h.country?.[i]))}</div>
    <div class="mb-1.5 font-mono text-[10px] text-muted">H3 ${escapeHtml(h.h3[i])}</div>
    <table class="w-full">
      ${row('Anchored on Posidonia', fmtInt(h.on_posidonia?.[i]))}
      ${row(`Large (≥ ${largeLen} m)`, fmtInt(h.large_on_posidonia?.[i]))}
      ${row('Clear overpasses', fmtInt(h.clear_overpasses?.[i]))}
      ${row('Density', d == null ? 'n/a' : `${fmtNum(d, 3)} <span class="font-normal text-muted">/image</span>`)}
      ${row('Posidonia area', `${fmtNum(h.posidonia_km2?.[i], 2)} km²`)}
    </table>
    ${seasonBars(i)}
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
  const [m, hx, hs, ts] = await Promise.all([
    loadJson<Meta>('meta.json'),
    loadJson<Hexes>('hexes.json'),
    loadJson<Hotspot[]>('hotspots.json'),
    loadJson<Timeseries>('timeseries.json'),
  ]);
  meta = m;
  if (ts?.by_country) setCountryNames(Object.fromEntries(Object.entries(ts.by_country).map(([k, v]) => [k, v.name])));
  largeLen = meta?.params?.large_length_m ?? 24;
  if (hx && Array.isArray(hx.h3) && hx.h3.length > 0) {
    hexes = hx;
    hexIndex = new Map(hx.h3.map((id, i) => [id, i]));
    hexGeojson = buildHexGeojson(hx);
  }

  const bbox = (meta?.bbox && meta.bbox.length === 4 ? meta.bbox : MED_BBOX) as [number, number, number, number];
  let map: maplibregl.Map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: isDark() ? STYLE_DARK : STYLE_LIGHT,
      bounds: [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      fitBoundsOptions: { padding: 20 },
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
  popup.on('close', () => { pinned = false; });

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
        paint: {
          'fill-color': fillColorExpr(),
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.85, 10, 0.7, 12, 0.25],
        },
      }, before);
      map.addLayer({
        id: 'hex-line', type: 'line', source: 'hexes',
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], cssVar('--ink'), cssVar('--hex-line')],
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, ['interpolate', ['linear'], ['zoom'], 5, 0, 8, 0.5, 12, 1]],
        },
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
    map.setFilter('points', state.month == null ? null : ['==', ['get', 'm'], state.month]);
  }

  function refreshHexColors() {
    if (map.getLayer('hex-fill')) map.setPaintProperty('hex-fill', 'fill-color', fillColorExpr());
    else currentBreaks = quantileBreaks(activeValues(), activeKey() !== 'density');
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
    populateMonths(p);
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
  darkQuery.addEventListener('change', () => {
    map.setStyle(isDark() ? STYLE_DARK : STYLE_LIGHT, { diff: false });
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
    const layers = ['points', 'hex-fill'].filter((l) => map.getLayer(l));
    const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    const pt = feats.find((f) => f.layer.id === 'points');
    const hx = feats.find((f) => f.layer.id === 'hex-fill');
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
    const layers = ['points', 'hex-fill'].filter((l) => map.getLayer(l));
    const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    const pt = feats.find((f) => f.layer.id === 'points');
    const hx = feats.find((f) => f.layer.id === 'hex-fill');
    hover.remove();
    if (pt) {
      popup.setLngLat((pt.geometry as GeoJSON.Point).coordinates as [number, number]).setHTML(pointPopupHtml(pt)).addTo(map);
      pinned = true;
    } else if (hx) {
      popup.setLngLat(e.lngLat).setHTML(hexPopupHtml(hx.properties.i as number)).addTo(map);
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

  document.querySelectorAll<HTMLInputElement>('input[name="metric"]').forEach((r) =>
    r.addEventListener('change', () => { if (r.checked) { state.metric = r.value as Metric; refreshHexColors(); } }));

  const seasonButtons = document.querySelectorAll<HTMLButtonElement>('#season-group button');
  seasonButtons.forEach((b) => b.addEventListener('click', () => {
    state.season = b.dataset.season as SeasonSel;
    seasonButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    ($('metric-group') as HTMLFieldSetElement).disabled = state.season !== 'ALL';
    $('season-note').classList.toggle('hidden', state.season === 'ALL');
    refreshHexColors();
  }));

  $<HTMLInputElement>('toggle-posidonia').addEventListener('change', (e) => {
    state.showPosidonia = (e.target as HTMLInputElement).checked;
    for (const id of ['posidonia-fill', 'posidonia-line']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.showPosidonia ? 'visible' : 'none');
    ensurePosidonia();
  });
  $<HTMLInputElement>('toggle-points').addEventListener('change', (e) => {
    state.showPoints = (e.target as HTMLInputElement).checked;
    if (map.getLayer('points')) map.setLayoutProperty('points', 'visibility', state.showPoints ? 'visible' : 'none');
    $<HTMLSelectElement>('month-select').disabled = !state.showPoints;
    ensurePoints();
  });
  const monthSelect = $<HTMLSelectElement>('month-select');
  monthSelect.addEventListener('change', () => {
    state.month = monthSelect.value === '' ? null : Number(monthSelect.value);
    applyMonthFilter();
  });
  populateMonths(null);

  function populateMonths(p: Points | null) {
    const months = meta?.months ?? [];
    if (!months.length) return;
    const present = p?.month ? new Set(p.month) : null;
    const opts = ['<option value="">All months</option>'];
    for (let k = months.length - 1; k >= 0; k--) {
      if (present && !present.has(k)) continue;
      opts.push(`<option value="${k}"${state.month === k ? ' selected' : ''}>${fmtMonth(months[k])}</option>`);
    }
    monthSelect.innerHTML = opts.join('');
  }

  // ----- hotspots -----
  const list = $('hotspot-list');
  if (!hs || !Array.isArray(hs) || hs.length === 0) {
    list.innerHTML = '<li class="px-2 py-4 text-center text-xs text-muted">No hotspots published yet.</li>';
  } else {
    list.innerHTML = hs.map((h, k) => `
      <li><button type="button" data-k="${k}" class="hs flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-2">
        <span class="mt-0.5 w-5 shrink-0 text-right text-xs tabular text-muted">${k + 1}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-ink">${escapeHtml(h.place ?? `${fmtNum(h.lat, 2)}° N, ${fmtNum(h.lon, 2)}° E`)}</span>
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
      map.flyTo({ center: [h.lon, h.lat], zoom: 11.5, essential: true });
      const i = hexIndex.get(h.h3);
      if (i !== undefined) {
        map.once('moveend', () => {
          popup.setLngLat([h.lon, h.lat]).setHTML(hexPopupHtml(i)).addTo(map);
          pinned = true;
        });
      }
    });
  }

  if (!hexes) renderLegend();
}
