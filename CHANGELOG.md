# Changelog

All notable changes to **Buildings.city** are documented in this file.

This project follows [Semantic Versioning](https://semver.org/) and uses the general structure of [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).


## [Unreleased]

- No unreleased changes documented yet.


## [2.0.0] - 2026-05-16

### Added

- Reframed Buildings.city as a local-first UBEM platform with a main map, archetype prediction mode, and building simulation mode.
- Added centralized `user-data/` workflow for city configuration, active GeoJSON datasets, simulation templates, and weather inputs.
- Added multi-page Vite entry points for:
  - `index.html`
  - `archetype-prediction.html`
  - `energy-simulation.html`
- Added local GeoJSON synchronization through `POST /api/sync-geojson-dataset`, allowing reviewed outputs to be written back to the active dataset.
- Added dedicated ML API workflow for unknown or missing archetype prediction.
- Added prediction job polling, progress reporting, configurable feature selection, confidence thresholding, and dynamic SMOTE balancing support.
- Added building energy simulation mode with target/context selection, geometry preparation, template-driven IDF generation, EnergyPlus execution support, result review, and export tools.
- Added simulation backend endpoints for simulation jobs, building-library reloads, template sync, IDF regeneration, SQL artifact download, and hourly output retrieval.
- Added editable archetype simulation templates through `user-data/simulation/templates.json`.
- Added support for syncing selected simulation results and building parameter edits back into the active GeoJSON dataset.

### Changed

- Moved normal user-editable project data from source folders into `user-data/`.
- Updated the main documentation to present Buildings.city as a local-first UBEM platform and simulation workflow system.
- Updated configuration loading so the frontend and optional APIs share the active GeoJSON declared by `user-data/config.json -> buildings_source.data`.
- Updated simulation geometry lookup to resolve buildings from the configured GeoJSON library using stable building identifiers.
- Updated terminology across documentation to use consistent `frontend`, `ML API`, `Simulation API`, `active GeoJSON`, and `sync` language.
- Improved onboarding for users who only need the frontend map by making ML and simulation services explicitly optional.
- Improved dataset completion workflows by allowing predicted archetypes to be reviewed before syncing.
- Improved simulation workflow continuity by supporting backend building-library reload after GeoJSON sync.
- Improved project documentation for non-specialist users and first-time local setup.

### Notes

- EnergyPlus is only required for EnergyPlus-backed simulation workflows.
- The main map can run with only Node.js, npm, a browser, a Mapbox token, and a valid active GeoJSON dataset.


## [1.0.0] - 2026-03-16

### Added

- Initial release of the **Buildings.city** package.
- Lightweight toolkit for building city-scale Urban Building Energy Modeling (UBEM) visualization platforms.
- Map-based building visualization using Mapbox GL JS.
- Configuration-driven platform setup via `config.json`.
- Support for loading city building datasets using GeoJSON.
- Interactive building layer rendering and popup information.
- Basic structure for integrating UBEM results.
- Support for exploring operational carbon and embodied carbon datasets.
- Example configuration and dataset structure for new cities.

### Documentation

- Added contribution guidelines.
- Added MIT license.
