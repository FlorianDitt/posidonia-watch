"""Write the web data files defined in docs/data-contract.md, and validate them."""

from __future__ import annotations

import json
import logging
import math
from datetime import UTC, datetime
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import shapely

from .analysis import SEASONS
from .habitat import MED_LAEA

log = logging.getLogger(__name__)

FILES = ("meta.json", "timeseries.json", "hexes.json", "hexes_monthly.json", "points.json", "posidonia.geojson",
         "hotspots.json")


def _num(x, nd: int | None = None):
    """JSON-safe number: NaN -> None, numpy -> python, optional rounding."""
    if x is None:
        return None
    if isinstance(x, (np.integer,)):
        return int(x)
    x = float(x)
    if math.isnan(x):
        return None
    if nd is not None:
        x = round(x, nd)
    return int(x) if nd == 0 else x


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False), encoding="utf-8")
    tmp.replace(path)


def meta_obj(months: list[str], cfg, gfw_url: str) -> dict:
    return {
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "methodology_version": str(cfg.raw.get("methodology_version", "1")),
        "months": months,
        "h3_resolution": cfg.h3_resolution,
        "params": {
            "speed_kn_max": cfg.params["speed_kn_max"],
            "posidonia_buffer_m": cfg.params["posidonia_buffer_m"],
            "large_length_m": cfg.params["large_length_m"],
        },
        "sources": [
            {"name": "GFW Sentinel-2 vessel detections", "license": "CC0-1.0", "url": gfw_url},
            {"name": "EMODnet Seabed Habitats – Seagrass cover (EOV), version 2025", "license": "CC-BY-4.0",
             "url": "https://emodnet.ec.europa.eu/geonetwork/srv/eng/catalog.search#/metadata/"
                    "39746d9c-4220-425c-bc26-7cb3056c36a5"},
            {"name": "Flanders Marine Institute – Maritime Boundaries Geodatabase (EEZ), version 12", "license": "CC-BY-4.0",
             "url": "https://doi.org/10.14284/632"},
        ],
        "bbox": list(cfg.bbox),
    }


def timeseries_obj(totals: pd.DataFrame, by_country: dict, names: dict[str, str], months: list[str]) -> dict:
    t = totals.reindex(months, fill_value=0)
    return {
        "months": months,
        "anchored_total": [int(v) for v in t["anchored_total"]],
        "anchored_on_posidonia": [int(v) for v in t["anchored_on_posidonia"]],
        "large_on_posidonia": [int(v) for v in t["large_on_posidonia"]],
        "by_country": {
            iso: {"name": names.get(iso, iso), **series}
            for iso, series in sorted(by_country.items(), key=lambda kv: -sum(kv[1]["anchored_on_posidonia"]))
        },
    }


def hexes_obj(hexes: pd.DataFrame) -> dict:
    return {
        "h3": hexes["h3"].tolist(),
        "country": hexes["country"].tolist(),
        "on_posidonia": [int(v) for v in hexes["on_posidonia"]],
        "large_on_posidonia": [int(v) for v in hexes["large_on_posidonia"]],
        "clear_overpasses": [int(v) for v in hexes["clear_overpasses"]],
        "density": [_num(v, 4) for v in hexes["density"]],
        "posidonia_km2": [_num(v, 3) for v in hexes["posidonia_km2"]],
        "by_season": {s: [int(v) for v in hexes[s]] for s in SEASONS},
        "by_season_large": {s: [int(v) for v in hexes[f"large_{s}"]] for s in SEASONS},
        "by_season_clear_overpasses": {s: [int(v) for v in hexes[f"clear_{s}"]] for s in SEASONS},
    }


def hexes_monthly_obj(rows: pd.DataFrame, clear: np.ndarray, months: list[str]) -> dict:
    return {
        "months": months,
        "cell": [int(v) for v in rows["i"]],
        "month": [int(v) for v in rows["m"]],
        "on_posidonia": [int(v) for v in rows["n"]],
        "large_on_posidonia": [int(v) for v in rows["large"]],
        "clear_overpasses": [int(v) for v in clear.reshape(-1)],
    }


def points_obj(anch: pd.DataFrame, months: list[str], cap: int, nd: int = 5) -> dict:
    on = anch[anch["on_posidonia"] & anch["month"].isin(months)]
    on = on.sort_values("detect_timestamp", ascending=False).head(cap)
    midx = {m: i for i, m in enumerate(months)}
    return {
        "lon": [round(float(v), nd) for v in on["lon"]],
        "lat": [round(float(v), nd) for v in on["lat"]],
        "month": [midx[m] for m in on["month"]],
        "length_m": [_num(v, 1) for v in on["length_m_inferred"]],
        "country": on["country"].tolist(),
    }


def hotspots_obj(hot: pd.DataFrame, nd: int = 5) -> list[dict]:
    out = []
    for r in hot.itertuples(index=False):
        lat, lon = h3.cell_to_latlng(r.h3)
        out.append({
            "h3": r.h3,
            "lon": round(lon, nd),
            "lat": round(lat, nd),
            "country": r.country,
            "place": getattr(r, "place", None) if isinstance(getattr(r, "place", None), str) else None,
            "on_posidonia": int(r.on_posidonia),
            "large_on_posidonia": int(r.large_on_posidonia),
            "density": _num(r.density, 4),
            "peak_month": r.peak_month if isinstance(r.peak_month, str) else None,
        })
    return out


def write_posidonia_geojson(posidonia: gpd.GeoDataFrame, path: Path, tolerance_m: float,
                            target_bytes: int = 10_000_000, nd: int = 5) -> float:
    """Simplify (in metres) until the file is below ``target_bytes``. Returns tolerance used."""
    metric = posidonia.to_crs(MED_LAEA)
    tol = tolerance_m
    for _ in range(8):
        simp = metric.geometry.simplify(tol, preserve_topology=True)
        g = gpd.GeoDataFrame({"id": posidonia["pid"].astype(int).to_numpy()}, geometry=simp.values, crs=MED_LAEA)
        g = g[~g.geometry.is_empty].to_crs("EPSG:4326")
        geoms = shapely.set_precision(g.geometry.values, 10 ** -nd)
        geoms = shapely.make_valid(geoms)
        feats = []
        for pid, geom in zip(g["id"], geoms):
            geom = _polygonal_only(geom)
            if geom is None:
                continue
            feats.append({"type": "Feature", "properties": {"id": int(pid)}, "geometry": shapely.geometry.mapping(geom)})
        fc = {"type": "FeatureCollection", "features": feats}
        text = json.dumps(fc, separators=(",", ":"))
        if len(text.encode()) < target_bytes:
            break
        log.info("posidonia.geojson %.1f MB at %.0f m tolerance; increasing", len(text) / 1e6, tol)
        tol *= 1.6
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return tol


def _polygonal_only(geom):
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    polys = []
    for p in getattr(geom, "geoms", []):
        if p.geom_type == "Polygon":
            polys.append(p)
        elif p.geom_type == "MultiPolygon":
            polys.extend(p.geoms)
    if not polys:
        return None
    return polys[0] if len(polys) == 1 else shapely.MultiPolygon(polys)


# --------------------------------------------------------------------------- #
# Contract validation
# --------------------------------------------------------------------------- #
class ContractError(ValueError):
    pass


def _check(cond, msg):
    if not cond:
        raise ContractError(msg)


def validate_outputs(out_dir: Path) -> None:
    """Raise ContractError if any output file deviates from docs/data-contract.md."""
    for f in FILES:
        _check((out_dir / f).exists(), f"missing {f}")
    meta = json.loads((out_dir / "meta.json").read_text())
    for k in ("generated_at", "methodology_version", "months", "h3_resolution", "params", "sources", "bbox"):
        _check(k in meta, f"meta.json missing {k}")
    months = meta["months"]
    _check(months == sorted(months) and all(len(m) == 7 and m[4] == "-" for m in months), "meta.months must be sorted YYYY-MM")
    _check(set(meta["params"]) >= {"speed_kn_max", "posidonia_buffer_m", "large_length_m"}, "meta.params keys")
    _check(len(meta["bbox"]) == 4, "meta.bbox")
    _check(all({"name", "license", "url"} <= set(s) for s in meta["sources"]), "meta.sources entries")
    n = len(months)

    ts = json.loads((out_dir / "timeseries.json").read_text())
    _check(ts["months"] == months, "timeseries.months != meta.months")
    for k in ("anchored_total", "anchored_on_posidonia", "large_on_posidonia"):
        _check(len(ts[k]) == n and all(isinstance(v, int) for v in ts[k]), f"timeseries.{k}")
    for iso, c in ts["by_country"].items():
        _check(len(iso) == 3 and "name" in c, f"by_country.{iso}")
        _check(len(c["anchored_on_posidonia"]) == n and len(c["large_on_posidonia"]) == n, f"by_country.{iso} lengths")

    hx = json.loads((out_dir / "hexes.json").read_text())
    keys = ("h3", "country", "on_posidonia", "large_on_posidonia", "clear_overpasses", "density", "posidonia_km2")
    m = len(hx["h3"])
    for k in keys:
        _check(len(hx[k]) == m, f"hexes.{k} length")
    for key in ("by_season", "by_season_large", "by_season_clear_overpasses"):
        _check(set(hx[key]) == set(SEASONS), f"hexes.{key} keys")
        for s in SEASONS:
            _check(len(hx[key][s]) == m, f"hexes.{key}.{s} length")
    _check(all(h3.is_valid_cell(c) and h3.get_resolution(c) == meta["h3_resolution"] for c in hx["h3"][:1000]), "hexes.h3 cells")
    for d, c in zip(hx["density"], hx["clear_overpasses"]):
        _check((d is None) == (c == 0), "hexes.density must be null iff clear_overpasses == 0")

    hm = json.loads((out_dir / "hexes_monthly.json").read_text())
    _check(hm["months"] == months, "hexes_monthly.months != meta.months")
    r = len(hm["cell"])
    for k in ("month", "on_posidonia", "large_on_posidonia"):
        _check(len(hm[k]) == r, f"hexes_monthly.{k} length")
    _check(all(0 <= i < m for i in hm["cell"]), "hexes_monthly.cell index out of range")
    _check(all(0 <= k < n for k in hm["month"]), "hexes_monthly.month index out of range")
    _check(len(hm["clear_overpasses"]) == m * n, "hexes_monthly.clear_overpasses must be cells x months")
    _check(sum(hm["on_posidonia"]) == sum(hx["on_posidonia"]), "hexes_monthly.on_posidonia must sum to hexes total")

    pts = json.loads((out_dir / "points.json").read_text())
    p = len(pts["lon"])
    _check(p <= 200_000, "points cap")
    for k in ("lon", "lat", "month", "length_m", "country"):
        _check(len(pts[k]) == p, f"points.{k} length")
    _check(all(0 <= i < n for i in pts["month"]), "points.month index out of range")

    fc = json.loads((out_dir / "posidonia.geojson").read_text())
    _check(fc["type"] == "FeatureCollection", "posidonia.geojson type")
    for f in fc["features"]:
        _check(f["geometry"]["type"] in ("Polygon", "MultiPolygon"), "posidonia geometry type")
        _check(set(f["properties"]) == {"id"} and isinstance(f["properties"]["id"], int), "posidonia properties")

    hot = json.loads((out_dir / "hotspots.json").read_text())
    _check(isinstance(hot, list) and len(hot) <= 50, "hotspots list")
    hk = {"h3", "lon", "lat", "country", "place", "on_posidonia", "large_on_posidonia", "density", "peak_month"}
    for h in hot:
        _check(set(h) == hk, f"hotspot keys {set(h) ^ hk}")
    ons = [h["on_posidonia"] for h in hot]
    _check(ons == sorted(ons, reverse=True), "hotspots order")
