// Generates SYNTHETIC sample data in web/fixtures/data/ following docs/data-contract.md.
// Only used for local development / CI fallback when the pipeline has not produced data.
// Usage: node scripts/gen-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { latLngToCell, gridDisk, cellToLatLng, gridDistance } from 'h3-js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data');
mkdirSync(OUT, { recursive: true });

// Deterministic PRNG (mulberry32)
let seed = 20261006;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randn = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

const RES = 7;
const months = [];
for (let y = 2024, m = 10; months.length < 24; m++) {
  if (m > 12) { m = 1; y++; }
  months.push(`${y}-${String(m).padStart(2, '0')}`);
}
const monthNum = (s) => Number(s.slice(5));
const seasonOf = (mm) => (mm === 12 || mm <= 2 ? 'DJF' : mm <= 5 ? 'MAM' : mm <= 8 ? 'JJA' : 'SON');
// Relative boating activity by calendar month (summer peak)
const monthWeight = [0, 0.15, 0.15, 0.25, 0.45, 0.8, 1.6, 2.6, 2.8, 1.4, 0.6, 0.25, 0.2];

const regions = [
  { place: 'Badia de Palma', lon: 2.62, lat: 39.5, k: 3, country: 'ESP', w: 1.0 },
  { place: "Cala d'Or", lon: 3.24, lat: 39.37, k: 2, country: 'ESP', w: 0.8 },
  { place: 'Badia de Pollença', lon: 3.12, lat: 39.88, k: 2, country: 'ESP', w: 0.9 },
  { place: 'Ses Salines, Eivissa', lon: 1.4, lat: 38.86, k: 3, country: 'ESP', w: 1.2 },
  { place: 'Formentera', lon: 1.45, lat: 38.72, k: 2, country: 'ESP', w: 1.1 },
  { place: 'Baie de Pampelonne', lon: 6.67, lat: 43.22, k: 2, country: 'FRA', w: 1.4 },
  { place: 'Golfe-Juan', lon: 7.08, lat: 43.55, k: 2, country: 'FRA', w: 0.9 },
  { place: 'Rade de Villefranche', lon: 7.31, lat: 43.69, k: 1, country: 'FRA', w: 0.8 },
  { place: 'Porquerolles', lon: 6.2, lat: 42.99, k: 2, country: 'FRA', w: 1.0 },
  { place: 'Bonifacio', lon: 9.18, lat: 41.37, k: 2, country: 'FRA', w: 0.7 },
  { place: 'Arcipelago di La Maddalena', lon: 9.42, lat: 41.23, k: 3, country: 'ITA', w: 1.1 },
  { place: 'Porto Cervo', lon: 9.56, lat: 41.13, k: 2, country: 'ITA', w: 1.0 },
  { place: 'Villasimius', lon: 9.52, lat: 39.12, k: 2, country: 'ITA', w: 0.6 },
  { place: 'Hvar', lon: 16.44, lat: 43.15, k: 2, country: 'HRV', w: 0.8 },
  { place: 'Vis', lon: 16.15, lat: 43.05, k: 2, country: 'HRV', w: 0.5 },
  { place: 'Kornati', lon: 15.3, lat: 43.8, k: 3, country: 'HRV', w: 0.4 },
];
const countryNames = { ESP: 'Spain', FRA: 'France', ITA: 'Italy', HRV: 'Croatia', UNK: 'Unknown / outside EEZ' };

const hexMap = new Map(); // h3 -> row
for (const r of regions) {
  const c = latLngToCell(r.lat, r.lon, RES);
  for (const h of gridDisk(c, r.k)) {
    if (hexMap.has(h)) continue;
    if (rand() < 0.18) continue; // leave holes so it looks like a coastline
    const d = gridDistance(c, h);
    const intensity = r.w * Math.exp(-d * 0.9) * Math.exp(randn() * 0.6);
    const on = Math.max(0, Math.round(intensity * 70 * (rand() < 0.08 ? 0 : 1)));
    hexMap.set(h, { h3: h, country: r.country, on, center: h === c ? r : null });
  }
}
// A few isolated cells outside any EEZ / with no clear overpasses
const rows = [...hexMap.values()];

const points = { lon: [], lat: [], month: [], length_m: [], country: [] };
const hexes = {
  h3: [], country: [], on_posidonia: [], large_on_posidonia: [], clear_overpasses: [],
  density: [], posidonia_km2: [], by_season: { DJF: [], MAM: [], JJA: [], SON: [] },
};
const ts = {
  months,
  anchored_total: months.map(() => 0),
  anchored_on_posidonia: months.map(() => 0),
  large_on_posidonia: months.map(() => 0),
  by_country: {},
};
const hotspotCandidates = [];
const cum = [];
let acc = 0;
months.forEach((m) => { acc += monthWeight[monthNum(m)]; cum.push(acc); });
const pickMonth = () => { const x = rand() * acc; return cum.findIndex((c) => c >= x); };

for (const [i, row] of rows.entries()) {
  const clear = i % 97 === 5 ? 0 : Math.round(110 + rand() * 90);
  const seasons = { DJF: 0, MAM: 0, JJA: 0, SON: 0 };
  const perMonth = months.map(() => 0);
  let large = 0;
  const [clat, clon] = cellToLatLng(row.h3);
  const cc = (ts.by_country[row.country] ??= {
    name: countryNames[row.country],
    anchored_on_posidonia: months.map(() => 0),
    large_on_posidonia: months.map(() => 0),
  });
  for (let n = 0; n < row.on; n++) {
    const mi = pickMonth();
    const len = round(Math.max(8, Math.exp(Math.log(17) + randn() * 0.45)), 1);
    const isLarge = len >= 24;
    perMonth[mi]++;
    seasons[seasonOf(monthNum(months[mi]))]++;
    if (isLarge) large++;
    ts.anchored_on_posidonia[mi]++;
    cc.anchored_on_posidonia[mi]++;
    if (isLarge) { ts.large_on_posidonia[mi]++; cc.large_on_posidonia[mi]++; }
    points.lon.push(round(clon + randn() * 0.006, 5));
    points.lat.push(round(clat + randn() * 0.005, 5));
    points.month.push(mi);
    points.length_m.push(len);
    points.country.push(row.country);
  }
  const density = clear === 0 ? null : round(row.on / clear, 4);
  hexes.h3.push(row.h3);
  hexes.country.push(row.country);
  hexes.on_posidonia.push(row.on);
  hexes.large_on_posidonia.push(large);
  hexes.clear_overpasses.push(clear);
  hexes.density.push(density);
  hexes.posidonia_km2.push(round(0.2 + rand() * 4.6, 2));
  for (const s of Object.keys(seasons)) hexes.by_season[s].push(seasons[s]);
  const peak = perMonth.indexOf(Math.max(...perMonth));
  hotspotCandidates.push({
    h3: row.h3, lon: round(clon, 4), lat: round(clat, 4), country: row.country,
    place: row.center ? row.center.place : null,
    on_posidonia: row.on, large_on_posidonia: large, density, peak_month: months[peak],
  });
}

// UNK: a little bit of activity outside any EEZ (no hexes, only in timeseries)
ts.by_country.UNK = {
  name: countryNames.UNK,
  anchored_on_posidonia: months.map((m) => Math.round(monthWeight[monthNum(m)] * 2 * rand())),
  large_on_posidonia: months.map(() => 0),
};
months.forEach((_, i) => {
  ts.anchored_on_posidonia[i] += ts.by_country.UNK.anchored_on_posidonia[i];
  ts.anchored_total[i] = Math.round(ts.anchored_on_posidonia[i] * (3.2 + rand()) + 400 + rand() * 150);
});

// Sort points most recent first (as the pipeline does when capping)
const order = points.month.map((_, i) => i).sort((a, b) => points.month[b] - points.month[a]);
const sortedPoints = Object.fromEntries(Object.entries(points).map(([k, v]) => [k, order.map((i) => v[i])]));

const hotspots = hotspotCandidates
  .sort((a, b) => b.on_posidonia - a.on_posidonia || (b.density ?? 0) - (a.density ?? 0))
  .slice(0, 50);

// Posidonia polygons: irregular blobs near each region
const features = [];
let fid = 1;
for (const r of regions) {
  const nBlobs = 2 + Math.floor(rand() * 3);
  for (let b = 0; b < nBlobs; b++) {
    const cx = r.lon + randn() * 0.03;
    const cy = r.lat + randn() * 0.025;
    const rad = 0.008 + rand() * 0.02;
    const ring = [];
    const nv = 20;
    for (let v = 0; v < nv; v++) {
      const a = (v / nv) * 2 * Math.PI;
      const rr = rad * (0.6 + rand() * 0.6);
      ring.push([round(cx + Math.cos(a) * rr * 1.3, 5), round(cy + Math.sin(a) * rr, 5)]);
    }
    ring.push(ring[0]);
    features.push({ type: 'Feature', properties: { id: fid++ }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
}

const meta = {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  methodology_version: '1-fixture',
  months,
  h3_resolution: RES,
  params: { speed_kn_max: 1.0, posidonia_buffer_m: 20, large_length_m: 24 },
  sources: [
    { name: 'GFW Sentinel-2 vessel detections', license: 'CC0-1.0', url: 'https://globalfishingwatch.org/data-download/' },
    { name: 'EMODnet Seabed Habitats – seagrass EOV 2025', license: 'CC-BY-4.0', url: 'https://emodnet.ec.europa.eu/en/seabed-habitats' },
  ],
  bbox: [-6.0, 30.0, 36.5, 46.0],
};

const write = (name, obj) => writeFileSync(join(OUT, name), JSON.stringify(obj));
write('meta.json', meta);
write('timeseries.json', ts);
write('hexes.json', hexes);
write('points.json', sortedPoints);
write('hotspots.json', hotspots);
write('posidonia.geojson', { type: 'FeatureCollection', features });
console.log(`fixtures: ${hexes.h3.length} hexes, ${sortedPoints.lon.length} points, ${features.length} polygons, ${hotspots.length} hotspots -> ${OUT}`);
