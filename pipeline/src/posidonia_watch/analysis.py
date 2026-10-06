"""Pure analysis logic (no network): filters, spatial join, H3 aggregation."""

from __future__ import annotations

from collections.abc import Sequence

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import shapely

from .habitat import MED_LAEA

SEASONS = ("DJF", "MAM", "JJA", "SON")
_SEASON_OF_MONTH = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
                    6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}


def season_of(month: str) -> str:
    """'2025-07' -> 'JJA'."""
    return _SEASON_OF_MONTH[int(month[5:7])]


# --------------------------------------------------------------------------- #
# Detection-level classification
# --------------------------------------------------------------------------- #
def in_med_mask(lon, lat, bbox: Sequence[float], exclude_boxes: Sequence[Sequence[float]] = ()) -> np.ndarray:
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    m = (lon >= bbox[0]) & (lon <= bbox[2]) & (lat >= bbox[1]) & (lat <= bbox[3])
    for b in exclude_boxes:
        m &= ~((lon >= b[0]) & (lon <= b[2]) & (lat >= b[1]) & (lat <= b[3]))
    return m


def quality_mask(df: pd.DataFrame, filters: dict) -> np.ndarray:
    """Detections that are plausibly real vessels in usable imagery.

    Missing scores are treated permissively (NaN cloud score -> kept).
    """
    m = np.ones(len(df), dtype=bool)
    if "presence_score_min" in filters:
        m &= df["presence_score"].to_numpy(dtype=float) >= filters["presence_score_min"]
    if "nonvessel_score_max" in filters:
        nv = df["nonvessel_score"].to_numpy(dtype=float)
        m &= ~(nv > filters["nonvessel_score_max"])
    if "cloud_score_max" in filters:
        cs = df["cloud_score"].to_numpy(dtype=float)
        m &= ~(cs > filters["cloud_score_max"])
    if filters.get("length_m_min"):
        m &= df["length_m_inferred"].to_numpy(dtype=float) >= filters["length_m_min"]
    if filters.get("exclude_infrastructure", True) and "likely_infrastructure" in df:
        m &= ~df["likely_infrastructure"].fillna(False).to_numpy(dtype=bool)
    if filters.get("exclude_ice", True) and "potential_ice" in df:
        m &= ~df["potential_ice"].fillna(False).to_numpy(dtype=bool)
    return m


def anchored_mask(df: pd.DataFrame, params: dict, filters: dict) -> np.ndarray:
    """Stationary (speed < speed_kn_max) AND passes quality filters."""
    speed = df["speed_kn_inferred"].to_numpy(dtype=float)
    return (speed < params["speed_kn_max"]) & quality_mask(df, filters)


def dedupe(df: pd.DataFrame) -> pd.DataFrame:
    """Drop the same detection reported in two processing versions of a scene."""
    key = (
        df["lat"].round(4).astype(str) + "," + df["lon"].round(4).astype(str) + ","
        + df["detect_timestamp"].astype(str).str.slice(0, 16)
    )
    return df.loc[~key.duplicated()]


def points_within(lon, lat, polygons_metric: gpd.GeoDataFrame) -> np.ndarray:
    """Boolean: is each WGS84 point inside any polygon (polygons in MED_LAEA)."""
    n = len(lon)
    if n == 0 or len(polygons_metric) == 0:
        return np.zeros(n, dtype=bool)
    pts = gpd.GeoSeries(gpd.points_from_xy(lon, lat), crs="EPSG:4326").to_crs(MED_LAEA).values
    tree = shapely.STRtree(polygons_metric.geometry.values)
    idx, _ = tree.query(pts, predicate="within")
    out = np.zeros(n, dtype=bool)
    out[idx] = True
    return out


def to_cells(lon, lat, res: int) -> np.ndarray:
    return np.array([h3.latlng_to_cell(y, x, res) for x, y in zip(lon, lat)], dtype=object)


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #
def classify(
    det: pd.DataFrame,
    *,
    bbox,
    exclude_boxes,
    params: dict,
    filters: dict,
    posidonia_buffered_metric: gpd.GeoDataFrame,
    res: int,
) -> pd.DataFrame:
    """Return anchored detections in the Med with flags on_posidonia / large and h3 cell."""
    det = dedupe(det)
    med = in_med_mask(det["lon"], det["lat"], bbox, exclude_boxes)
    det = det.loc[med]
    anch = det.loc[anchored_mask(det, params, filters)].copy()
    anch["on_posidonia"] = points_within(anch["lon"].to_numpy(), anch["lat"].to_numpy(), posidonia_buffered_metric)
    anch["large"] = anch["length_m_inferred"].to_numpy(dtype=float) >= params["large_length_m"]
    anch["h3"] = None
    on = anch["on_posidonia"].to_numpy()
    if on.any():
        anch.loc[on, "h3"] = to_cells(anch.loc[on, "lon"].to_numpy(), anch.loc[on, "lat"].to_numpy(), res)
    return anch.reset_index(drop=True)


def monthly_totals(anch: pd.DataFrame, months: list[str]) -> pd.DataFrame:
    """Per month: anchored_total, anchored_on_posidonia, large_on_posidonia."""
    g = anch.groupby("month")
    out = pd.DataFrame(index=pd.Index(months, name="month"))
    out["anchored_total"] = g.size()
    out["anchored_on_posidonia"] = g["on_posidonia"].sum()
    out["large_on_posidonia"] = g.apply(lambda x: int((x["on_posidonia"] & x["large"]).sum()), include_groups=False) if len(anch) else 0
    return out.fillna(0).astype(int)


def country_series(anch: pd.DataFrame, months: list[str]) -> dict[str, dict[str, list[int]]]:
    on = anch[anch["on_posidonia"]]
    res: dict[str, dict[str, list[int]]] = {}
    for iso, grp in on.groupby("country"):
        a = grp.groupby("month").size().reindex(months, fill_value=0)
        large = grp[grp["large"]].groupby("month").size().reindex(months, fill_value=0)
        res[iso] = {"anchored_on_posidonia": a.astype(int).tolist(), "large_on_posidonia": large.astype(int).tolist()}
    return res


def density(on_posidonia, clear_overpasses) -> np.ndarray:
    """on_posidonia / clear_overpasses; NaN where clear_overpasses == 0."""
    on = np.asarray(on_posidonia, dtype=float)
    cl = np.asarray(clear_overpasses, dtype=float)
    out = np.full(on.shape, np.nan)
    ok = cl > 0
    out[ok] = on[ok] / cl[ok]
    return out


def aggregate_hexes(
    anch: pd.DataFrame,
    cells: pd.DataFrame,
    overpass: pd.DataFrame,
    months: list[str],
) -> pd.DataFrame:
    """One row per Posidonia cell, aggregated over ``months``.

    ``cells``: columns h3, country, posidonia_km2 (all Posidonia cells).
    ``overpass``: columns h3_id, month, overpasses_cloud_under_20.
    """
    on = anch[anch["on_posidonia"]]
    on = on[on["month"].isin(months)]
    cells = cells.set_index("h3")
    extra = sorted(set(on["h3"]) - set(cells.index))
    if extra:  # should not happen (cells are built from the same buffered polygons)
        cells = pd.concat([cells, pd.DataFrame({"country": "UNK", "posidonia_km2": 0.0}, index=pd.Index(extra, name="h3"))])
    idx = cells.index
    hexes = pd.DataFrame(index=idx)
    hexes["country"] = cells["country"]
    hexes["on_posidonia"] = on.groupby("h3").size().reindex(idx, fill_value=0)
    hexes["large_on_posidonia"] = on[on["large"]].groupby("h3").size().reindex(idx, fill_value=0)
    ovp = overpass[overpass["month"].isin(months)]
    hexes["clear_overpasses"] = (
        ovp.groupby("h3_id")["overpasses_cloud_under_20"].sum().reindex(idx, fill_value=0).astype(int)
    )
    hexes["density"] = density(hexes["on_posidonia"], hexes["clear_overpasses"])
    hexes["posidonia_km2"] = cells["posidonia_km2"]
    seasons = on.assign(season=on["month"].map(season_of)).groupby(["h3", "season"]).size().unstack(fill_value=0)
    for s in SEASONS:
        hexes[s] = seasons[s].reindex(idx, fill_value=0) if s in seasons else 0
    by_month = on.groupby(["h3", "month"]).size()
    peak = by_month.reset_index(name="n").sort_values(["n", "month"], ascending=[False, False]).drop_duplicates("h3")
    hexes["peak_month"] = peak.set_index("h3")["month"].reindex(idx)
    hexes = hexes.reset_index().rename(columns={"index": "h3"})
    return hexes.sort_values("h3").reset_index(drop=True)


def hotspots(hexes: pd.DataFrame, n: int = 50) -> pd.DataFrame:
    h = hexes[hexes["on_posidonia"] > 0].copy()
    h["_d"] = h["density"].fillna(-1)
    h = h.sort_values(["on_posidonia", "_d", "h3"], ascending=[False, False, True]).head(n)
    return h.drop(columns="_d")
