import math

import numpy as np

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


def test_num_makes_values_json_safe():
    assert export._num(np.int64(3)) == 3
    assert type(export._num(np.int64(3))) is int
    assert export._num(float("nan")) is None
    assert export._num(None) is None
    assert export._num(2.345678, 2) == 2.35
    assert export._num(2.6, 0) == 3
    assert not math.isnan(export._num(np.float32(1.5)))
