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
