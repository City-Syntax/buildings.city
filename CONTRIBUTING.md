# Contributing to Buildings.city

Thank you for your interest in contributing to **Buildings.city**.

Buildings.city is a local-first Urban Building Energy Modeling (UBEM) platform that helps cities, researchers, and urban energy teams build interactive applications from their own building datasets. The project aims to lower the barrier to city-scale building visualization, missing archetype completion, and EnergyPlus-based simulation workflows.

We welcome contributions that make the platform easier to use, easier to adapt, and more reliable across different city datasets.


## Contribution Areas

### Documentation

Documentation improvements are highly valuable, especially when they help non-specialist users get started faster.

Good documentation contributions include:

- clearer setup instructions
- beginner-friendly workflow guides
- examples for preparing GeoJSON datasets
- troubleshooting notes for local APIs
- screenshots or short explanations of UI workflows
- corrections to unclear or outdated text

### Frontend Platform

The frontend is the local Vite/HTML/JavaScript app used for map visualization, archetype review, prediction workflow UI, and simulation workflow UI.

Useful frontend contributions include:

- clearer map interactions
- improved chart or legend behavior
- better dataset diagnostics
- more robust GeoJSON loading and validation
- improved sync review states
- accessibility and responsive layout improvements

Please keep frontend changes lightweight and consistent with the existing data-driven configuration approach.

### ML API

The ML API supports missing or unknown building archetype prediction from partially labeled GeoJSON datasets.

Useful ML contributions include:

- improved feature extraction
- clearer model diagnostics
- better handling of small or imbalanced datasets
- safer confidence thresholding
- more useful prediction summaries
- tests for edge cases in GeoJSON input

### Simulation API

The Simulation API supports building selection, geometry preparation, archetype template use, IDF generation, EnergyPlus execution, result parsing, and output sync.

Useful simulation contributions include:

- more robust geometry handling
- clearer EnergyPlus error reporting
- improved template validation
- better SQL and hourly output parsing
- safer artifact management
- tests for building ID lookup and sync workflows

### Example Data and Configurations

Example datasets and configurations help users adapt the platform to new cities.

Helpful examples include:

- small public GeoJSON datasets
- anonymized or simplified building datasets
- example `user-data/config.json` files
- example simulation template sets
- notes explaining field mappings and assumptions

Only contribute data that you have permission to share.


## Development Setup

Start with the frontend:

```bash
npm install
npm run dev
```

Optional ML API:

```bash
npm run ml:setup
npm run ml:start
```

Optional Simulation API:

```bash
npm run simulation:setup
npm run simulation:start
```

Most project-specific edits should happen in:

```text
user-data/
```

Most users should not need to edit application source code unless they are contributing platform features or service behavior.


## Development Principles

When contributing, please keep these principles in mind:

- Make the platform easier for first-time users.
- Keep workflows local-first and transparent.
- Prefer configuration and data-driven behavior over hard-coded city assumptions.
- Keep ML and simulation services optional.
- Avoid unnecessary heavy dependencies.
- Preserve compatibility with valid GeoJSON `FeatureCollection` datasets.
- Keep sync behavior explicit and reviewable before writing back to source data.
- Document assumptions when adding energy, carbon, ML, or simulation logic.


## Pull Request Guidelines

Before submitting a pull request:

- keep the change focused and clearly scoped
- explain what changed and why
- note whether the change affects frontend, ML API, Simulation API, documentation, or user data
- include screenshots for visible UI changes
- include setup or migration notes when configuration changes
- avoid committing local generated logs, temporary files, or private datasets

Recommended checks:

```bash
npm run build
```

If your change affects an optional API, also run the relevant setup/start command and document any manual verification you performed.


## Data, Privacy, and Scientific Assumptions

Many Buildings.city workflows use city-scale datasets, inferred archetypes, simulation assumptions, and illustrative energy or carbon values.

Please be careful when contributing:

- Do not commit private, restricted, or sensitive building data.
- Clearly label synthetic, inferred, or illustrative datasets.
- Document assumptions behind energy, carbon, ML, and simulation values.
- Avoid presenting unvalidated estimates as measured or policy-ready results.


## Questions and Suggestions

If you have an idea but are unsure how to implement it, open an issue or start a discussion before making a large change.

Contributions from cities, researchers, designers, developers, and building energy practitioners are welcome.
