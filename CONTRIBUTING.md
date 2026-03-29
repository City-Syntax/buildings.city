# Create the CONTRIBUTING.md file for download

# Contributing to Buildings.city

Thank you for your interest in contributing to **Buildings.city**.

Buildings.city is an open-source toolkit designed to help cities and researchers quickly build interactive Urban Building Energy Modeling (UBEM) platforms using their own building datasets. The project aims to lower the technical barrier for deploying urban-scale energy visualization tools and to make UBEM platforms easier to adapt across different cities.

We welcome contributions that improve the platform, documentation, or usability of the package.

---

## Ways to Contribute

There are several ways to contribute to the project.

### Documentation Improvements

Improving documentation is one of the most valuable contributions. Examples include:

- clarifying setup instructions
- improving the platform documentation
- adding tutorials or workflow explanations
- fixing typos or unclear sections

### Platform Improvements

Contributions that improve the usability or capabilities of the toolkit are welcome, such as:

- improving map interactions or UI components
- adding new visualization features
- improving performance
- enhancing GeoJSON data handling
- improving configuration flexibility

When proposing new features, please try to keep the platform lightweight and configuration-driven.

### Example Cities and Datasets

Example datasets can help other users understand how to deploy the platform for their own cities.

Possible contributions include:

- example GeoJSON building datasets
- example city configurations
- demonstration UBEM outputs
- documentation describing dataset structure

If data cannot be shared publicly, anonymized or simplified examples are also helpful.

---

## Development Setup

To work on the project locally:

npm install
npm run dev

The platform is built with:

- Vite
- Mapbox GL JS
- a configuration-driven architecture

Most platform behavior is controlled through:

src/config.json

When adding features, please maintain compatibility with the configuration structure where possible.

---

## Design Principles

Buildings.city aims to remain simple, flexible, and easy to adapt for different cities.

When contributing, please try to follow these principles:

- keep the platform lightweight
- avoid introducing heavy dependencies
- prioritize configuration-based solutions
- maintain compatibility with different city datasets
- keep the platform easy to deploy as a static web application

---

## Pull Requests

Before submitting a pull request:

- make sure the change is focused and clearly scoped
- explain what the change does and why it is useful
- keep code simple and readable

If the change affects the interface or visualization, including screenshots is helpful.

---

## Questions or Suggestions

If you have an idea for a feature or improvement but are unsure how to implement it, feel free to open an issue to discuss it.

We welcome contributions from researchers, developers, and cities interested in improving urban energy tools.
