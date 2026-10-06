"""Orchestration: reference data, fetching releases, building outputs."""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path

import geopandas as gpd
import h3
import pandas as pd

from . import analysis, export, habitat, ingest, zenodo
from .config import Config

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Cache layout
# --------------------------------------------------------------------------- #
def _paths(cfg: Config) -> dict[str, Path]:
    c = cfg.cache_dir
    return {
        "posidonia": c / "posidonia.parquet",
        "eez": c / "eez.parquet",
        "cells": c / "posidonia_cells.parquet",
        "overpass_cells": c / "overpass_cells.json",
        "manifest": c / "manifest.json",
        "detections": c / "detections",
        "overpass": c / "overpass",
    }


def load_manifest(cfg: Config) -> dict:
    p = _paths(cfg)["manifest"]
    return json.loads(p.read_text()) if p.exists() else {}


def save_manifest(cfg: Config, manifest: dict) -> None:
    p = _paths(cfg)["manifest"]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(dict(sorted(manifest.items())), indent=1))


# --------------------------------------------------------------------------- #
# Reference data
# --------------------------------------------------------------------------- #
def ensure_reference(cfg: Config, refresh: bool = False):
    """Posidonia polygons, EEZs, and the Posidonia H3 cells (cached)."""
    p = _paths(cfg)
    s = cfg.sources
    if refresh or not p["posidonia"].exists():
        posidonia = habitat.fetch_posidonia(s["emodnet_wfs"], s["emodnet_layer"], s["emodnet_filter"], cfg.bbox, p["posidonia"])
        p["cells"].unlink(missing_ok=True)
    else:
        posidonia = gpd.read_parquet(p["posidonia"])

    eez = None
    if refresh or not p["eez"].exists():
        try:
            eez = habitat.fetch_eez(s["eez_wfs"], s["eez_layer"], cfg.bbox, p["eez"])
        except Exception as exc:
            log.warning("EEZ download failed (%s); countries will be 'UNK'", exc)
    else:
        eez = gpd.read_parquet(p["eez"])

    buf_m = cfg.params["posidonia_buffer_m"]
    cells = None
    if p["cells"].exists():
        cells = pd.read_parquet(p["cells"])
        if "buffer_m" not in cells.columns or len(cells) == 0 or cells["buffer_m"].iloc[0] != buf_m:
            cells = None
    if cells is None:
        t0 = time.time()
        hexes = habitat.posidonia_cells(posidonia, buf_m, cfg.h3_resolution)
        latlng = [h3.cell_to_latlng(c) for c in hexes["h3"]]
        hexes["country"] = habitat.assign_country(
            [x[1] for x in latlng], [x[0] for x in latlng], eez, s.get("eez_max_distance_m", 20000)
        )
        cells = pd.DataFrame({"h3": hexes["h3"], "country": hexes["country"],
                              "posidonia_km2": hexes["posidonia_km2"], "buffer_m": buf_m})
        cells.to_parquet(p["cells"])
        log.info("%d Posidonia H3 cells computed in %.0fs", len(cells), time.time() - t0)
    return posidonia, eez, cells


def overpass_cell_set(cells: pd.DataFrame) -> set[str]:
    """Cells to keep from the overpass files: Posidonia cells plus their neighbours
    (so moderate changes of the buffer or polygons do not require re-downloading)."""
    out: set[str] = set()
    for c in cells["h3"]:
        out.update(h3.grid_disk(c, 1))
    return out


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #
def discover(cfg: Config) -> dict[str, zenodo.Release]:
    s = cfg.sources
    fallback = {str(k): int(v) for k, v in (s.get("fallback_records") or {}).items()}
    return zenodo.discover(s["zenodo_api"], str(s["zenodo_concept_recid"]), fallback)


def is_cached(cfg: Config, rel: zenodo.Release, manifest: dict) -> bool:
    p = _paths(cfg)
    entry = manifest.get(rel.period)
    return (
        entry is not None
        and entry.get("record_id") == rel.record_id
        and (p["detections"] / f"{rel.period}.parquet").exists()
        and (p["overpass"] / f"{rel.period}.parquet").exists()
    )


def fetch_release(cfg: Config, rel: zenodo.Release, cells: pd.DataFrame, force: bool = False) -> None:
    p = _paths(cfg)
    manifest = load_manifest(cfg)
    if not force and is_cached(cfg, rel, manifest):
        log.info("%s already cached (record %s)", rel.period, rel.record_id)
        return
    ovp_cells = overpass_cell_set(cells)
    log.info("Fetching %s (record %s): detections %.0f MB, overpasses %.0f MB",
             rel.period, rel.record_id, (rel.detections_size or 0) / 1e6, (rel.overpass_size or 0) / 1e6)
    n_det = ingest.fetch_detections(rel.detections_url, cfg.bbox, p["detections"] / f"{rel.period}.parquet")
    n_ovp = ingest.fetch_overpasses(rel.overpass_url, ovp_cells, p["overpass"] / f"{rel.period}.parquet")
    p["overpass_cells"].write_text(json.dumps(sorted(ovp_cells | set(_cached_overpass_cells(cfg)))))
    manifest = load_manifest(cfg)
    manifest[rel.period] = {
        "record_id": rel.record_id,
        "record_url": rel.record_url,
        "title": rel.title,
        "published": rel.published,
        "detections_file": rel.detections_name,
        "overpass_file": rel.overpass_name,
        "detections_rows": n_det,
        "overpass_rows": n_ovp,
        "overpass_cells": len(ovp_cells),
        "fetched_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    save_manifest(cfg, manifest)


def _cached_overpass_cells(cfg: Config) -> list[str]:
    p = _paths(cfg)["overpass_cells"]
    return json.loads(p.read_text()) if p.exists() else []


def releases_for_months(releases: dict[str, zenodo.Release], months: list[str]) -> list[zenodo.Release]:
    """Map 'YYYY-MM' (or 'YYYY') requests to releases, preferring monthly ones."""
    out: dict[str, zenodo.Release] = {}
    for m in months:
        if len(m) == 4:  # a whole year: monthly releases of that year, else the annual one
            monthly = [r for k, r in releases.items() if len(k) == 6 and k.startswith(m)]
            chosen = monthly or ([releases[m]] if m in releases else [])
        else:
            key = m.replace("-", "")
            chosen = [releases[key]] if key in releases else ([releases[m[:4]]] if m[:4] in releases else [])
        if not chosen:
            log.warning("No complete GFW release found for %s", m)
        for r in chosen:
            out[r.period] = r
    return list(out.values())


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #
def _load_cached(cfg: Config) -> tuple[pd.DataFrame, pd.DataFrame, list[str], dict]:
    """Concatenate cached detections / overpasses. Monthly releases win over annual ones."""
    p = _paths(cfg)
    manifest = load_manifest(cfg)
    periods = sorted(k for k in manifest if (p["detections"] / f"{k}.parquet").exists()
                     and (p["overpass"] / f"{k}.parquet").exists())
    monthly_months = {f"{k[:4]}-{k[4:]}" for k in periods if len(k) == 6}
    dets, ovps = [], []
    for k in periods:
        d = pd.read_parquet(p["detections"] / f"{k}.parquet")
        o = pd.read_parquet(p["overpass"] / f"{k}.parquet")
        if len(k) == 4:  # annual: drop months also covered by a monthly release
            d = d[~d["month"].isin(monthly_months)]
            o = o[~o["month"].isin(monthly_months)]
        else:  # a monthly file only describes its own month
            mon = f"{k[:4]}-{k[4:]}"
            d = d[d["month"] == mon]
            o = o[o["month"] == mon]
        dets.append(d)
        ovps.append(o)
    det = pd.concat(dets, ignore_index=True) if dets else pd.DataFrame(columns=list(ingest.DETECTION_COLUMNS) + ["month"])
    ovp = pd.concat(ovps, ignore_index=True) if ovps else pd.DataFrame(columns=list(ingest.OVERPASS_COLUMNS))
    months = sorted(set(ovp["month"]) | set(det["month"]))
    return det, ovp, months, manifest


def build(cfg: Config) -> dict:
    posidonia, eez, cells = ensure_reference(cfg)
    missing = set(cells["h3"]) - set(_cached_overpass_cells(cfg))
    if missing and _cached_overpass_cells(cfg):
        log.warning("%d Posidonia cells are not in the cached overpass subset; their clear_overpasses "
                    "will be 0. Re-fetch with `fetch --force` after changing the buffer/polygons.", len(missing))
    det, ovp, months, manifest = _load_cached(cfg)
    if not months:
        raise SystemExit("No cached releases. Run `posidonia-watch fetch --months ...` first.")
    log.info("Building from %d detections (%d months: %s .. %s)", len(det), len(months), months[0], months[-1])

    buf = habitat.buffered_posidonia(posidonia, cfg.params["posidonia_buffer_m"])
    anch = analysis.classify(
        det, bbox=cfg.bbox, exclude_boxes=cfg.exclude_boxes, params=cfg.params, filters=cfg.filters,
        posidonia_buffered_metric=buf, res=cfg.h3_resolution,
    )
    anch["country"] = "UNK"
    on = anch["on_posidonia"].to_numpy()
    anch.loc[on, "country"] = habitat.assign_country(
        anch.loc[on, "lon"].to_numpy(), anch.loc[on, "lat"].to_numpy(), eez, cfg.sources.get("eez_max_distance_m", 20000)
    )
    names = habitat.country_names(eez)

    totals = analysis.monthly_totals(anch, months)
    by_country = analysis.country_series(anch, months)
    hexes = analysis.aggregate_hexes(anch, cells[["h3", "country", "posidonia_km2"]], ovp, months)
    monthly_rows, monthly_clear = analysis.hex_monthly(anch, hexes["h3"].tolist(), ovp, months)
    hot = analysis.hotspots(hexes, cfg.output.get("hotspots_n", 50))

    out = cfg.out_dir
    nd = cfg.output.get("coord_decimals", 5)
    # Concept DOI: resolves to the latest version and lists all monthly/annual releases
    gfw_url = f"https://doi.org/10.5281/zenodo.{cfg.sources['zenodo_concept_recid']}"
    export.write_json(out / "meta.json", export.meta_obj(months, cfg, gfw_url))
    export.write_json(out / "timeseries.json", export.timeseries_obj(totals, by_country, names, months))
    export.write_json(out / "hexes.json", export.hexes_obj(hexes))
    export.write_json(out / "hexes_monthly.json", export.hexes_monthly_obj(monthly_rows, monthly_clear, months))
    export.write_json(out / "points.json", export.points_obj(anch, months, cfg.output.get("points_cap", 200_000), nd))
    export.write_json(out / "hotspots.json", export.hotspots_obj(hot, nd))
    tol = export.write_posidonia_geojson(posidonia, out / "posidonia.geojson", cfg.output.get("posidonia_simplify_m", 30))
    log.info("posidonia.geojson written (simplify %.0f m)", tol)
    export.validate_outputs(out)

    summary = {
        "months": len(months),
        "anchored_total": int(totals["anchored_total"].sum()),
        "anchored_on_posidonia": int(totals["anchored_on_posidonia"].sum()),
        "large_on_posidonia": int(totals["large_on_posidonia"].sum()),
        "hexes": len(hexes),
        "hexes_with_detections": int((hexes["on_posidonia"] > 0).sum()),
        "files": {f: (out / f).stat().st_size for f in export.FILES},
    }
    log.info("Build summary: %s", summary)
    return summary

