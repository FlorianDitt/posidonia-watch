"""Configuration loading and project paths."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

PIPELINE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = PIPELINE_DIR / "config.yaml"


@dataclass
class Config:
    raw: dict[str, Any]
    base_dir: Path = field(default=PIPELINE_DIR)

    # --- convenience accessors -------------------------------------------------
    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return tuple(self.raw["bbox"])  # type: ignore[return-value]

    @property
    def exclude_boxes(self) -> list[list[float]]:
        return self.raw.get("exclude_boxes", [])

    @property
    def h3_resolution(self) -> int:
        return int(self.raw.get("h3_resolution", 7))

    @property
    def params(self) -> dict[str, float]:
        return self.raw["params"]

    @property
    def filters(self) -> dict[str, Any]:
        return self.raw["filters"]

    @property
    def output(self) -> dict[str, Any]:
        return self.raw["output"]

    @property
    def sources(self) -> dict[str, Any]:
        return self.raw["sources"]

    # --- paths ----------------------------------------------------------------
    @property
    def data_dir(self) -> Path:
        return self.base_dir / "data"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def out_dir(self) -> Path:
        p = Path(self.output["dir"])
        return p if p.is_absolute() else (self.base_dir / p).resolve()


def load_config(path: Path | str | None = None) -> Config:
    path = Path(path) if path else DEFAULT_CONFIG
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    return Config(raw=raw, base_dir=path.resolve().parent)
