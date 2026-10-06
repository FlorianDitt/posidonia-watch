// Types and loaders for the JSON files defined in docs/data-contract.md.
// All URLs are built from import.meta.env.BASE_URL so the site works under /posidonia-watch/.

export type Season = 'DJF' | 'MAM' | 'JJA' | 'SON';
export const SEASONS: Season[] = ['DJF', 'MAM', 'JJA', 'SON'];
export const SEASON_LABEL: Record<Season, string> = {
  DJF: 'Winter (Dec–Feb)',
  MAM: 'Spring (Mar–May)',
  JJA: 'Summer (Jun–Aug)',
  SON: 'Autumn (Sep–Nov)',
};

export interface Meta {
  generated_at: string;
  methodology_version: string;
  months: string[];
  h3_resolution: number;
  params: { speed_kn_max: number; posidonia_buffer_m: number; large_length_m: number };
  sources: { name: string; license: string; url: string }[];
  bbox: [number, number, number, number];
}

export interface CountrySeries {
  name: string;
  anchored_on_posidonia: number[];
  large_on_posidonia: number[];
}

export interface Timeseries {
  months: string[];
  anchored_total: number[];
  anchored_on_posidonia: number[];
  large_on_posidonia: number[];
  by_country: Record<string, CountrySeries>;
}

export interface Hexes {
  h3: string[];
  country: string[];
  on_posidonia: number[];
  large_on_posidonia: number[];
  clear_overpasses: number[];
  density: (number | null)[];
  posidonia_km2: number[];
  by_season: Record<Season, number[]>;
  /** Missing in data built before seasonal large/density support. */
  by_season_large?: Record<Season, number[]>;
  by_season_clear_overpasses?: Record<Season, number[]>;
}

export interface Points {
  lon: number[];
  lat: number[];
  month: number[];
  length_m: number[];
  country: string[];
}

export interface Hotspot {
  h3: string;
  lon: number;
  lat: number;
  country: string;
  place: string | null;
  on_posidonia: number;
  large_on_posidonia: number;
  density: number | null;
  peak_month: string;
}

/** Join a path onto the site base, independent of whether BASE_URL has a trailing slash. */
export function withBase(path: string): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

export const dataUrl = (file: string) => withBase(`data/${file}`);

/** Fetch a data file; resolves to null on 404 / network error / invalid JSON (never throws). */
export async function loadJson<T>(file: string): Promise<T | null> {
  try {
    const res = await fetch(dataUrl(file));
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const nf = new Intl.NumberFormat('en-GB');
export const fmtInt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : nf.format(Math.round(v)));
export function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2025-08" -> "Aug 2025" */
export function fmtMonth(m: string | undefined | null): string {
  if (!m || !/^\d{4}-\d{2}$/.test(m)) return m ?? '–';
  return `${MONTH_NAMES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
}

export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
