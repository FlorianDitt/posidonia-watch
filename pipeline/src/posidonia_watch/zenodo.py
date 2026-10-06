"""Discover GFW Sentinel-2 vessel-detection releases on Zenodo.

All monthly and annual releases are *versions* of one Zenodo concept record
(``conceptrecid`` 15978308). Zenodo's anonymous search API caps ``size`` at 25
(larger values give "A validation error occurred"), so we page through
``q=parent.id:<concept>&allversions=true``.

Some versions are incomplete (e.g. only the footprints file) or superseded by a
later re-upload for the same period; :func:`select_releases` keeps, per period,
the most recently published version that has both a detections and an
overpass file.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import requests

log = logging.getLogger(__name__)

_PERIOD_RE = re.compile(r"^\s*(\d{6}|\d{4})\b")
_DET_RE = re.compile(r"^sentinel2_vessel_detections_.*_(\d{4,6})\.csv$")
_OVP_RE = re.compile(r"^sentinel2_overpass_(\d{4,6})\.csv$")


@dataclass(frozen=True)
class Release:
    record_id: int
    period: str  # "YYYYMM" (monthly) or "YYYY" (annual)
    title: str
    published: str
    detections_url: str | None
    detections_name: str | None
    detections_size: int | None
    overpass_url: str | None
    overpass_name: str | None
    overpass_size: int | None

    @property
    def is_annual(self) -> bool:
        return len(self.period) == 4

    @property
    def complete(self) -> bool:
        return bool(self.detections_url and self.overpass_url and (self.overpass_size or 1) > 0)

    @property
    def months(self) -> list[str]:
        """Months ("YYYY-MM") covered by this release."""
        if self.is_annual:
            return [f"{self.period}-{m:02d}" for m in range(1, 13)]
        return [f"{self.period[:4]}-{self.period[4:]}"]

    @property
    def record_url(self) -> str:
        return f"https://zenodo.org/records/{self.record_id}"


def parse_record(rec: dict) -> Release | None:
    title = rec.get("metadata", {}).get("title", "") or rec.get("title", "")
    m = _PERIOD_RE.match(title)
    det = ovp = None
    for f in rec.get("files", []) or []:
        key = f.get("key", "")
        url = (f.get("links") or {}).get("self")
        if not url:
            url = f"https://zenodo.org/api/records/{rec['id']}/files/{key}/content"
        if _DET_RE.match(key):
            det = (url, key, f.get("size"))
        elif _OVP_RE.match(key):
            ovp = (url, key, f.get("size"))
    period = m.group(1) if m else None
    if period is None:
        for x in (det, ovp):
            if x:
                mm = (_DET_RE.match(x[1]) or _OVP_RE.match(x[1]))
                period = mm.group(1) if mm else None
                break
    if period is None:
        return None
    return Release(
        record_id=int(rec["id"]),
        period=period,
        title=title,
        published=rec.get("metadata", {}).get("publication_date", "") or rec.get("created", ""),
        detections_url=det[0] if det else None,
        detections_name=det[1] if det else None,
        detections_size=det[2] if det else None,
        overpass_url=ovp[0] if ovp else None,
        overpass_name=ovp[1] if ovp else None,
        overpass_size=ovp[2] if ovp else None,
    )


def select_releases(releases: list[Release]) -> dict[str, Release]:
    """Per period keep the newest complete release."""
    best: dict[str, Release] = {}
    for r in releases:
        if not r.complete:
            continue
        cur = best.get(r.period)
        if cur is None or (r.published, r.record_id) > (cur.published, cur.record_id):
            best[r.period] = r
    return dict(sorted(best.items()))


def _get(url: str, params: dict | None = None, timeout: int = 60) -> dict:
    resp = requests.get(url, params=params, timeout=timeout, headers={"Accept": "application/json"})
    resp.raise_for_status()
    return resp.json()


def discover(api: str, concept_recid: str, fallback: dict[str, int] | None = None) -> dict[str, Release]:
    """Return {period: Release} for all complete releases."""
    found: list[Release] = []
    try:
        url = f"{api}/records"
        params = {"q": f"parent.id:{concept_recid}", "allversions": "true", "size": 25, "page": 1, "sort": "newest"}
        while True:
            data = _get(url, params)
            hits = data["hits"]["hits"]
            for rec in hits:
                r = parse_record(rec)
                if r:
                    found.append(r)
            total = data["hits"].get("total", 0)
            if not hits or params["page"] * 25 >= total:
                break
            params["page"] += 1
        log.info("Zenodo search: %d versions found", len(found))
    except Exception as exc:  # network / API change
        log.warning("Zenodo search failed (%s); using fallback record list", exc)
        found = []
    if not found and fallback:
        for period, rid in fallback.items():
            try:
                r = parse_record(_get(f"{api}/records/{rid}"))
                if r:
                    found.append(r)
            except Exception as exc:
                log.warning("Could not fetch record %s (%s): %s", rid, period, exc)
    return select_releases(found)
