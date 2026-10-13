import math

import numpy as np
import pandas as pd
import pytest

from posidonia_watch import export, ingest, pipeline
from posidonia_watch.config import Config, load_config
from posidonia_watch.zenodo import Release


def _release(period: str) -> Release:
    return Release(record_id=int(period), period=period, title=period, published="2026-01-01",
                   detections_url="d", detections_name="d.csv", detections_size=1,
                   overpass_url="o", overpass_name="o.csv", overpass_size=1)


RELEASES = {p: _release(p) for p in ("2024", "2025", "202501", "202502")}


def test_release_months():
    assert RELEASES["2024"].months[0] == "2024-01"
    assert len(RELEASES["2024"].months) == 12
    assert RELEASES["202502"].months == ["2025-02"]


def test_releases_for_months_prefers_monthly_releases():
    periods = [r.period for r in pipeline.releases_for_months(RELEASES, ["2025-02", "2025"])]
    assert sorted(periods) == ["202501", "202502"]


def test_releases_for_months_falls_back_to_annual_release():
    assert [r.period for r in pipeline.releases_for_months(RELEASES, ["2024-06"])] == ["2024"]
    assert [r.period for r in pipeline.releases_for_months(RELEASES, ["2024"])] == ["2024"]


def test_releases_for_months_skips_months_without_a_release():
    assert pipeline.releases_for_months(RELEASES, ["2023-05"]) == []


def test_is_cached_refetches_releases_cached_under_an_older_schema(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    rel = _release("202501")
    for d in ("detections", "overpass"):
        (cfg.cache_dir / d).mkdir(parents=True)
        (cfg.cache_dir / d / "202501.parquet").touch()
    current = {"202501": {"record_id": rel.record_id, "detections_schema": ingest.DETECTION_SCHEMA_VERSION}}
    legacy = {"202501": {"record_id": rel.record_id}}  # written before the schema was versioned
    assert pipeline.is_cached(cfg, rel, current)
    assert not pipeline.is_cached(cfg, rel, legacy)


def test_releases_to_fetch_skips_an_annual_release_superseded_by_monthly_ones(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    year = {p: _release(p) for p in ("2024", "2025", *(f"2025{m:02d}" for m in range(1, 13)))}
    todo = [r.period for r in pipeline.releases_to_fetch(cfg, year, {})]
    assert todo == [*(f"2025{m:02d}" for m in range(12, 0, -1)), "2024"]  # newest first, no annual 2025
    del year["202507"]  # the annual file is the only source for July
    assert [r.period for r in pipeline.releases_to_fetch(cfg, year, {})][-2:] == ["2025", "2024"]
    assert "2024" not in [r.period for r in pipeline.releases_to_fetch(cfg, year, {}, since="2025")]


def _cache(cfg: Config, schemas: dict[str, int | None]) -> None:
    """Cache one detection and one overpass row per period (first month of an annual one)."""
    manifest = {}
    for period, schema in schemas.items():
        month = f"{period[:4]}-{period[4:] or '01'}"
        for d, cols in (("detections", ingest.DETECTION_COLUMNS), ("overpass", ingest.OVERPASS_COLUMNS)):
            (cfg.cache_dir / d).mkdir(parents=True, exist_ok=True)
            pd.DataFrame({**{c: [None] for c in cols}, "month": [month]}).to_parquet(
                cfg.cache_dir / d / f"{period}.parquet")
        manifest[period] = {"record_id": 1} if schema is None else {"record_id": 1, "detections_schema": schema}
    pipeline.save_manifest(cfg, manifest)


CURRENT = ingest.DETECTION_SCHEMA_VERSION
MONTHS_2025 = {f"2025{m:02d}": CURRENT for m in range(1, 13)}


def test_build_input_refuses_releases_cached_under_an_older_schema(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    _cache(cfg, {"202501": None})  # written before the schema was versioned
    with pytest.raises(SystemExit, match="202501"):
        pipeline._load_cached(cfg)


def test_build_input_refuses_a_stale_annual_release_that_still_supplies_a_month(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    _cache(cfg, {"2025": None, **{k: v for k, v in MONTHS_2025.items() if k != "202501"}})
    with pytest.raises(SystemExit, match="2025"):
        pipeline._load_cached(cfg)


def test_build_input_skips_a_stale_annual_release_superseded_by_monthly_ones(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    _cache(cfg, {"2025": None, **MONTHS_2025})
    assert pipeline.stale_releases(cfg) == []
    det, ovp, months, _ = pipeline._load_cached(cfg)
    assert months == [f"2025-{m:02d}" for m in range(1, 13)]
    assert len(det) == 12 and len(ovp) == 12


def test_build_input_leaves_out_stale_releases_before_since(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    _cache(cfg, {"2023": CURRENT, "2024": None, "202412": None, "202501": CURRENT})
    with pytest.raises(SystemExit, match="2024, 202412"):
        pipeline._load_cached(cfg)
    assert pipeline.stale_releases(cfg) == ["2024", "202412"]
    assert pipeline.stale_releases(cfg, since="2025") == []
    _, _, months, _ = pipeline._load_cached(cfg, since="2025")
    assert months == ["2023-01", "2025-01"]  # the current 2023 cache is still used
    with pytest.raises(SystemExit, match="202501"):
        _cache(cfg, {"202501": None})
        pipeline._load_cached(cfg, since="2025")


def test_load_config_defaults_the_ais_confidence_for_older_configs(tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text("params: {speed_kn_max: 1.0}\n")
    assert load_config(path).params == {"speed_kn_max": 1.0, "ais_confidence_min": 0.9}
    path.write_text("params: {speed_kn_max: 1.0, ais_confidence_min: 0.8}\n")
    assert load_config(path).params["ais_confidence_min"] == 0.8
    assert load_config().params["ais_confidence_min"] == 0.9  # the shipped config


def test_num_makes_values_json_safe():
    assert export._num(np.int64(3)) == 3
    assert type(export._num(np.int64(3))) is int
    assert export._num(float("nan")) is None
    assert export._num(None) is None
    assert export._num(2.345678, 2) == 2.35
    assert export._num(2.6, 0) == 3
    assert not math.isnan(export._num(np.float32(1.5)))


def test_floor_rounds_down_but_not_below_the_float32_value():
    assert export._floor(0.896, 2) == 0.89
    assert export._floor(0.899999, 2) == 0.89
    assert export._floor(np.float32(0.9), 2) == 0.9  # widens to 0.89999998
    assert export._floor(np.float32(0.57), 2) == 0.57
    assert export._floor(1.0, 2) == 1.0
    assert export._floor(float("nan"), 2) is None


def test_points_obj_publishes_ais_values_only_for_matches_and_never_the_mmsi():
    anch = pd.DataFrame({
        "on_posidonia": [True, True], "month": ["2025-07", "2025-07"],
        "detect_timestamp": ["2025-07-02", "2025-07-01"], "lon": [3.0, 3.1], "lat": [42.0, 42.1],
        "length_m_inferred": [30.0, 12.0], "country": ["FRA", "FRA"], "mmsi": ["227000000", None],
        "ais_matched": [True, False], "matching_confidence": [0.971, 0.4],
        "ais_confident": [True, False], "ais_stationary": [True, False],
        "ais_speed_kn": [0.24, np.nan], "ais_length_m": [33.0, 15.0],
    })
    pts = export.points_obj(anch, ["2025-07"], cap=10)
    assert "mmsi" not in pts
    assert pts["ais_class"] == [3, 0]
    assert pts["ais_conf"] == [0.97, None]
    assert pts["ais_speed_kn"] == [0.2, None]
    assert pts["ais_length_m"] == [33.0, None]
    assert pts["ais_flag"] == ["FR", None]


def test_points_obj_classifies_on_the_unrounded_values():
    anch = pd.DataFrame({
        "on_posidonia": [True, True], "month": ["2025-07", "2025-07"],
        "detect_timestamp": ["2025-07-02", "2025-07-01"], "lon": [3.0, 3.1], "lat": [42.0, 42.1],
        "length_m_inferred": [30.0, 12.0], "country": ["FRA", "FRA"], "mmsi": ["227000000", "227000001"],
        "ais_matched": [True, True], "matching_confidence": [0.95, 0.896],
        "ais_confident": [True, False], "ais_stationary": [True, False],
        "ais_speed_kn": [0.96, 0.1], "ais_length_m": [33.0, 15.0],
    })
    pts = export.points_obj(anch, ["2025-07"], cap=10)
    assert pts["ais_speed_kn"] == [0.9, None]  # rounded down: an AIS-stationary boat stays below the threshold
    assert pts["ais_conf"] == [0.95, 0.89]  # likewise
    assert pts["ais_class"] == [3, 1]


def test_points_obj_keeps_a_match_without_confidence_as_uncertain():
    anch = pd.DataFrame({
        "on_posidonia": [True], "month": ["2025-07"], "detect_timestamp": ["2025-07-02"],
        "lon": [3.0], "lat": [42.0], "length_m_inferred": [30.0], "country": ["FRA"], "mmsi": ["227000009"],
        "ais_matched": [True], "matching_confidence": [np.nan],
        "ais_confident": [False], "ais_stationary": [False],
        "ais_speed_kn": [0.1], "ais_length_m": [33.0],
    })
    pts = export.points_obj(anch, ["2025-07"], cap=10)
    assert pts["ais_class"] == [1]
    assert pts["ais_conf"] == [None]
    export._check_points_ais(pts)


def test_points_obj_publishes_only_the_confidence_of_an_uncertain_match():
    anch = pd.DataFrame({
        "on_posidonia": [True], "month": ["2025-07"], "detect_timestamp": ["2025-07-02"],
        "lon": [3.0], "lat": [42.0], "length_m_inferred": [30.0], "country": ["FRA"], "mmsi": ["227000009"],
        "ais_matched": [True], "matching_confidence": [0.5],
        "ais_confident": [False], "ais_stationary": [False],
        "ais_speed_kn": [0.1], "ais_length_m": [33.0],
    })
    pts = export.points_obj(anch, ["2025-07"], cap=10)
    assert (pts["ais_class"], pts["ais_conf"]) == ([1], [0.5])
    assert (pts["ais_speed_kn"], pts["ais_length_m"], pts["ais_flag"]) == ([None], [None], [None])
    export._check_points_ais(pts)


def test_points_ais_check_rejects_values_the_class_does_not_publish():
    base = {"ais_conf": [0.5], "ais_speed_kn": [None], "ais_length_m": [None], "ais_flag": [None]}
    export._check_points_ais({"ais_class": [1], **base})
    with pytest.raises(export.ContractError):  # a confidence without a match
        export._check_points_ais({"ais_class": [0], **base})
    with pytest.raises(export.ContractError):  # a confident match without its confidence
        export._check_points_ais({"ais_class": [2], **base, "ais_conf": [None]})
    for key, value in (("ais_speed_kn", 0.1), ("ais_length_m", 33.0), ("ais_flag", "FR")):
        with pytest.raises(export.ContractError):  # a vessel value on an uncertain match
            export._check_points_ais({"ais_class": [1], **base, key: [value]})


def test_ais_nesting_check_covers_the_large_counts():
    row = {"on_posidonia": [5], "large_on_posidonia": [2], "ais_on_posidonia": [3], "ais_large_on_posidonia": [1],
           "ais_stationary_on_posidonia": [2], "ais_stationary_large_on_posidonia": [1]}
    export._check_ais_nesting(row)
    for key, bad in (("ais_large_on_posidonia", 3),              # more large AIS matches than large boats
                     ("ais_stationary_large_on_posidonia", 2),   # more than the large AIS matches
                     ("large_on_posidonia", 6)):                 # more large boats than boats
        with pytest.raises(export.ContractError):
            export._check_ais_nesting({**row, key: [bad]})
