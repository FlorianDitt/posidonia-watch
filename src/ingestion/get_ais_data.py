"""AIS ingestion and cleaning.

Loads raw AIS position reports (CSV exports from providers such as
MarineCadastre, Global Fishing Watch or national AIS networks), normalises
column names, removes invalid records and returns a GeoDataFrame in
EPSG:4326 ready for matching against SAR detections.
"""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pandas as pd

RAW_AIS_DIR = Path("data/raw/ais")
PROCESSED_AIS_PATH = Path("data/processed/ais_clean.parquet")

# Map common provider column names onto a single schema.
COLUMN_ALIASES = {
    "mmsi": "mmsi",
    "MMSI": "mmsi",
    "BaseDateTime": "timestamp",
    "timestamp": "timestamp",
    "LAT": "lat",
    "lat": "lat",
    "latitude": "lat",
    "LON": "lon",
    "lon": "lon",
    "longitude": "lon",
    "SOG": "sog",
    "speed": "sog",
    "COG": "cog",
    "course": "cog",
    "VesselType": "vessel_type",
}
REQUIRED_COLUMNS = ["mmsi", "timestamp", "lat", "lon"]


def load_ais_csv(path: Path) -> pd.DataFrame:
    """Read a raw AIS CSV and map its columns onto the project schema.

    Args:
        path: CSV file to read.

    Returns:
        DataFrame with at least ``mmsi``, ``timestamp``, ``lat`` and ``lon``.

    Raises:
        ValueError: If any required column is missing after renaming.
    """
    df = pd.read_csv(path).rename(columns=COLUMN_ALIASES)
    missing = set(REQUIRED_COLUMNS) - set(df.columns)
    if missing:
        raise ValueError(f"{path} is missing required columns: {sorted(missing)}")
    return df


def clean_ais(df: pd.DataFrame, max_speed_knots: float = 50.0) -> pd.DataFrame:
    """Remove invalid and duplicate AIS reports.

    Drops rows with unparsable timestamps, out-of-range coordinates,
    invalid MMSIs (not 9 digits) and implausible speeds, then removes exact
    duplicates and sorts by vessel and time.

    Args:
        df: Output of :func:`load_ais_csv`.
        max_speed_knots: Reports faster than this are treated as GPS noise.

    Returns:
        Cleaned DataFrame.
    """
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=REQUIRED_COLUMNS)
    df = df[df["lat"].between(-90, 90) & df["lon"].between(-180, 180)]
    df = df[df["mmsi"].astype("int64").between(100_000_000, 999_999_999)]
    if "sog" in df.columns:
        df = df[df["sog"].isna() | (df["sog"] <= max_speed_knots)]
    return df.drop_duplicates().sort_values(["mmsi", "timestamp"]).reset_index(drop=True)


def to_geodataframe(df: pd.DataFrame) -> gpd.GeoDataFrame:
    """Convert a cleaned AIS DataFrame into a point GeoDataFrame (EPSG:4326)."""
    return gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df["lon"], df["lat"]), crs="EPSG:4326")


def ingest_ais(raw_dir: Path = RAW_AIS_DIR, out_path: Path = PROCESSED_AIS_PATH) -> gpd.GeoDataFrame:
    """Load, clean and persist every AIS CSV in ``raw_dir``.

    Args:
        raw_dir: Directory containing raw ``*.csv`` files.
        out_path: Destination GeoParquet file.

    Returns:
        The combined, cleaned GeoDataFrame.
    """
    frames = [clean_ais(load_ais_csv(p)) for p in sorted(raw_dir.glob("*.csv"))]
    if not frames:
        raise FileNotFoundError(f"No AIS CSV files found in {raw_dir}")
    gdf = to_geodataframe(pd.concat(frames, ignore_index=True))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(out_path)
    return gdf


if __name__ == "__main__":
    result = ingest_ais()
    print(f"Wrote {len(result):,} AIS reports to {PROCESSED_AIS_PATH}")
