# dark-vessel-tracker

Detect "dark" fishing vessels (ships that switch off or never transmit their AIS transponder) by correlating public **AIS** tracking data with **Sentinel-1 SAR** (Synthetic Aperture Radar) satellite imagery.

Radar sees through cloud and darkness and picks up any large metal hull on the sea surface. AIS only shows the vessels that choose to report their position. A ship that appears in a SAR scene but has no matching AIS signal is a strong lead for investigation.

---

## Impact Value

Illegal, Unreported and Unregulated (IUU) fishing is estimated to account for up to one in five fish caught worldwide, costing coastal economies billions of dollars a year. It depletes stocks that small-scale fishers depend on and is often tied to forced labour and other organised crime. Vessels engaged in IUU fishing commonly disable AIS to avoid detection in marine protected areas (MPAs) and exclusive economic zones (EEZs).

This project helps NGOs, researchers and under-resourced coastal authorities:

- **See the unseen.** It surfaces vessels that are deliberately hiding from AIS-only monitoring platforms.
- **Prioritise patrols.** Enforcement fleets are small and oceans are large. A ranked list of dark-vessel candidates with coordinates and timestamps tells them where to send patrol boats, aircraft or drones.
- **Build evidence.** Reproducible, timestamped detections from public satellite data can back up advocacy, journalism, port-state measures and policy work.
- **Keep costs low.** Sentinel-1 data is free and open under the Copernicus programme, and the whole stack is open source. Organisations without commercial satellite budgets can run it.
- **Protect MPAs.** Monitoring can focus on no-take zones, where any fishing vessel is a likely violation.

> SAR detections are *leads*, not proof. Matches can be wrong because of AIS latency, small vessels below the radar's resolution, offshore infrastructure or sea-state false positives. Check results before acting on them.

---

## Architecture

```
            ┌────────────────────────┐        ┌────────────────────────┐
            │  Copernicus catalogue  │        │  AIS provider (CSV)    │
            │  Sentinel-1 GRD scenes │        │  MarineCadastre, GFW…  │
            └───────────┬────────────┘        └───────────┬────────────┘
                        │                                 │
     src/ingestion/get_sentinel_sar.py        src/ingestion/get_ais_data.py
       authenticate → search by bbox            load → normalise columns
       → download to data/raw/sar               → clean → GeoDataFrame
                        │                                 │
                        ▼                                 ▼
               data/raw/sar/*.zip            data/processed/ais_clean.parquet
                        │                                 │
          (preprocess: calibrate,                         │
           terrain-correct, land-mask)                    │
                        │                                 │
                        └──────────────┬──────────────────┘
                                       ▼
                    src/processing/coordinate_matcher.py
                      1. detect_radar_anomalies   (CFAR-style thresholding)
                      2. detections_to_geodataframe (pixel → lon/lat)
                      3. match_detections_to_ais  (space ± time window)
                      4. flag_dark_vessels        (no AIS match → is_dark)
                                       │
                                       ▼
                 data/processed/<scene>_detections.geojson
                                       │
                                       ▼
                      notebooks/  (EDA, validation, maps)
```

### Project layout

```
dark-vessel-tracker/
├── data/
│   ├── raw/            # Downloaded SAR scenes and raw AIS CSVs (git-ignored)
│   └── processed/      # Cleaned AIS, detections, outputs (git-ignored)
├── models/             # Trained detectors / classifiers (git-ignored)
├── notebooks/
│   └── 01_sar_ais_exploration.ipynb
├── src/
│   ├── ingestion/
│   │   ├── get_sentinel_sar.py
│   │   └── get_ais_data.py
│   └── processing/
│       └── coordinate_matcher.py
├── pyproject.toml      # Dependencies (managed with uv)
├── uv.lock             # Pinned, reproducible dependency versions
└── README.md
```

---

## Setup

**Prerequisites:** [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`). uv downloads a matching Python version (pinned in `.python-version`) if you don't have one. GDAL comes bundled in the `rasterio` and `geopandas` wheels.

```bash
git clone <repo-url> dark-vessel-tracker
cd dark-vessel-tracker

uv sync                      # creates the venv and installs the exact versions from uv.lock
mkdir -p data/raw/sar data/raw/ais data/processed models
```

Dependencies are declared in `pyproject.toml` and pinned in `uv.lock`; commit both. Add new packages with `uv add <package>` (or `uv add --dev <package>` for tooling such as Jupyter).

> **Project on an exFAT/FAT drive (e.g. external SSD)?** These filesystems don't support symlinks, so a `.venv` cannot live in the project folder. Keep the environment on your home disk instead:
> `export UV_PROJECT_ENVIRONMENT="$HOME/.venvs/dark-vessel-tracker"` (add it to your shell profile).

Create a `.env` file in the project root (it is git-ignored) with your Copernicus credentials:

```dotenv
COPERNICUS_USER=your_username
COPERNICUS_PASSWORD=your_password
# Optional: override the catalogue endpoint
# COPERNICUS_API_URL=https://...
```

> **Note on data access:** the original Copernicus Open Access Hub that `sentinelsat` was built for has been retired and replaced by the [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/) (CDSE). `get_sentinel_sar.py` is written against the `sentinelsat` interface, so you need to point `COPERNICUS_API_URL` at a compatible endpoint or swap the client for CDSE's OData/STAC API. The function signatures are designed so that only `authenticate` and `search_sar_tiles` need to change.

---

## Running the pipeline

All commands are run from the project root.

**1. Download SAR scenes** for an area of interest (edit the bounding box and dates in the `__main__` block, or call the function directly):

```bash
uv run python -m src.ingestion.get_sentinel_sar
```

```python
from datetime import date
from src.ingestion.get_sentinel_sar import fetch_sar_for_bbox

fetch_sar_for_bbox((-92.5, -2.0, -88.5, 1.5), date(2024, 1, 1), date(2024, 1, 7))
```

**2. Ingest AIS data.** Place raw AIS CSV files in `data/raw/ais/`, then run:

```bash
uv run python -m src.ingestion.get_ais_data
```

**3. Preprocess SAR.** Calibrate and terrain-correct each GRD scene to a GeoTIFF, for example with ESA SNAP or `pyroSAR`. This step is not automated yet.

**4. Detect and flag dark vessels:**

```python
from datetime import datetime, timezone
from pathlib import Path
import geopandas as gpd
from src.processing.coordinate_matcher import flag_dark_vessels

ais = gpd.read_parquet("data/processed/ais_clean.parquet")
result = flag_dark_vessels(
    Path("data/raw/sar/scene_vv.tif"),
    acquired_at=datetime(2024, 1, 3, 11, 42, tzinfo=timezone.utc),
    ais=ais,
)
print(result[result.is_dark])
```

**5. Explore the results:**

```bash
uv run jupyter notebook notebooks/01_sar_ais_exploration.ipynb
```

---

## Roadmap

- Sliding-window CFAR detector with land/coastline masking
- Automated SAR preprocessing (calibration, speckle filtering, terrain correction)
- ML classifier in `models/` to separate vessels from platforms, rocks and ambiguities
- Interpolation of AIS tracks to the exact SAR acquisition time
- Restricting matching to MPA/EEZ polygons, and map dashboards for NGO partners
