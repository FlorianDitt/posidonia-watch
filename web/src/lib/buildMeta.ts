// Build-time access to the files in public/data/ (server side only, used in .astro frontmatter).
// The site is rebuilt whenever the pipeline publishes new data, so this stays current.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Meta, Timeseries } from './data';

export const DEFAULT_PARAMS: Meta['params'] = { speed_kn_max: 1.0, posidonia_buffer_m: 20, large_length_m: 24, ais_confidence_min: 0.9 };

let cached: Meta | null | undefined;

export function readMeta(): Meta | null {
  if (cached !== undefined) return cached;
  try {
    const raw = readFileSync(join(process.cwd(), 'public', 'data', 'meta.json'), 'utf8');
    const m = JSON.parse(raw) as Meta;
    cached = m && typeof m === 'object' ? m : null;
  } catch {
    cached = null;
  }
  return cached;
}

export interface AisCheck {
  matched: number;
  stationary: number;
  /** Null when the data does not count them (built before ais_moving_on_posidonia existed). */
  moving: number | null;
  /** Confident matches without an AIS speed: neither stationary nor moving. */
  noSpeed: number | null;
  /** Share of all confident matches. */
  stationaryPct: number;
  movingPct: number | null;
  /** Share of the matches with an AIS speed, the ones AIS can check. */
  movingOfCheckedPct: number | null;
}

/** How many confident AIS matches anchored on Posidonia report a speed below the anchoring limit, and how many one
 *  at or above it, over all months of timeseries.json. Null when the file is missing, has no AIS counts (older
 *  data) or counts no match at all. */
export function readAisCheck(): AisCheck | null {
  let ts: Partial<Timeseries> | null;
  try {
    ts = JSON.parse(readFileSync(join(process.cwd(), 'public', 'data', 'timeseries.json'), 'utf8'));
  } catch {
    return null;
  }
  const all = ts?.ais_matched_on_posidonia;
  const still = ts?.ais_stationary_on_posidonia;
  if (!Array.isArray(all) || !Array.isArray(still)) return null;
  const sum = (a: unknown[]) => a.reduce<number>((s, x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);
  const matched = sum(all);
  if (matched <= 0) return null;
  const stationary = Math.min(sum(still), matched);
  const stationaryPct = Math.round((stationary / matched) * 100);
  // A match without an AIS speed is not stationary, but it is not known to be moving either
  const mv = ts?.ais_moving_on_posidonia;
  if (!Array.isArray(mv)) return { matched, stationary, moving: null, noSpeed: null, stationaryPct, movingPct: null, movingOfCheckedPct: null };
  const moving = Math.min(sum(mv), matched - stationary);
  return {
    matched, stationary, moving, noSpeed: matched - stationary - moving, stationaryPct,
    movingPct: Math.round((moving / matched) * 100),
    movingOfCheckedPct: moving > 0 ? Math.round((moving / (stationary + moving)) * 100) : 0,
  };
}

export const isFixture = (m: Meta | null) => !!m && String(m.methodology_version).includes('fixture');
