# posidonia-watch

Mapping where boats anchor on protected **Posidonia oceanica** seagrass meadows across the Mediterranean, using free satellite data.

Anchors and chains tear up Posidonia, a slow-growing, endemic seagrass that stores large amounts of carbon and shelters juvenile fish. Existing studies of anchoring pressure are local (single bays). This project combines two open datasets to produce a **Mediterranean-wide, monthly** picture:

- **Global Fishing Watch – Sentinel-2 vessel detections** (CC0, monthly on Zenodo): every vessel seen in 10 m Sentinel-2 imagery since 2019, with estimated length, speed and heading.
- **EMODnet Seabed Habitats – seagrass EOV 2025** (CC-BY 4.0): mapped Posidonia meadows.

Stationary vessels (≈0 kn) inside Posidonia polygons are counted per H3 hexagon and normalised by the number of cloud-free satellite overpasses.

> Limitations: 10 m imagery only detects vessels longer than roughly 10–15 m, so small boats are under-counted. Moored vessels on legal buoys look the same as anchored ones. Results show *pressure*, not individual violations.

## Layout

```
pipeline/   Python data pipeline (uv). Checked weekly for new releases in GitHub Actions.
web/        Astro + Tailwind static site (MapLibre map). Deployed to GitHub Pages.
docs/       Data contract between pipeline and web, methodology notes.
```

See `docs/data-contract.md` for the files the pipeline produces.

## Data & licences

- **Code**: [MIT](LICENSE).
- **Published data** (`web/public/data/`): CC BY 4.0. When reusing it, credit posidonia-watch and the sources below.
- **Sources**:
  - Global Fishing Watch (2026). *Vessel detections from Sentinel 2*. Zenodo. https://doi.org/10.5281/zenodo.15978308 – CC0 1.0. Contains modified Copernicus Sentinel data.
  - EMODnet Seabed Habitats (2025). *Seagrass cover (Essential Ocean Variable) in Europe and the Caribbean, version 2025*. [Catalogue record](https://emodnet.ec.europa.eu/geonetwork/srv/eng/catalog.search#/metadata/39746d9c-4220-425c-bc26-7cb3056c36a5). Contains information sourced from multiple organisations through EMODnet Seabed Habitats. CC BY 4.0. Modified: European subset filtered to *Posidonia oceanica*, simplified for display.
  - Flanders Marine Institute (2023). *Maritime Boundaries Geodatabase: Maritime Boundaries and Exclusive Economic Zones (200NM), version 12*. https://doi.org/10.14284/632 – CC BY 4.0. Used only to assign detections to countries.
  - Basemap: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors (ODbL), loaded at runtime and not redistributed.
- **Third-party software** in the site bundle: licence texts are generated at build time into `THIRD_PARTY_LICENSES.txt`.
