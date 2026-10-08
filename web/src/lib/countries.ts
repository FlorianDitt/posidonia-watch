// ISO3 -> display name. Names from timeseries.json `by_country` take precedence.
const names: Record<string, string> = {
  ALB: 'Albania', BIH: 'Bosnia and Herzegovina', CYP: 'Cyprus', DZA: 'Algeria', EGY: 'Egypt',
  ESP: 'Spain', FRA: 'France', GBR: 'United Kingdom', GIB: 'Gibraltar', GRC: 'Greece',
  HRV: 'Croatia', ISR: 'Israel', ITA: 'Italy', LBN: 'Lebanon', LBY: 'Libya', MAR: 'Morocco',
  MCO: 'Monaco', MLT: 'Malta', MNE: 'Montenegro', PSE: 'Palestine', SVN: 'Slovenia',
  SYR: 'Syria', TUN: 'Tunisia', TUR: 'Türkiye', UNK: 'Outside EEZ / unknown',
};

export function setCountryNames(extra: Record<string, string>) {
  for (const [k, v] of Object.entries(extra)) if (v) names[k] = v;
}

export const countryName = (iso3: string | null | undefined) => (iso3 ? names[iso3] ?? iso3 : 'Unknown');

// Flag states of AIS matches come as ISO2 (from the MMSI's MID); names from the browser's own region list.
let regionNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  // very old browser: show the code
}

export const flagName = (iso2: string) => regionNames?.of(iso2) ?? iso2;

/** Regional-indicator pair, e.g. 'FR' -> 🇫🇷. Some systems (Windows) render it as the two letters. */
export const flagEmoji = (iso2: string) =>
  /^[A-Z]{2}$/.test(iso2) ? String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
