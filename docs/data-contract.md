# Data contract: pipeline → web

The Python pipeline (`pipeline/`) writes these files to `web/public/data/`.
The Astro site (`web/`) only reads them. Neither side may change a file's
shape without updating this document first.

All coordinates are WGS84 (EPSG:4326). All months are `"YYYY-MM"` strings.
JSON is minified, UTF-8.

## Concepts

- **Detection**: one vessel seen in one Sentinel-2 image (GFW dataset, CC0).
- **Anchored**: detection with `speed_kn_inferred` below the configured
  threshold (default 1.0 kn), passing the quality filters in
  `pipeline/config.yaml` (presence score, not infrastructure, not ice,
  low cloud score).
- **On Posidonia**: anchored detection whose position lies inside a
  *Posidonia oceanica* polygon from EMODnet Seabed Habitats
  (`emodnet_open:seagrass_eov_poly_2025`, `habsubtype = 'Posidonia oceanica'`),
  buffered by `posidonia_buffer_m` (default 20 m, GPS/pixel uncertainty).
- **Large**: `length_m_inferred >= 24` (the French 2020 anchoring threshold).
- **Clear overpasses**: per H3 cell and month, `overpasses_cloud_under_20`
  from GFW's `sentinel2_overpass_YYYYMM.csv`. Used to normalise for how often
  a place was actually observed.
- **Density**: `on_posidonia / clear_overpasses` = average number of boats
  anchored on Posidonia in that cell at the moment of a clear image.
  `null` when `clear_overpasses == 0`.

## `meta.json`

```json
{
  "generated_at": "2026-10-06T12:00:00Z",
  "methodology_version": "1",
  "months": ["2019-01", "..."],
  "h3_resolution": 7,
  "params": { "speed_kn_max": 1.0, "posidonia_buffer_m": 20, "large_length_m": 24 },
  "sources": [
    { "name": "GFW Sentinel-2 vessel detections", "license": "CC0-1.0", "url": "https://zenodo.org/records/..." },
    { "name": "EMODnet Seabed Habitats – Seagrass cover (EOV), version 2025", "license": "CC-BY-4.0", "url": "https://emodnet.ec.europa.eu/geonetwork/srv/eng/catalog.search#/metadata/39746d9c-4220-425c-bc26-7cb3056c36a5" },
    { "name": "Flanders Marine Institute – Maritime Boundaries Geodatabase (EEZ), version 12", "license": "CC-BY-4.0", "url": "https://doi.org/10.14284/632" }
  ],
  "bbox": [-6.0, 30.0, 36.5, 46.0]
}
```

## `timeseries.json`

Mediterranean-wide totals per month, same order as `meta.months`.

```json
{
  "months": ["2019-01", "..."],
  "anchored_total":      [0, 0],
  "anchored_on_posidonia": [0, 0],
  "large_on_posidonia":  [0, 0],
  "by_country": {
    "FRA": { "name": "France", "anchored_on_posidonia": [0, 0], "large_on_posidonia": [0, 0] }
  }
}
```

`by_country` is keyed by ISO3 of the EEZ the detection falls in (Marine
Regions). Key `"UNK"` for detections outside any EEZ or if EEZ lookup is
unavailable.

## `hexes.json`

One row per H3 cell (resolution in `meta.h3_resolution`) that intersects
Posidonia, aggregated over **all months**. Compact columnar layout:

```json
{
  "h3":                ["871e..."],
  "country":           ["FRA"],
  "on_posidonia":      [12],
  "large_on_posidonia":[3],
  "clear_overpasses":  [140],
  "density":           [0.0857],
  "posidonia_km2":     [1.9],
  "by_season": { "DJF": [0], "MAM": [2], "JJA": [9], "SON": [1] },
  "by_season_large": { "DJF": [0], "MAM": [1], "JJA": [2], "SON": [0] },
  "by_season_clear_overpasses": { "DJF": [30], "MAM": [38], "JJA": [44], "SON": [28] }
}
```

`by_season` is `on_posidonia` per meteorological season (all years),
`by_season_large` likewise for `large_on_posidonia`, and
`by_season_clear_overpasses` is `clear_overpasses` per season, so the web can
compute seasonal density as `by_season / by_season_clear_overpasses`.

All arrays have equal length. The web app builds polygons with `h3-js`.

## `hexes_monthly.json`

The same cells as `hexes.json`, split by month, so the web can aggregate any
month range or season. `cell` indexes the arrays of `hexes.json`, `month`
indexes `meta.months`.

```json
{
  "months": ["2019-01", "..."],
  "cell":               [0, 0, 7],
  "month":              [3, 4, 4],
  "on_posidonia":       [2, 5, 1],
  "large_on_posidonia": [1, 2, 0],
  "clear_overpasses":   [4, 3, 0, "..."]
}
```

`cell`, `month`, `on_posidonia` and `large_on_posidonia` are sparse rows,
only where `on_posidonia > 0`. `clear_overpasses` is dense, cell-major:
the value for cell `i` and month `k` is at `i * len(months) + k`. Summing
`on_posidonia` over all rows equals the total in `hexes.json`.

## `points.json`

Individual anchored-on-Posidonia detections, for zoomed-in views.
Columnar, capped at 200 000 rows (most recent first if capped).

```json
{
  "lon":   [3.12345],
  "lat":   [42.12345],
  "month": [87],
  "length_m": [31.5],
  "country": ["FRA"]
}
```

`month` is an index into `meta.months`. Coordinates rounded to 5 decimals.

## `posidonia.geojson`

Posidonia polygons for the map overlay, simplified (target < 10 MB),
properties reduced to `{ "id": int }`. FeatureCollection of Polygon /
MultiPolygon.

## `hotspots.json`

Top 50 cells by `on_posidonia` (ties broken by density):

```json
[
  { "h3": "871e...", "lon": 3.1, "lat": 42.5, "country": "FRA",
    "place": "Baie de Pampelonne", "on_posidonia": 120, "large_on_posidonia": 40,
    "density": 0.8, "peak_month": "2025-08" }
]
```

`place` may be `null` (optional reverse-geocoding, not required).
