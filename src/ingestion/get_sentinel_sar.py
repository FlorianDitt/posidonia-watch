"""Sentinel-1 SAR ingestion.

Authenticates against a Copernicus catalogue, searches for Sentinel-1 GRD
scenes that intersect an area of interest, and downloads them to
``data/raw/sar``.

Credentials are read from the environment (``COPERNICUS_USER`` /
``COPERNICUS_PASSWORD``), typically loaded from a local ``.env`` file.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

from dotenv import load_dotenv
from sentinelsat import SentinelAPI
from shapely.geometry import box

DEFAULT_API_URL = os.getenv("COPERNICUS_API_URL", "https://apihub.copernicus.eu/apihub")
RAW_SAR_DIR = Path("data/raw/sar")

BBox = tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat), EPSG:4326


def authenticate(
    user: str | None = None,
    password: str | None = None,
    api_url: str = DEFAULT_API_URL,
) -> SentinelAPI:
    """Create an authenticated Sentinel API client.

    Args:
        user: Copernicus username. Falls back to ``COPERNICUS_USER``.
        password: Copernicus password. Falls back to ``COPERNICUS_PASSWORD``.
        api_url: Catalogue endpoint.

    Returns:
        A ``SentinelAPI`` client ready for queries.

    Raises:
        RuntimeError: If no credentials are available.
    """
    load_dotenv()
    user = user or os.getenv("COPERNICUS_USER")
    password = password or os.getenv("COPERNICUS_PASSWORD")
    if not user or not password:
        raise RuntimeError("Set COPERNICUS_USER and COPERNICUS_PASSWORD (e.g. in .env).")
    return SentinelAPI(user, password, api_url)


def bbox_to_wkt(bbox: BBox) -> str:
    """Convert a ``(min_lon, min_lat, max_lon, max_lat)`` bounding box to WKT."""
    return box(*bbox).wkt


def search_sar_tiles(
    api: SentinelAPI,
    bbox: BBox,
    start: date,
    end: date,
    product_type: str = "GRD",
    sensor_mode: str = "IW",
) -> dict:
    """Search for Sentinel-1 scenes intersecting a bounding box.

    Args:
        api: Authenticated client from :func:`authenticate`.
        bbox: Area of interest in EPSG:4326.
        start: First acquisition date (inclusive).
        end: Last acquisition date (inclusive).
        product_type: Sentinel-1 product type; ``GRD`` suits vessel detection.
        sensor_mode: Acquisition mode; ``IW`` (Interferometric Wide) is the
            default mode over most coastal waters.

    Returns:
        Mapping of product ID to product metadata.
    """
    return api.query(
        bbox_to_wkt(bbox),
        date=(start, end),
        platformname="Sentinel-1",
        producttype=product_type,
        sensoroperationalmode=sensor_mode,
    )


def download_sar_tiles(
    api: SentinelAPI,
    products: dict,
    out_dir: Path = RAW_SAR_DIR,
) -> list[Path]:
    """Download the given Sentinel-1 products.

    Args:
        api: Authenticated client from :func:`authenticate`.
        products: Result of :func:`search_sar_tiles`.
        out_dir: Destination directory; created if missing.

    Returns:
        Paths of the downloaded archives.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    downloaded, _triggered, _failed = api.download_all(products, directory_path=str(out_dir))
    return [Path(meta["path"]) for meta in downloaded.values()]


def fetch_sar_for_bbox(bbox: BBox, start: date, end: date, out_dir: Path = RAW_SAR_DIR) -> list[Path]:
    """Authenticate, search and download SAR tiles for a bounding box in one call."""
    api = authenticate()
    products = search_sar_tiles(api, bbox, start, end)
    return download_sar_tiles(api, products, out_dir)


if __name__ == "__main__":
    # Example: waters around the Galápagos Marine Reserve.
    paths = fetch_sar_for_bbox((-92.5, -2.0, -88.5, 1.5), date(2024, 1, 1), date(2024, 1, 7))
    print(f"Downloaded {len(paths)} tile(s) to {RAW_SAR_DIR}")
