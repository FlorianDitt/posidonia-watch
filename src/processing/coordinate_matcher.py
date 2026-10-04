"""SAR vessel detection and AIS cross-referencing.

Detects bright point targets (likely vessels) in Sentinel-1 backscatter,
converts them to geographic coordinates, and matches each detection to AIS
reports close in space and time. Detections with no AIS match are flagged
as candidate "dark" vessels.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.transform import xy
from skimage import measure

PROCESSED_DIR = Path("data/processed")


def load_sar_band(path: Path) -> tuple[np.ndarray, rasterio.Affine, rasterio.crs.CRS]:
    """Read the first band of a georeferenced SAR raster.

    Args:
        path: GeoTIFF of calibrated backscatter (e.g. VV, linear or dB).

    Returns:
        Tuple of ``(array, affine transform, CRS)``.
    """
    with rasterio.open(path) as src:
        return src.read(1).astype("float32"), src.transform, src.crs


def detect_radar_anomalies(
    band: np.ndarray,
    k_sigma: float = 5.0,
    min_pixels: int = 4,
) -> pd.DataFrame:
    """Find bright, compact targets against the sea-clutter background.

    A simplified CFAR (Constant False Alarm Rate) detector: pixels brighter
    than ``mean + k_sigma * std`` of the scene are thresholded and grouped
    into connected components. Production use should replace the global
    statistics with a sliding-window CFAR and apply a land mask first.

    Args:
        band: 2-D backscatter array.
        k_sigma: Threshold in standard deviations above the mean.
        min_pixels: Minimum component area to keep (suppresses speckle).

    Returns:
        DataFrame with ``row``, ``col`` (centroid) and ``area`` per detection.
    """
    valid = np.isfinite(band)
    threshold = band[valid].mean() + k_sigma * band[valid].std()
    labels = measure.label(valid & (band > threshold), connectivity=2)
    regions = [r for r in measure.regionprops(labels) if r.area >= min_pixels]
    return pd.DataFrame(
        {
            "row": [r.centroid[0] for r in regions],
            "col": [r.centroid[1] for r in regions],
            "area": [r.area for r in regions],
        }
    )


def detections_to_geodataframe(
    detections: pd.DataFrame,
    transform: rasterio.Affine,
    crs: rasterio.crs.CRS,
    acquired_at: datetime,
) -> gpd.GeoDataFrame:
    """Convert pixel-space detections into geographic points (EPSG:4326).

    Args:
        detections: Output of :func:`detect_radar_anomalies`.
        transform: Affine transform of the source raster.
        crs: CRS of the source raster.
        acquired_at: Scene acquisition time (UTC), attached to every row.

    Returns:
        GeoDataFrame of detections with an ``acquired_at`` column.
    """
    xs, ys = xy(transform, detections["row"].to_numpy(), detections["col"].to_numpy())
    gdf = gpd.GeoDataFrame(detections.copy(), geometry=gpd.points_from_xy(xs, ys), crs=crs)
    ts = pd.Timestamp(acquired_at)
    gdf["acquired_at"] = ts.tz_localize("UTC") if ts.tzinfo is None else ts
    return gdf.to_crs("EPSG:4326")


def match_detections_to_ais(
    detections: gpd.GeoDataFrame,
    ais: gpd.GeoDataFrame,
    max_distance_m: float = 1_000.0,
    time_window: timedelta = timedelta(minutes=30),
    metric_crs: str = "EPSG:3857",
) -> gpd.GeoDataFrame:
    """Cross-reference SAR detections with AIS positions.

    AIS reports are first filtered to ``acquired_at ± time_window``, then each
    detection is joined to its nearest AIS report within ``max_distance_m``.
    Detections with no match are flagged ``is_dark = True``.

    Args:
        detections: Output of :func:`detections_to_geodataframe`.
        ais: Cleaned AIS GeoDataFrame from ``get_ais_data.ingest_ais``.
        max_distance_m: Maximum detection-to-AIS distance to count as a match.
        time_window: Allowed time offset between SAR acquisition and AIS ping.
        metric_crs: Projected CRS used for distance computation. Swap for a
            local UTM zone for better accuracy away from the equator.

    Returns:
        Detections with ``mmsi``, ``match_distance_m`` and ``is_dark`` columns.
    """
    acquired_at = detections["acquired_at"].iloc[0]
    in_window = ais[(ais["timestamp"] - acquired_at).abs() <= time_window]

    matched = gpd.sjoin_nearest(
        detections.to_crs(metric_crs),
        in_window[["mmsi", "timestamp", "geometry"]].to_crs(metric_crs),
        how="left",
        max_distance=max_distance_m,
        distance_col="match_distance_m",
    )
    # Keep one AIS match per detection (the nearest).
    matched = matched.sort_values("match_distance_m").loc[lambda d: ~d.index.duplicated()].sort_index()
    matched["is_dark"] = matched["mmsi"].isna()
    return matched.drop(columns="index_right").to_crs("EPSG:4326")


def flag_dark_vessels(
    sar_path: Path,
    acquired_at: datetime,
    ais: gpd.GeoDataFrame,
    out_dir: Path = PROCESSED_DIR,
) -> gpd.GeoDataFrame:
    """Run detection and AIS matching for one SAR scene and save the results.

    Args:
        sar_path: Calibrated, georeferenced SAR GeoTIFF.
        acquired_at: Scene acquisition time (UTC).
        ais: Cleaned AIS GeoDataFrame.
        out_dir: Directory for the output GeoJSON.

    Returns:
        All detections, with dark candidates marked by ``is_dark``.
    """
    band, transform, crs = load_sar_band(sar_path)
    detections = detections_to_geodataframe(detect_radar_anomalies(band), transform, crs, acquired_at)
    result = match_detections_to_ais(detections, ais)
    out_dir.mkdir(parents=True, exist_ok=True)
    result.to_file(out_dir / f"{sar_path.stem}_detections.geojson", driver="GeoJSON")
    return result
