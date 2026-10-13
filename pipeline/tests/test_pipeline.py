import math

import numpy as np
import pandas as pd
import pytest

from posidonia_watch import export, ingest, pipeline
from posidonia_watch.config import Config
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


def test_build_input_refuses_releases_cached_under_an_older_schema(tmp_path):
    cfg = Config(raw={}, base_dir=tmp_path)
    for d in ("detections", "overpass"):
        (cfg.cache_dir / d).mkdir(parents=True)
        (cfg.cache_dir / d / "202501.parquet").touch()
    pipeline.save_manifest(cfg, {"202501": {"record_id": 1}})
    with pytest.raises(SystemExit, match="202501"):
        pipeline._load_cached(cfg)


def test_num_makes_values_json_safe():
    assert export._num(np.int64(3)) == 3
    assert type(export._num(np.int64(3))) is int
    assert export._num(float("nan")) is None
    assert export._num(None) is None
    assert export._num(2.345678, 2) == 2.35
    assert export._num(2.6, 0) == 3
    assert not math.isnan(export._num(np.float32(1.5)))


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
    assert pts["ais_speed_kn"] == [1.0, 0.1] and pts["ais_conf"] == [0.95, 0.9]  # rounded past the thresholds
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
    assert pts["ais_flag"] == ["FR"]
    export._check_points_ais(pts)


def test_points_ais_check_rejects_values_on_unmatched_points_and_confident_matches_without_confidence():
    base = {"ais_speed_kn": [None], "ais_length_m": [None], "ais_flag": [None]}
    with pytest.raises(export.ContractError):
        export._check_points_ais({"ais_class": [0], "ais_conf": [0.5], **base})
    with pytest.raises(export.ContractError):
        export._check_points_ais({"ais_class": [2], "ais_conf": [None], **base})


def test_ais_nesting_check_covers_the_large_counts():
    row = {"on_posidonia": [5], "large_on_posidonia": [2], "ais_on_posidonia": [3], "ais_large_on_posidonia": [1],
           "ais_stationary_on_posidonia": [2], "ais_stationary_large_on_posidonia": [1]}
    export._check_ais_nesting(row)
    for key, bad in (("ais_large_on_posidonia", 3),              # more large AIS matches than large boats
                     ("ais_stationary_large_on_posidonia", 2),   # more than the large AIS matches
                     ("large_on_posidonia", 6)):                 # more large boats than boats
        with pytest.raises(export.ContractError):
            export._check_ais_nesting({**row, key: [bad]})
