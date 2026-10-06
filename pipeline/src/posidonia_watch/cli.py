"""Command line interface: ``posidonia-watch {discover,fetch,build,update,reference}``."""

from __future__ import annotations

import argparse
import logging
import sys
import time

from . import pipeline
from .config import load_config

log = logging.getLogger("posidonia_watch")


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="posidonia-watch", description=__doc__)
    p.add_argument("--config", help="path to config.yaml (default: pipeline/config.yaml)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("discover", help="list GFW releases available on Zenodo and whether they are cached")

    f = sub.add_parser("fetch", help="download + filter releases into pipeline/data/cache")
    f.add_argument("--months", nargs="+", required=True,
                   help="months 'YYYY-MM' or whole years 'YYYY' (monthly releases preferred, else annual)")
    f.add_argument("--force", action="store_true", help="re-download even if cached")

    sub.add_parser("build", help="aggregate everything cached -> web/public/data")

    u = sub.add_parser("update", help="fetch releases not cached yet (newest first), then build")
    u.add_argument("--max-releases", type=int, default=None, help="stop after fetching N releases")
    u.add_argument("--max-minutes", type=float, default=None,
                   help="do not start a new download after this many minutes (CI time budget)")
    u.add_argument("--since", default=None, help="only consider releases from this year on (YYYY)")
    u.add_argument("--no-build", action="store_true")

    r = sub.add_parser("reference", help="(re)download Posidonia polygons and EEZs")
    r.add_argument("--refresh", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config(args.config)

    if args.cmd == "discover":
        releases = pipeline.discover(cfg)
        manifest = pipeline.load_manifest(cfg)
        for period, r in releases.items():
            flag = "cached" if pipeline.is_cached(cfg, r, manifest) else "-"
            print(f"{period:>7}  {r.record_id:>9}  {r.published}  {flag:6}  {r.title}")
        return 0

    if args.cmd == "reference":
        pipeline.ensure_reference(cfg, refresh=args.refresh)
        return 0

    if args.cmd == "fetch":
        _, _, cells = pipeline.ensure_reference(cfg)
        releases = pipeline.discover(cfg)
        todo = pipeline.releases_for_months(releases, args.months)
        for rel in todo:
            pipeline.fetch_release(cfg, rel, cells, force=args.force)
        return 0

    if args.cmd == "build":
        pipeline.build(cfg)
        return 0

    if args.cmd == "update":
        t0 = time.time()
        _, _, cells = pipeline.ensure_reference(cfg)
        releases = pipeline.discover(cfg)
        manifest = pipeline.load_manifest(cfg)
        # A month covered by a monthly release does not need its annual file,
        # but annual files are the only source for 2019-2024.
        todo = [r for r in releases.values()
                if not pipeline.is_cached(cfg, r, manifest)
                and (args.since is None or r.period[:4] >= args.since)]
        todo.sort(key=lambda r: r.period, reverse=True)  # newest first
        log.info("%d release(s) to fetch: %s", len(todo), ", ".join(r.period for r in todo) or "none")
        fetched = 0
        for rel in todo:
            if args.max_releases is not None and fetched >= args.max_releases:
                log.info("--max-releases reached; remaining releases will be fetched next run")
                break
            if args.max_minutes is not None and (time.time() - t0) / 60 > args.max_minutes:
                log.info("--max-minutes budget used; remaining releases will be fetched next run")
                break
            try:
                pipeline.fetch_release(cfg, rel, cells)
                fetched += 1
            except Exception:
                log.exception("Fetching %s failed; continuing with the others", rel.period)
        if not args.no_build:
            pipeline.build(cfg)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
