// Build-time access to public/data/meta.json (server side only, used in .astro frontmatter).
// The site is rebuilt whenever the pipeline publishes new data, so this stays current.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Meta } from './data';

export const DEFAULT_PARAMS: Meta['params'] = { speed_kn_max: 1.0, posidonia_buffer_m: 20, large_length_m: 24 };

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

export const isFixture = (m: Meta | null) => !!m && String(m.methodology_version).includes('fixture');
