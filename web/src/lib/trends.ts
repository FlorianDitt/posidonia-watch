import { loadJson, fmtInt, fmtMonth, escapeHtml, type Timeseries, type Meta } from './data';
import { lineChart, niceMax } from './chart';

const sum = (a: (number | null)[]) => a.reduce<number>((s, v) => s + (v ?? 0), 0);

export async function initTrends() {
  const [ts, meta] = await Promise.all([loadJson<Timeseries>('timeseries.json'), loadJson<Meta>('meta.json')]);
  const content = document.getElementById('trends-content')!;
  const empty = document.getElementById('trends-empty')!;
  if (!ts || !Array.isArray(ts.months) || ts.months.length === 0) {
    content.hidden = true;
    empty.hidden = false;
    return;
  }
  const large = meta?.params?.large_length_m ?? 24;
  const months = ts.months;
  const onPos = ts.anchored_on_posidonia ?? [];
  const largeOn = ts.large_on_posidonia ?? [];
  const total = ts.anchored_total ?? [];

  lineChart(document.getElementById('chart-main')!, {
    months,
    height: 320,
    yLabel: 'Detections per month',
    ariaLabel: `Line chart of monthly detections anchored on Posidonia, ${fmtMonth(months[0])} to ${fmtMonth(months.at(-1))}. Total ${fmtInt(sum(onPos))}, of which ${fmtInt(sum(largeOn))} large`,
    directLabels: true,
    series: [
      { label: 'On Posidonia', values: onPos, color: 'var(--series-1)' },
      { label: `Large (≥ ${large} m)`, values: largeOn, color: 'var(--series-2)' },
    ],
  });

  lineChart(document.getElementById('chart-context')!, {
    months,
    height: 200,
    yLabel: 'Detections per month',
    ariaLabel: `Line chart of all anchored detections per month, total ${fmtInt(sum(total))}`,
    series: [{ label: 'All anchored', values: total, color: 'var(--series-context)' }],
  });

  const grid = document.getElementById('country-grid')!;
  const shared = document.getElementById('shared-scale') as HTMLInputElement;
  const countries = Object.entries(ts.by_country ?? {})
    .map(([code, c]) => ({ code, ...c, total: sum(c.anchored_on_posidonia ?? []) }))
    .filter((c) => c.total > 0)
    .sort((a, b) => (a.code === 'UNK' ? 1 : b.code === 'UNK' ? -1 : b.total - a.total));

  let disposers: (() => void)[] = [];
  function renderCountries() {
    disposers.forEach((d) => d());
    disposers = [];
    if (countries.length === 0) {
      grid.innerHTML = '<p class="text-sm text-muted">No per-country data.</p>';
      return;
    }
    const globalMax = niceMax(Math.max(...countries.flatMap((c) => c.anchored_on_posidonia ?? [])), 2);
    grid.innerHTML = countries
      .map((c, k) => `
        <figure class="rounded-xl border border-line bg-surface p-3">
          <figcaption class="flex items-baseline justify-between gap-2 px-1">
            <span class="font-medium">${escapeHtml(c.name || c.code)}</span>
            <span class="text-xs text-muted tabular">${fmtInt(c.total)} total · ${fmtInt(sum(c.large_on_posidonia ?? []))} large</span>
          </figcaption>
          <div id="cm-${k}" class="mt-2"></div>
        </figure>`)
      .join('');
    countries.forEach((c, k) => {
      disposers.push(
        lineChart(document.getElementById(`cm-${k}`)!, {
          months,
          height: 150,
          compact: true,
          yLabel: 'Detections per month',
          yMax: shared.checked ? globalMax : undefined,
          ariaLabel: `${c.name}: monthly detections anchored on Posidonia, total ${fmtInt(c.total)}`,
          series: [
            { label: 'On Posidonia', values: c.anchored_on_posidonia ?? [], color: 'var(--series-1)' },
            { label: `Large (≥ ${large} m)`, values: c.large_on_posidonia ?? [], color: 'var(--series-2)' },
          ],
        }),
      );
    });
  }
  shared.addEventListener('change', renderCountries);
  renderCountries();

  const table = document.getElementById('data-table')!;
  table.innerHTML =
    `<caption class="sr-only">Monthly Mediterranean totals</caption>
     <thead><tr class="border-b border-line text-left text-muted">
       <th scope="col" class="py-1.5 pr-4 font-medium">Month</th>
       <th scope="col" class="py-1.5 pr-4 text-right font-medium">On Posidonia</th>
       <th scope="col" class="py-1.5 pr-4 text-right font-medium">Large on Posidonia</th>
       <th scope="col" class="py-1.5 text-right font-medium">All anchored</th></tr></thead><tbody>` +
    months
      .map((m, i) => `<tr class="border-b border-line/60"><th scope="row" class="py-1 pr-4 text-left font-normal">${escapeHtml(fmtMonth(m))}</th>
        <td class="py-1 pr-4 text-right">${fmtInt(onPos[i])}</td><td class="py-1 pr-4 text-right">${fmtInt(largeOn[i])}</td><td class="py-1 text-right">${fmtInt(total[i])}</td></tr>`)
      .join('') +
    '</tbody>';
}
