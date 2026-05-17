"""Command line entrypoint for generating archetype IDFs."""

from __future__ import annotations

import argparse
from pathlib import Path

import _bootstrap  # noqa: F401


ROOT = Path(__file__).resolve().parent
SERVICE_ROOT = ROOT.parent
REPO_ROOT = SERVICE_ROOT.parent
USER_SIMULATION_DATA = REPO_ROOT / "user-data" / "simulation"
DEFAULT_TEMPLATES = USER_SIMULATION_DATA / "templates.json"
DEFAULT_WEATHER = USER_SIMULATION_DATA / "weather" / "SGP_SG_Tengah.AP.486870_TMYx.zip"
DEFAULT_OUTPUT = SERVICE_ROOT / "idf" / "generated"
DEFAULT_WORK_DIR = SERVICE_ROOT / ".cache" / "idf-generator"


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Generate one EnergyPlus IDF per archetype."
    )
    parser.add_argument("--templates-json", type=Path, default=DEFAULT_TEMPLATES)
    parser.add_argument("--weather", type=Path, default=DEFAULT_WEATHER)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK_DIR)
    parser.add_argument("--length", type=float, default=20.0)
    parser.add_argument("--width", type=float, default=15.0)
    parser.add_argument("--num-floors", type=int, default=2)
    parser.add_argument("--f2f-height", type=float, default=3.5)
    parser.add_argument(
        "--no-zone-json",
        action="store_true",
        help="Do not write intermediate ZoneComponent JSON files.",
    )
    return parser.parse_args()


def main() -> None:
    """Generate all archetype IDFs."""
    args = parse_args()

    from template_builder import (
        TemplateGeometryConfig,
        load_template_configs,
        write_archetype_idfs,
    )

    configs = load_template_configs(args.templates_json)
    geometry = TemplateGeometryConfig(
        length=args.length,
        width=args.width,
        num_floors=args.num_floors,
        f2f_height=args.f2f_height,
    )
    paths = write_archetype_idfs(
        configs,
        weather=args.weather.resolve(),
        output_dir=args.output_dir,
        work_dir=args.work_dir,
        geometry=geometry,
        write_zone_json=not args.no_zone_json,
    )
    print(f"Wrote {len(paths)} archetype IDFs to {args.output_dir}")
    for archetype, path in paths.items():
        print(f"{archetype}: {path}")


if __name__ == "__main__":
    main()
