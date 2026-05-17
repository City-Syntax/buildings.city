from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = Path(__file__).resolve().parent
USER_DATA_ROOT = REPO_ROOT / 'user-data'
TEMPLATES_JSON_PATH = USER_DATA_ROOT / 'simulation' / 'templates.json'
GENERATED_IDF_DIR = SERVICE_ROOT / 'idf' / 'generated'
GENERATOR_WORK_DIR = SERVICE_ROOT / '.cache' / 'idf-generator'
WEATHER_ZIP_PATH = USER_DATA_ROOT / 'simulation' / 'weather' / 'SGP_SG_Tengah.AP.486870_TMYx.zip'


def _normalize_token(value: Any) -> str:
    return ''.join(ch for ch in str(value or '').strip().lower() if ch.isalnum())


def load_templates() -> list[dict[str, Any]]:
    with TEMPLATES_JSON_PATH.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    templates = data.get('templates') if isinstance(data, dict) else data
    if not isinstance(templates, list):
        raise ValueError('templates.json must contain a list or an object with a templates list.')
    return templates


def write_templates(templates: list[dict[str, Any]]) -> None:
    TEMPLATES_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    TEMPLATES_JSON_PATH.write_text(
        json.dumps(templates, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )


def update_archetype_template(archetype: str, simulation_parameters: dict[str, Any]) -> dict[str, Any]:
    if not archetype:
        raise ValueError('archetype is required.')
    if not isinstance(simulation_parameters, dict):
        raise ValueError('simulation_parameters must be an object.')

    templates = load_templates()
    target = _normalize_token(archetype)
    updated = False
    for item in templates:
        if _normalize_token(item.get('archetype')) == target:
            item['archetype'] = archetype
            item['simulation_parameters'] = simulation_parameters
            updated = True
            break

    if not updated:
        templates.append({
            'archetype': archetype,
            'simulation_parameters': simulation_parameters,
        })

    write_templates(templates)
    try:
        from .geometry_service import load_template_wwr_map

        load_template_wwr_map.cache_clear()
    except Exception:
        pass
    return {
        'archetype': archetype,
        'templates_json_path': str(TEMPLATES_JSON_PATH),
        'updated': updated,
    }


def regenerate_idf_templates() -> dict[str, Any]:
    GENERATED_IDF_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(APP_ROOT / 'generate_idfs.py'),
        '--templates-json',
        str(TEMPLATES_JSON_PATH),
        '--weather',
        str(WEATHER_ZIP_PATH),
        '--output-dir',
        str(GENERATED_IDF_DIR),
        '--work-dir',
        str(GENERATOR_WORK_DIR),
        '--no-zone-json',
    ]
    completed = subprocess.run(
        command,
        cwd=str(SERVICE_ROOT),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            'IDF template generation failed.\n'
            f'stdout:\n{completed.stdout[-4000:]}\n'
            f'stderr:\n{completed.stderr[-4000:]}'
        )

    generated = sorted(path.name for path in GENERATED_IDF_DIR.glob('*.idf'))
    try:
        from .idf_writer import list_available_templates

        list_available_templates.cache_clear()
    except Exception:
        pass
    return {
        'status': 'ok',
        'generated_idf_dir': str(GENERATED_IDF_DIR),
        'generated_count': len(generated),
        'generated_templates': generated,
        'stdout_tail': completed.stdout[-2000:],
    }


def sync_archetype_template(archetype: str, simulation_parameters: dict[str, Any]) -> dict[str, Any]:
    update_result = update_archetype_template(archetype, simulation_parameters)
    regenerate_result = regenerate_idf_templates()
    return {
        'status': 'ok',
        **update_result,
        'idf_generation': regenerate_result,
    }
