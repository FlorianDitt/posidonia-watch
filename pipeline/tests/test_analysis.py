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


def test_dedupe_keeps_the_matched_most_confident_version_of_a_detection():
    df = pd.DataFrame({
        "lat": [43.1, 43.1, 43.1, 43.2],
        "lon": [7.1, 7.1, 7.1, 7.1],
        "detect_timestamp": ["2025-07-01 10:30:05"] * 4,
        "mmsi": [None, "247000001", "247000001", None],
        "matching_confidence": [np.nan, np.float32(0.5), np.float32(0.95), np.nan],
    })
    out = analysis.dedupe(df)
    assert out.index.tolist() == [2, 3]  # original order kept
    assert out["matching_confidence"].iloc[0] == np.float32(0.95)


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


def test_ais_fields_confirm_stationary_only_for_confident_matches_with_both_speeds():
    df = pd.DataFrame({
        "mmsi":                ["227000001", "247000002", "3", None, "", "306000006"],
        "matching_confidence": [0.95, 0.95, 0.5, 0.99, 0.99, 0.95],
        "ais_speed_kn_before": [0.2, 6.0, 0.1, 0.1, 0.1, np.nan],
        "ais_speed_kn_after":  [0.4, 7.0, 0.1, 0.1, 0.1, 0.3],
    })
    ais = analysis.ais_fields(df, {"ais_confidence_min": 0.9, "speed_kn_max": 1.0})
    assert ais["ais_matched"].tolist() == [True, True, True, False, False, True]
    assert ais["ais_confident"].tolist() == [True, True, False, False, False, True]
    assert ais["ais_stationary"].tolist() == [True, False, False, False, False, False]  # last: speed unknown,
    assert ais["ais_moving"].tolist() == [False, True, False, False, False, False]      # so neither of the two
    assert ais["ais_speed_kn"].iloc[1] == 6.5
    assert np.isnan(ais["ais_speed_kn"].iloc[3])  # no match: speed is not reported


def test_ais_fields_keep_a_match_without_confidence_as_uncertain():
    df = pd.DataFrame({"mmsi": ["227000009"], "matching_confidence": [np.nan],
                       "ais_speed_kn_before": [0.1], "ais_speed_kn_after": [0.1]})
    ais = analysis.ais_fields(df, {"ais_confidence_min": 0.9, "speed_kn_max": 1.0})
    assert ais["ais_matched"].tolist() == [True]
    assert ais["ais_confident"].tolist() == [False]
    assert ais["ais_stationary"].tolist() == [False]


def test_ais_fields_compare_float32_cache_values_at_their_decimal_value():
    df = pd.DataFrame({
        "mmsi": ["227000001", "227000002"],
        "matching_confidence": np.array([0.9, 0.95], dtype=np.float32),  # 0.9 widens to 0.89999998
        "ais_speed_kn_before": np.array([0.3, 1.1], dtype=np.float32),
        "ais_speed_kn_after": np.array([0.3, 0.9], dtype=np.float32),
    })
    ais = analysis.ais_fields(df, {"ais_confidence_min": 0.9, "speed_kn_max": 1.0})
    assert ais["ais_confident"].tolist() == [True, True]
    assert ais["ais_stationary"].tolist() == [True, False]
    assert ais["ais_moving"].tolist() == [False, True]


def test_ais_fields_treat_columns_missing_from_old_caches_as_unmatched():
    df = pd.DataFrame({"mmsi": [np.nan], "matching_confidence": [np.nan],
                       "ais_speed_kn_before": [np.nan], "ais_speed_kn_after": [np.nan]})
    ais = analysis.ais_fields(df, {"ais_confidence_min": 0.9, "speed_kn_max": 1.0})
    assert not ais["ais_matched"].any() and not ais["ais_confident"].any()


def test_flag_of_reads_the_mid_of_nine_digit_ship_mmsis_only():
    from posidonia_watch.flags import flag_of
    got = flag_of(pd.Series(["247123456", " 227123456", "970123456", "24712345", None, "", "306000006"]))
    # 970: SART beacon, not a ship; 306: no single flag
    assert got.tolist() == ["IT", "FR", None, None, None, None, None]


def test_hex_monthly_counts_ais_matches_per_cell_and_month():
    anch = pd.DataFrame({
        "on_posidonia": [True, True, True, False], "month": ["2025-07"] * 4, "h3": ["a", "a", "a", None],
        "large": [True, False, True, True], "ais_confident": [True, True, False, True],
        "ais_stationary": [True, False, False, True], "ais_moving": [False, True, False, False],
    })
    ovp = pd.DataFrame({"h3_id": ["a"], "month": ["2025-07"], "overpasses_cloud_under_20": [3]})
    rows, clear = analysis.hex_monthly(anch, ["a"], ovp, ["2025-07"])
    r = rows.iloc[0]
    assert (r.n, r.large, r.ais, r.ais_large, r.ais_st, r.ais_st_large, r.ais_mv) == (3, 2, 2, 1, 1, 1, 1)
    assert clear.tolist() == [[3]]


def test_ais_monthly_totals_sum_the_hex_monthly_counts_over_the_cells():
    anch = pd.DataFrame({
        "on_posidonia": [True, True, True, True, False], "month": ["2025-07"] * 5, "h3": ["a", "a", "b", "b", None],
        "large": [True, False, True, False, True], "ais_confident": [True, True, False, True, True],
        "ais_stationary": [True, False, False, True, True], "ais_moving": [False, False, False, False, False],
    })
    ovp = pd.DataFrame({"h3_id": ["a"], "month": ["2025-07"], "overpasses_cloud_under_20": [3]})
    months = ["2025-06", "2025-07"]
    rows, _ = analysis.hex_monthly(anch, ["a", "b"], ovp, months)
    totals = analysis.ais_monthly_totals(rows, months)
    assert totals.index.tolist() == months
    t = totals.loc["2025-07"]
    assert (t.ais_matched_on_posidonia, t.ais_matched_large_on_posidonia) == (3, 1)
    assert (t.ais_stationary_on_posidonia, t.ais_stationary_large_on_posidonia) == (2, 1)
    assert t.ais_moving_on_posidonia == 0  # the third confident match on Posidonia reports no speed
    assert totals.loc["2025-06"].sum() == 0
