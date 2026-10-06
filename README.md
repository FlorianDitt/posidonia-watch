# posidonia-watch

Mapping where boats anchor on protected **Posidonia oceanica** seagrass meadows across the Mediterranean, using free satellite data.

Anchors and chains tear up Posidonia, a slow-growing, endemic seagrass that stores large amounts of carbon and shelters juvenile fish. Existing studies of anchoring pressure are local (single bays). This project combines two open datasets to produce a **Mediterranean-wide, monthly** picture:

- **Global Fishing Watch – Sentinel-2 vessel detections** (CC0, monthly on Zenodo): every vessel seen in 10 m Sentinel-2 imagery since 2019, with estimated length, speed and heading.
- **EMODnet Seabed Habitats – seagrass EOV 2025** (CC-BY 4.0): mapped Posidonia meadows.

Stationary vessels (≈0 kn) inside Posidonia polygons are counted per H3 hexagon and normalised by the number of cloud-free satellite overpasses.

> Limitations: 10 m imagery only detects vessels longer than roughly 10–15 m, so small boats are under-counted. Moored vessels on legal buoys look the same as anchored ones. Results show *pressure*, not individual violations.

## Layout

```
pipeline/   Python data pipeline (uv). Runs monthly in GitHub Actions.
web/        Astro + Tailwind static site (MapLibre map). Deployed to GitHub Pages.
docs/       Data contract between pipeline and web, methodology notes.
```

See `docs/data-contract.md` for the files the pipeline produces.

## Data & licences

Code: MIT. Derived data inherits attribution requirements of EMODnet (CC-BY 4.0). GFW detections are CC0; please still credit Global Fishing Watch.
