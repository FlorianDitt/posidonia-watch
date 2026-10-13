# AIS matching and Sentinel-1

How posidonia-watch uses the AIS information that ships with the GFW
Sentinel-2 detections, what it publishes from it, and why Sentinel-1 radar
detections are not used. Checked on 2026-10-08.

## Where the AIS data comes from

The GFW Sentinel-2 detection files on Zenodo (CC0) already contain GFW's own
match of each detection against AIS broadcasts. Every release from the 2019
annual file to 2026-08 has these columns:

| Column | Meaning |
|---|---|
| `mmsi` | AIS identifier of the matched vessel, empty if no match |
| `matching_score`, `matching_score_secondary` | raw scores of the best and second-best AIS candidate |
| `matching_confidence` | 0–1 confidence of the match |
| `ais_lat/lon_before`, `ais_lat/lon_after` | the AIS positions just before and after the image |
| `ais_speed_kn_before`, `ais_speed_kn_after` | speed over ground the vessel reported at those positions |
| `ais_course_before`, `ais_course_after` | course it reported |
| `ais_timestamp_before`, `ais_timestamp_after` | times of those two AIS messages |
| `ais_length_m` | length from the vessel's AIS static data |

So AIS matching needs no API access and no extra licence. The GFW API token
in `.example.env` is not needed for any of this.

## Finding: the inferred speed lets many moving boats through

The site counts a detection as anchored when GFW's speed estimate from the
image (`speed_kn_inferred`) is below 1 kn. For matched boats, AIS gives an
independent check: the speed the boat itself reported a few minutes before
and after the image.

Detections the site counts as **anchored on Posidonia**, restricted to AIS
matches with `matching_confidence >= 0.9` and both AIS speeds present
(speed is the mean of before and after):

| | 2026-08 | 2025-07 |
|---|---|---|
| Anchored on Posidonia | 11 744 | 5 304 |
| … with any AIS match | 48 % | 57 % |
| … with a high-confidence match and AIS speeds | 1 835 (16 %) | 920 (17 %) |
| AIS speed < 1 kn (really stationary) | 57 % | 62 % |
| AIS speed 1–5 kn | 18 % | 15 % |
| AIS speed ≥ 5 kn | 26 % | 24 % |
| Boats < 24 m that are really stationary | 48 % | 51 % |

The two AIS messages are close to the image: a median of 2.3 min apart in
2026-08 (90th percentile 6.7 min).

**These are not wrong matches.** For the group AIS reports at ≥ 5 kn
(2026-08, n = 472):

- the AIS track, interpolated to the image time, passes a median of 23 m
  from the detection (90th percentile 61 m);
- the two AIS positions really are apart: the distance between them over
  the time between them gives a median of 6.3 kn;
- the image-based estimate for the same boats is a median of 0.4 kn.

They are correctly matched boats that were under way while the image was
taken. Roughly 40 % of the AIS-verifiable "anchored on Posidonia"
detections were moving.

**Limits of this check:**

- It covers only the 16–17 % with a confident match. Matched boats are
  larger than average (median ~25 m) and more often commercial, so the
  share for small yachts without AIS is unknown.
- Two months only. The pipeline will compute it for every month (see
  below).
- A boat at 1–2 kn may be manoeuvring onto its anchor. The clear problem is
  the ≥ 5 kn group.

What this means for the published counts: they include boats that were not
anchored. AIS can show this for matched boats, but cannot correct it for
the others. Whether the site should drop or flag AIS-moving detections is
an open decision. For now the pipeline publishes the AIS speed so the
effect is visible, and the counts are unchanged.

## What is published, and what is not

AIS data from a private yacht is personal data under the GDPR: the MMSI
identifies the vessel and through it the owner. The site shows anchoring
*pressure*, not who anchored where, so:

**Not published, in any form:** `mmsi` (also not hashed: a hash is still
pseudonymous personal data and would let anyone follow one boat across
images), vessel names, IMO numbers, exact AIS timestamps or AIS positions.

**Published per detection** (`points.json`):

- whether there is a match, and its confidence (rounded down to 2 decimals);
- for a confident match, the AIS-reported speed (mean of before/after,
  rounded down to 1 decimal) and length;
- for a confident match, the flag state: the country of registration, from
  the first three digits of the MMSI (its Maritime Identification Digits,
  assigned by the ITU).
  The table is in `pipeline/src/posidonia_watch/flags.py`.

The detection's position and month are already public. None of the added
fields identifies a vessel on its own: a flag is shared by thousands of
boats, and the MMSI it comes from is not published.

**Published as counts**, per month (`timeseries.json`) and per hexagon and
month (`hexes_monthly.json`): how many detections on Posidonia had a
confident match, and how many of those AIS shows as stationary. The map uses
the per-hexagon counts for its "AIS match" and "AIS: anchored" views.

The MMSI is still read into the pipeline's local cache (needed to tell a
match from no match), and is dropped before anything is written to
`web/public/data/`.

Vessel *type* is not in the Zenodo files. It would need the GFW API, whose
licence rules it out (see below).

## Why Sentinel-1 is not used

A Sentinel-1 radar layer was considered: radar sees through clouds and at
night, so it would fill the summer-heavy bias of the optical detections.
It is not used, for three reasons:

1. **It excludes the coastal strip where anchoring happens.** GFW's SAR
   detections come from the models of Paolo et al. (2024): "We do not
   classify objects within 1 km of shore, because of ambiguous coastlines
   and rocks", and "much of the vessel activity within 1 km of shore is by
   smaller boats, such as pleasure crafts". Posidonia anchorages are
   largely inside that strip. (The paper describes the 1 km buffer. The
   API documentation does not state it separately; the API data comes from
   the same models.)
2. **Resolution.** Sentinel-1 imagery is about 20 m, against 10 m for
   Sentinel-2, so many anchored yachts are below its detection limit.
3. **Licence.** The detections are only available through the GFW API,
   whose data is CC BY-NC 4.0 and must be credited "Powered by Global
   Fishing Watch". The site publishes its data under CC BY 4.0, so radar
   results could not be mixed in without splitting the licence.

A radar layer could still make sense for offshore anchoring (more than
1 km from shore), but it would add little for Posidonia.

## Sources

- Global Fishing Watch, *Vessel detections from Sentinel 2*, Zenodo,
  <https://doi.org/10.5281/zenodo.15978308> (CC0). Column check and
  statistics above: releases 2025-07 (record 16911647) and 2026-08 (record
  22844774).
- Paolo, F. et al. (2024). *Satellite mapping reveals extensive industrial
  activity at sea.* Nature 625, 85–91.
  <https://doi.org/10.1038/s41586-023-06825-8>
- Global Fishing Watch API, *License & rate limits*,
  <https://globalfishingwatch.org/our-apis/documentation/docs/license-rate-limits>
