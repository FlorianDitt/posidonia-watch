"""Reference geodata: Posidonia polygons (EMODnet), EEZs (Marine Regions), H3 cells."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import requests
import shapely
from shapely.geometry import Polygon, box

log = logging.getLogger(__name__)

# Lambert azimuthal equal-area centred on the Mediterranean: equal-area (for
# km2) and with < ~1.5 % distance distortion across the basin (for buffers).
MED_LAEA = "+proj=laea +lat_0=38 +lon_0=15 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs"


# --------------------------------------------------------------------------- #
# Posidonia
# --------------------------------------------------------------------------- #
def fetch_posidonia(wfs: str, layer: str, cql: str, bbox, out_path: Path, page: int = 500) -> gpd.GeoDataFrame:
    """Download Posidonia polygons via WFS (paged), keep those in bbox, cache as parquet."""
    frames = []
    start = 0
    total = None
    while True:
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": layer,
            "outputFormat": "application/json",
            "srsName": "EPSG:3857",
            "CQL_FILTER": cql,
            "sortBy": "objectid",
            "count": page,
            "startIndex": start,
        }
        for attempt in range(4):
            try:
                resp = requests.get(wfs, params=params, timeout=300)
                resp.raise_for_status()
                data = resp.json()
                break
            except (requests.RequestException, ValueError) as exc:
                log.warning("EMODnet WFS page %d attempt %d failed: %s", start, attempt + 1, exc)
                if attempt == 3:
                    raise
        feats = data.get("features", [])
        total = data.get("numberMatched", total)
        if not feats:
            break
        frames.append(gpd.GeoDataFrame.from_features(feats, crs="EPSG:3857"))
        start += len(feats)
        log.info("EMODnet Posidonia: %d / %s features", start, total)
        if total is not None and start >= int(total):
            break
    gdf = pd.concat(frames, ignore_index=True)
    gdf = gpd.GeoDataFrame(gdf, geometry="geometry", crs="EPSG:3857").to_crs("EPSG:4326")
    gdf = gdf[gdf.intersects(box(*bbox))]
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()].copy()
    gdf["geometry"] = shapely.make_valid(gdf.geometry.values)
    # make_valid may yield GeometryCollections; keep polygonal parts only
    gdf["geometry"] = gdf.geometry.apply(_polygonal)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    keep = [c for c in ("objectid", "habsubtype", "map_id", "source", "det_date") if c in gdf.columns]
    gdf = gdf[keep + ["geometry"]].reset_index(drop=True)
    gdf.insert(0, "pid", np.arange(len(gdf), dtype=np.int32))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(out_path)
    log.info("Cached %d Posidonia polygons -> %s", len(gdf), out_path)
    return gdf


def _polygonal(g):
    if g is None:
        return None
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    if g.geom_type == "GeometryCollection":
        polys = [p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        return shapely.union_all(polys)
    return None


def buffered_posidonia(posidonia: gpd.GeoDataFrame, buffer_m: float) -> gpd.GeoDataFrame:
    """Posidonia polygons buffered by ``buffer_m`` in the metric MED_LAEA CRS."""
    metric = posidonia.to_crs(MED_LAEA)
    if buffer_m:
        metric = metric.assign(geometry=metric.buffer(buffer_m, quad_segs=4))
    return metric


# --------------------------------------------------------------------------- #
# H3
# --------------------------------------------------------------------------- #
def cell_polygon(cell: str) -> Polygon:
    return Polygon([(lng, lat) for lat, lng in h3.cell_to_boundary(cell)])


def cells_covering(geoms_4326, res: int) -> set[str]:
    """All H3 cells at ``res`` that overlap any of the geometries."""
    out: set[str] = set()
    for g in geoms_4326:
        if g is None or g.is_empty:
            continue
        parts = g.geoms if g.geom_type == "MultiPolygon" else [g]
        for p in parts:
            shape = h3.geo_to_h3shape(p.__geo_interface__)
            try:
                cells = h3.h3shape_to_cells_experimental(shape, res, contain="overlap")
            except Exception:  # pragma: no cover - degenerate tiny polygon
                cells = []
            if not cells:  # very small polygon: use its representative point
                pt = p.representative_point()
                cells = [h3.latlng_to_cell(pt.y, pt.x, res)]
            out.update(cells)
    return out


def posidonia_cells(posidonia: gpd.GeoDataFrame, buffer_m: float, res: int) -> gpd.GeoDataFrame:
    """H3 cells intersecting buffered Posidonia, with unbuffered Posidonia area (km2)."""
    buf = buffered_posidonia(posidonia, buffer_m).to_crs("EPSG:4326")
    cells = sorted(cells_covering(buf.geometry.values, res))
    hexes = gpd.GeoDataFrame(
        {"h3": cells}, geometry=[cell_polygon(c) for c in cells], crs="EPSG:4326"
    ).to_crs(MED_LAEA)
    # Exact intersection test against buffered geometry (h3 'overlap' is approximate)
    buf_m = buffered_posidonia(posidonia, buffer_m)
    tree = shapely.STRtree(buf_m.geometry.values)
    hi, _ = tree.query(hexes.geometry.values, predicate="intersects")
    hexes = hexes.iloc[np.unique(hi)].reset_index(drop=True)
    hexes["posidonia_km2"] = posidonia_area_per_cell(hexes, posidonia.to_crs(MED_LAEA))
    return hexes


def posidonia_area_per_cell(hexes_m: gpd.GeoDataFrame, posidonia_m: gpd.GeoDataFrame) -> np.ndarray:
    """Area (km2) of the union of Posidonia within each hex (both in a metric CRS)."""
    tree = shapely.STRtree(posidonia_m.geometry.values)
    hi, pi = tree.query(hexes_m.geometry.values, predicate="intersects")
    areas = np.zeros(len(hexes_m))
    if len(hi) == 0:
        return areas
    pieces = shapely.intersection(hexes_m.geometry.values[hi], posidonia_m.geometry.values[pi])
    df = pd.DataFrame({"hi": hi, "geom": pieces})
    counts = df["hi"].value_counts()
    single = df[df["hi"].map(counts) == 1]
    areas[single["hi"].to_numpy()] = shapely.area(single["geom"].to_numpy())
    multi = df[df["hi"].map(counts) > 1]
    for h, grp in multi.groupby("hi"):
        areas[h] = shapely.union_all(grp["geom"].to_numpy()).area
    return areas / 1e6


# --------------------------------------------------------------------------- #
# EEZ
# --------------------------------------------------------------------------- #
_POL_PRIORITY = {"200NM": 0, "Joint regime": 1, "Overlapping claim": 2}


def fetch_eez(wfs: str, layer: str, bbox, out_path: Path) -> gpd.GeoDataFrame:
    min_lon, min_lat, max_lon, max_lat = bbox
    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeNames": layer,
        "outputFormat": "application/json",
        "srsName": "EPSG:4326",
        # WFS 2.0 + urn CRS => lat/lon axis order for the bbox
        "bbox": f"{min_lat},{min_lon},{max_lat},{max_lon},urn:ogc:def:crs:EPSG::4326",
        "propertyName": "mrgid,geoname,pol_type,territory1,iso_ter1,sovereign1,iso_sov1,the_geom",
    }
    resp = requests.get(wfs, params=params, timeout=600)
    resp.raise_for_status()
    data = resp.json()
    gdf = gpd.GeoDataFrame.from_features(data["features"], crs="EPSG:4326")
    gdf = gdf[gdf.intersects(box(*bbox))].copy()
    gdf["iso3"] = gdf["iso_ter1"].fillna(gdf["iso_sov1"]).fillna("UNK")
    # Spanish enclaves (Ceuta, Melilla...) have no iso_ter1 -> sovereign
    gdf["name"] = np.where(gdf["iso_ter1"].isna(), gdf.get("sovereign1", gdf["territory1"]), gdf["territory1"])
    gdf["priority"] = gdf["pol_type"].map(_POL_PRIORITY).fillna(3).astype(int)
    gdf = gdf[["mrgid", "geoname", "pol_type", "iso3", "name", "priority", "geometry"]].reset_index(drop=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(out_path)
    log.info("Cached %d EEZ polygons -> %s", len(gdf), out_path)
    return gdf


def assign_country(
    lon: np.ndarray, lat: np.ndarray, eez: gpd.GeoDataFrame | None, max_distance_m: float = 20000
) -> np.ndarray:
    """ISO3 of the EEZ containing each point ("UNK" if none / no EEZ data).

    Points inside several polygons (joint regimes, overlapping claims) get the
    one with the best ``priority`` (200NM EEZ first). Points just outside every
    polygon (coarse coastline, ports) are snapped to the nearest EEZ within
    ``max_distance_m``.
    """
    n = len(lon)
    out = np.full(n, "UNK", dtype=object)
    if eez is None or len(eez) == 0 or n == 0:
        return out
    pts = gpd.GeoDataFrame(geometry=gpd.points_from_xy(lon, lat), crs="EPSG:4326")
    j = gpd.sjoin(pts, eez[["iso3", "priority", "geometry"]], how="inner", predicate="within")
    if len(j):
        j = j.sort_values("priority").groupby(level=0).first()
        out[j.index.to_numpy()] = j["iso3"].to_numpy()
    miss = np.where(out == "UNK")[0]
    if len(miss) and max_distance_m:
        pm = pts.iloc[miss].to_crs(MED_LAEA)
        em = eez[["iso3", "priority", "geometry"]].to_crs(MED_LAEA)
        nj = gpd.sjoin_nearest(pm, em, how="inner", max_distance=max_distance_m)
        if len(nj):
            nj = nj.sort_values("priority").groupby(level=0).first()
            out[nj.index.to_numpy()] = nj["iso3"].to_numpy()
    return out


def country_names(eez: gpd.GeoDataFrame | None) -> dict[str, str]:
    names = {"UNK": "Unknown / outside EEZ"}
    if eez is not None and len(eez):
        for iso, name in eez.sort_values("priority")[["iso3", "name"]].itertuples(index=False):
            names.setdefault(iso, name)
    return names


def load_geojson_features(path: Path) -> list[dict]:
    return json.loads(path.read_text())["features"]
