import numpy as np
import pandas as pd

from posidonia_watch import analysis

FILTERS = {"presence_score_min": 0.3, "nonvessel_score_max": 0.95, "cloud_score_max": 0.5,
           "exclude_infrastructure": True, "exclude_ice": True}


def test_season_of_puts_december_in_winter():
    assert analysis.season_of("2025-12") == "DJF"
    assert analysis.season_of("2025-01") == "DJF"
    assert analysis.season_of("2025-07") == "JJA"


def test_in_med_mask_drops_points_outside_bbox_and_in_excluded_boxes():
    bbox = [0, 0, 10, 10]
    exclude = [[8, 8, 10, 10]]
    lon = [5, 11, 9, 10]
    lat = [5, 5, 9, 0]
    assert analysis.in_med_mask(lon, lat, bbox, exclude).tolist() == [True, False, False, True]


def _detections(**cols):
    base = {"presence_score": 0.9, "nonvessel_score": 0.1, "cloud_score": 0.1, "speed_kn_inferred": 0.2,
            "likely_infrastructure": False, "potential_ice": False}
    n = max(len(v) for v in cols.values())
    return pd.DataFrame({k: cols.get(k, [v] * n) for k, v in base.items()})


def test_quality_mask_applies_each_filter():
    df = _detections(
        presence_score=[0.9, 0.2, 0.9, 0.9, 0.9],
        nonvessel_score=[0.1, 0.1, 0.99, 0.1, 0.1],
        cloud_score=[0.1, 0.1, 0.1, 0.8, 0.1],
        likely_infrastructure=[False, False, False, False, True],
    )
    assert analysis.quality_mask(df, FILTERS).tolist() == [True, False, False, False, False]


def test_quality_mask_keeps_missing_scores_and_flags():
    df = _detections(cloud_score=[np.nan], nonvessel_score=[np.nan], potential_ice=[None])
    assert analysis.quality_mask(df, FILTERS).tolist() == [True]


def test_anchored_mask_requires_speed_strictly_below_threshold():
    df = _detections(speed_kn_inferred=[0.0, 0.99, 1.0, 5.0])
    assert analysis.anchored_mask(df, {"speed_kn_max": 1.0}, FILTERS).tolist() == [True, True, False, False]


def test_dedupe_drops_same_detection_from_two_processing_versions():
    df = pd.DataFrame({
        "lat": [43.12341, 43.12339, 43.2],
        "lon": [7.1, 7.1, 7.1],
        "detect_timestamp": ["2025-07-01 10:30:05", "2025-07-01 10:30:59", "2025-07-01 10:30:05"],
    })
    assert len(analysis.dedupe(df)) == 2


def test_density_is_nan_without_clear_overpasses():
    out = analysis.density([4, 3, 0], [2, 0, 5])
    assert out[0] == 2.0
    assert np.isnan(out[1])
    assert out[2] == 0.0


def test_hotspots_rank_by_count_then_density_and_skip_empty_cells():
    hexes = pd.DataFrame({
        "h3": ["a", "b", "c", "d"],
        "on_posidonia": [5, 5, 9, 0],
        "density": [0.1, np.nan, 0.5, 1.0],
    })
    assert analysis.hotspots(hexes, n=10)["h3"].tolist() == ["c", "a", "b"]
