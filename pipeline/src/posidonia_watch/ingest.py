"""Stream GFW CSVs from Zenodo and keep only the Mediterranean subset.

The global CSVs are 0.5-1 GB (monthly detections), 1.5 GB (monthly overpasses)
and 6-20 GB (annual files). Zenodo does not support HTTP range requests, so we
stream each file once through pyarrow's incremental CSV reader, filter every
block in memory and write only the matching rows to a small parquet file.
Nothing global is ever stored on disk.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
import requests

log = logging.getLogger(__name__)

DETECTION_COLUMNS: dict[str, pa.DataType] = {
    "scene_id": pa.string(),
    "lat": pa.float64(),
    "lon": pa.float64(),
    "detect_timestamp": pa.string(),
    "speed_kn_inferred": pa.float32(),
    "heading_deg_inferred": pa.float32(),
    "length_m_inferred": pa.float32(),
    "presence_score": pa.float32(),
    "nonvessel_score": pa.float32(),
    "cloud_score": pa.float32(),
    "likely_infrastructure": pa.bool_(),
    "potential_ice": pa.bool_(),
    "matching_score": pa.float32(),
    "mmsi": pa.string(),
    "ais_length_m": pa.float32(),
}

OVERPASS_COLUMNS: dict[str, pa.DataType] = {
    "h3_id": pa.string(),
    "month": pa.string(),
    "overpasses": pa.int32(),
    "overpasses_cloud_under_20": pa.int32(),
}

BLOCK_SIZE = 32 << 20  # 32 MB CSV blocks


def _open_stream(url: str, timeout: int = 120):
    resp = requests.get(url, stream=True, timeout=timeout)
    resp.raise_for_status()
    resp.raw.decode_content = True
    return resp


def stream_filter_csv(
    url: str,
    columns: dict[str, pa.DataType],
    keep,  # Callable[[pa.RecordBatch], pa.Array(bool)]
    out_path: Path,
    transform=None,  # Callable[[pa.Table], pa.Table]
    retries: int = 3,
    expected_size: int | None = None,
) -> int:
    """Stream a remote CSV, keep rows where ``keep(batch)`` is true, write parquet.

    Returns the number of rows written. Writes atomically (tmp file + rename).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".parquet.tmp")
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            t0 = time.time()
            resp = _open_stream(url)
            reader = pacsv.open_csv(
                resp.raw,
                read_options=pacsv.ReadOptions(block_size=BLOCK_SIZE),
                convert_options=pacsv.ConvertOptions(
                    include_columns=list(columns),
                    column_types=columns,
                    true_values=["true", "True", "TRUE"],
                    false_values=["false", "False", "FALSE"],
                ),
            )
            parts: list[pa.Table] = []
            n_in = 0
            for batch in reader:
                n_in += batch.num_rows
                mask = keep(batch)
                sub = batch.filter(mask)
                if sub.num_rows:
                    parts.append(pa.Table.from_batches([sub]))
            schema = pa.schema([(k, v) for k, v in columns.items()])
            table = pa.concat_tables(parts) if parts else schema.empty_table()
            if transform:
                table = transform(table)
            pq.write_table(table, tmp, compression="zstd")
            tmp.replace(out_path)
            log.info(
                "%s: %d/%d rows kept in %.0fs -> %s",
                url.rsplit("/", 2)[-2], table.num_rows, n_in, time.time() - t0, out_path.name,
            )
            return table.num_rows
        except (requests.RequestException, pa.ArrowInvalid, OSError) as exc:
            last_exc = exc
            log.warning("Attempt %d/%d failed for %s: %s", attempt, retries, url, exc)
            time.sleep(10 * attempt)
    raise RuntimeError(f"Failed to stream {url}") from last_exc


def bbox_mask(batch: pa.RecordBatch, bbox: Iterable[float]) -> pa.Array:
    min_lon, min_lat, max_lon, max_lat = bbox
    lat, lon = batch.column("lat"), batch.column("lon")
    return pc.and_(
        pc.and_(pc.greater_equal(lon, min_lon), pc.less_equal(lon, max_lon)),
        pc.and_(pc.greater_equal(lat, min_lat), pc.less_equal(lat, max_lat)),
    )


def add_month_from_timestamp(table: pa.Table) -> pa.Table:
    """'2026-06-09 16:59:26.591 UTC' -> month '2026-06'."""
    month = pc.utf8_slice_codeunits(table.column("detect_timestamp"), 0, 7)
    return table.append_column("month", month)


def normalise_overpass_month(table: pa.Table) -> pa.Table:
    """'2025-07-01' -> '2025-07'."""
    idx = table.schema.get_field_index("month")
    return table.set_column(idx, "month", pc.utf8_slice_codeunits(table.column("month"), 0, 7))


def fetch_detections(url: str, bbox, out_path: Path, expected_size: int | None = None) -> int:
    return stream_filter_csv(
        url,
        DETECTION_COLUMNS,
        keep=lambda b: bbox_mask(b, bbox),
        out_path=out_path,
        transform=add_month_from_timestamp,
        expected_size=expected_size,
    )


def fetch_overpasses(url: str, cells: set[str], out_path: Path, expected_size: int | None = None) -> int:
    value_set = pa.array(sorted(cells), type=pa.string())
    return stream_filter_csv(
        url,
        OVERPASS_COLUMNS,
        keep=lambda b: pc.is_in(b.column("h3_id"), value_set=value_set),
        out_path=out_path,
        transform=normalise_overpass_month,
        expected_size=expected_size,
    )
