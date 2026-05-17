from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from functools import lru_cache
from math import cos, radians
from pathlib import Path
from typing import Any, Callable, Iterator

from .geometry_service import build_target_neighbor_shading_geometry, build_window_geometry

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]
USER_SIMULATION_DATA = REPO_ROOT / 'user-data' / 'simulation'
DEFAULT_IDF_LIBRARY_PATH = Path(os.getenv('IDF_TEMPLATE_LIBRARY', str(USER_SIMULATION_DATA / 'idf-library')))
DEFAULT_GENERATED_IDF_LIBRARY_PATH = Path(os.getenv('GENERATED_IDF_TEMPLATE_LIBRARY', str(SERVICE_ROOT / 'idf' / 'generated')))
DEFAULT_EPW_PATH = Path(os.getenv('EPW_FILE', str(USER_SIMULATION_DATA / 'weather' / 'SGP_SG_Tengah.AP.486870_TMYx.zip')))

ZONE_TEMPLATE_OBJECT_KEYS = [
    # Zone-dependent archetype objects are cloned from the selected template and
    # rebound per generated zone.  The writer should rewrite geometry and zone
    # references, not invent a new archetype/HVAC system in code.
    'PEOPLE',
    'LIGHTS',
    'ELECTRICEQUIPMENT',
    'ZONEINFILTRATION:DESIGNFLOWRATE',
    'ZONEVENTILATION:DESIGNFLOWRATE',
    'SIZING:ZONE',
    'ZONECONTROL:THERMOSTAT',
    'ZONECONTROL:HUMIDISTAT',
    'ZONEHVAC:IDEALLOADSAIRSYSTEM',
    'ZONEHVAC:EQUIPMENTLIST',
    'DESIGNSPECIFICATION:OUTDOORAIR',
]

GEOMETRY_RESET_OBJECT_KEYS = [
    'ZONE',
    'SPACE',
    'SPACELIST',
    'ZONELIST',
    'BUILDINGSURFACE:DETAILED',
    'FENESTRATIONSURFACE:DETAILED',
    'SHADING:BUILDING:DETAILED',
    'SHADING:SITE:DETAILED',
    'SHADING:ZONE:DETAILED',
    # Old zone-scoped template objects contain hardcoded shoebox zone names.
    # They are captured before reset, then cloned/rebound to generated zones.
    'PEOPLE',
    'LIGHTS',
    'ELECTRICEQUIPMENT',
    'ZONEINFILTRATION:DESIGNFLOWRATE',
    'ZONEVENTILATION:DESIGNFLOWRATE',
    'SIZING:ZONE',
    'ZONECONTROL:THERMOSTAT',
    'ZONECONTROL:HUMIDISTAT',
    'ZONEHVAC:IDEALLOADSAIRSYSTEM',
    'ZONEHVAC:EQUIPMENTLIST',
    'ZONEHVAC:EQUIPMENTCONNECTIONS',
    'NODELIST',
    'ZONEMIXING',
    'DESIGNSPECIFICATION:OUTDOORAIR',
    'DESIGNSPECIFICATION:OUTDOORAIR:SPACELIST',
]


OUTPUT_RESET_OBJECT_KEYS = [
    'OUTPUT:VARIABLE',
    'OUTPUT:METER',
    'OUTPUT:METER:METERFILEONLY',
    'OUTPUT:TABLE:SUMMARYREPORTS',
    'OUTPUT:TABLE:MONTHLY',
    'OUTPUT:VARIABLEDICTIONARY',
    'OUTPUT:SQLITE',
    'OUTPUTCONTROL:TABLE:STYLE',
]

ANNUAL_OUTPUT_METERS = [
    # Facility-level meters for robust total site energy parsing across templates.
    'Electricity:Facility',
    'NaturalGas:Facility',
    'Gas:Facility',
    'DistrictCooling:Facility',
    'DistrictHeating:Facility',
    'DistrictHeatingWater:Facility',

    # HVAC/end-use meters.
    'Cooling:Electricity',
    'Cooling:DistrictCooling',
    'Heating:Electricity',
    'Heating:Gas',
    'Heating:NaturalGas',
    'Heating:DistrictHeating',
    'Fans:Electricity',
    'Pumps:Electricity',

    # Internal loads.
    'InteriorLights:Electricity',
    'InteriorEquipment:Electricity',

    # Service hot water. Different templates/fuels expose different meter names.
    # Some may be invalid for a specific template; EnergyPlus only warns. The parser
    # should read whichever appears in the SQL dictionary.
    'WaterSystems:Electricity',
    'WaterSystems:Gas',
    'WaterSystems:NaturalGas',
    'WaterSystems:DistrictHeating',
    'WaterSystems:DistrictHeatingWater',
    'WaterSystems:EnergyTransfer',
    'WaterSystems:Energy',
]

ANNUAL_OUTPUT_VARIABLES = [
    ('*', 'Water Heater Heating Energy'),
    ('*', 'Water Heater Electricity Energy'),
    ('*', 'Water Heater Gas Energy'),
    ('*', 'Water Heater District Heating Energy'),
    ('*', 'Water Heater District Heating Water Energy'),
    ('*', 'Water Use Equipment Heating Energy'),
    ('*', 'Water Use Equipment Hot Water Volume'),
    ('*', 'Water Use Equipment Mains Water Volume'),
]

ARCHETYPE_TEMPLATE_KEYWORDS: dict[str, str] = {
    'nonihl': 'nonihl',
    'non_ihl': 'nonihl',
    'education': 'nonihl',
    'hdb': 'hdb',
    'sfh': 'sfh',
    'landedproperty': 'sfh',
    'landed_property': 'sfh',
    'mfh': 'mfh',
    'privateapartment': 'mfh',
    'private_apartment': 'mfh',
    'residential': 'mfh',
    'hotel': 'hotel',
    'hospitality': 'hotel',
    'retail': 'retail',
    'commercial': 'retail',
    'mixeddevelopment': 'office',
    'mixed_development': 'office',
    'office': 'office',
    'businesspark': 'businesspark',
    'business_park': 'businesspark',
    'hospital': 'hospital',
    'healthcare': 'hospital',
    'polyclinic': 'polyclinic',
    'nursinghome': 'nursinghome',
    'nursing_home': 'nursinghome',
    'ihl': 'ihl',
    'industrial': 'industrialb1',
    'industrialb1': 'industrialb1',
    'industrial_b1': 'industrialb1',
    'industrialb2': 'industrialb2',
    'industrial_b2': 'industrialb2',
    'datacentre': 'datacentre',
    'data_center': 'datacentre',
    'communitycultural': 'civiccommunitycultural',
    'community_cultural': 'civiccommunitycultural',
    'civiccommunitycultural': 'civiccommunitycultural',
    'civic_religious': 'civiccommunitycultural',
    'sports': 'sportsrec',
    'sportsrec': 'sportsrec',
    'sports_recreation': 'sportsrec',
    'restaurant': 'restaurant',
    'hawkercentre': 'hawkercentre',
    'hawker_centre': 'hawkercentre',
    'supermarket': 'supermarket',
}


def _dbg(msg: str) -> None:
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime('%H:%M:%S.%f')[:-3]
    print(f'[IDF {ts}] {msg}', flush=True)


def _rmtree_with_retry(path: Path, max_retries: int = 10, retry_delay: float = 0.5) -> None:
    for attempt in range(max_retries):
        try:
            shutil.rmtree(path)
            _dbg(f'cleanup ok: {path.name} (attempt {attempt+1})')
            return
        except OSError as err:
            _dbg(f'cleanup attempt {attempt+1}/{max_retries} failed for {path.name}: {err}')
            if attempt < max_retries - 1:
                time.sleep(retry_delay)
    shutil.rmtree(path, ignore_errors=True)
    _dbg(f'cleanup final (ignore_errors): {path.name}')


def _normalize_token(value: Any) -> str:
    text = '' if value is None else str(value).strip().lower()
    return ''.join(ch for ch in text if ch.isalnum())


def _safe_file_token(value: Any) -> str:
    raw = '' if value is None else str(value).strip()
    filtered = ''.join(ch if ch.isalnum() or ch in {'-', '_'} else '_' for ch in raw)
    return filtered or 'building'


def _clone_water_use(idf, template_zone, new_zone):
    wus = _idf_objects(idf, 'WATERUSE:EQUIPMENT')
    for obj in wus:
        if obj.Zone_Name.lower() == template_zone.lower():
            new = idf.newidfobject('WATERUSE:EQUIPMENT')
            for f in obj.fieldnames:
                if f == 'Zone_Name':
                    setattr(new, f, new_zone)
                elif f != 'Name':
                    setattr(new, f, getattr(obj, f))
            new.Name = f'{new_zone}:WaterUse'


def _detail_value(detail: Any, field_name: str, default: Any = None) -> Any:
    if detail is None:
        return default
    if isinstance(detail, dict):
        return detail.get(field_name, default)
    return getattr(detail, field_name, default)


def _build_detail_index(building_details: list[Any] | None) -> dict[str, Any]:
    index: dict[str, Any] = {}
    for detail in building_details or []:
        building_id = str(_detail_value(detail, 'building_id', '') or '')
        if building_id:
            index[building_id] = detail
    return index


def _get_idf_class():
    try:
        module = importlib.import_module('eppy.modeleditor')
    except ImportError as error:  # pragma: no cover - depends on optional runtime install
        raise RuntimeError('eppy is not installed in the simulation-service environment. Install it before preparing runtime IDFs.') from error

    return module.IDF


def resolve_idd_path(idd_path: str | None = None) -> Path:
    candidates: list[Path] = []

    if idd_path:
        candidates.append(Path(idd_path))

    for env_name in ('ENERGYPLUS_IDD', 'IDD_FILE', 'EPLUS_IDD'):
        env_value = os.getenv(env_name)
        if env_value:
            candidates.append(Path(env_value))

    candidates.append(SERVICE_ROOT / 'data' / 'Energy+.idd')

    system_drive = os.getenv('SystemDrive', 'C:')
    try:
        candidates.extend(sorted(Path(f'{system_drive}/').glob('EnergyPlusV*/Energy+.idd'), reverse=True))
    except OSError:
        pass

    for candidate in candidates:
        resolved = Path(candidate).expanduser()
        if resolved.exists():
            return resolved.resolve()

    raise FileNotFoundError(
        'No EnergyPlus IDD file was found. Set `ENERGYPLUS_IDD` or `IDD_FILE`, or install EnergyPlus locally.'
    )


def resolve_epw_path(epw_path: str | None = None) -> Path:
    candidate = Path(epw_path or DEFAULT_EPW_PATH).expanduser().resolve()
    if not candidate.exists():
        raise FileNotFoundError(f'Weather file not found: {candidate}')
    if candidate.suffix.lower() == '.zip':
        weather_dir = SERVICE_ROOT / '.cache' / 'weather' / candidate.stem
        weather_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(candidate, 'r') as archive:
            epw_names = [name for name in archive.namelist() if name.lower().endswith('.epw')]
            if not epw_names:
                raise FileNotFoundError(f'No EPW file was found inside weather zip: {candidate}')
            epw_name = epw_names[0]
            epw_path = weather_dir / Path(epw_name).name
            if not epw_path.exists():
                archive.extract(epw_name, weather_dir)
                extracted = weather_dir / epw_name
                if extracted != epw_path:
                    extracted.replace(epw_path)
        return epw_path.resolve()
    return candidate


def configure_eppy_environment(idd_path: str | None = None) -> str:
    IDF = _get_idf_class()
    resolved_idd_path = resolve_idd_path(idd_path)

    try:
        IDF.setiddname(str(resolved_idd_path))
    except Exception as error:  # pragma: no cover - depends on eppy runtime state
        already_set = 'IDDAlreadySetError' in error.__class__.__name__ or 'IDD file is set' in str(error)
        if not already_set:
            raise

    return str(resolved_idd_path)


def _resolve_expandobjects_executable() -> Path:
    candidates: list[Path] = []

    for env_name in ('ENERGYPLUS_EXE', 'EPLUS_EXE', 'ENERGYPLUS_BIN'):
        env_value = os.getenv(env_name)
        if env_value:
            candidates.append(Path(env_value).expanduser().resolve().parent / 'ExpandObjects.exe')

    for env_name in ('ENERGYPLUS_HOME', 'ENERGYPLUS_ROOT'):
        env_value = os.getenv(env_name)
        if env_value:
            candidates.append(Path(env_value).expanduser() / 'ExpandObjects.exe')

    system_drive = os.getenv('SystemDrive', 'C:')
    try:
        candidates.extend(sorted(Path(f'{system_drive}/').glob('EnergyPlusV*/ExpandObjects.exe'), reverse=True))
    except OSError:
        pass

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()

    raise FileNotFoundError(
        'ExpandObjects.exe was not found. Set `ENERGYPLUS_EXE` or `ENERGYPLUS_HOME`, or install EnergyPlus locally.'
    )


def _template_needs_expandobjects(template_path: Path) -> bool:
    try:
        text = template_path.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return False
    return 'HVACTEMPLATE:' in text.upper()


def _expand_template_objects(template_path: Path, *, idd_path: Path, output_dir: Path) -> Path:
    if not _template_needs_expandobjects(template_path):
        return template_path

    expand_exe = _resolve_expandobjects_executable()
    work_dir = output_dir / f'_expandobjects_{_safe_file_token(template_path.stem)}'
    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(template_path, work_dir / 'in.idf')
    shutil.copy2(idd_path, work_dir / 'Energy+.idd')
    completed = subprocess.run(
        [str(expand_exe)],
        cwd=str(work_dir),
        text=True,
        capture_output=True,
        check=False,
    )
    expanded_path = work_dir / 'expanded.idf'
    if completed.returncode != 0 or not expanded_path.exists():
        raise RuntimeError(
            'ExpandObjects failed for generated IDF template.\n'
            f'stdout:\n{completed.stdout[-4000:]}\n'
            f'stderr:\n{completed.stderr[-4000:]}'
        )
    return expanded_path


@lru_cache(maxsize=4)
def list_available_templates(idf_library_path: str | None = None) -> tuple[Path, list[Path]]:
    library_path = Path(idf_library_path or DEFAULT_IDF_LIBRARY_PATH).resolve()
    if not library_path.exists():
        raise FileNotFoundError(f'IDF template directory not found: {library_path}')

    generated_path = DEFAULT_GENERATED_IDF_LIBRARY_PATH.resolve()
    templates = []
    if generated_path.exists() and (idf_library_path is None or generated_path != library_path):
        templates.extend(sorted(path for path in generated_path.glob('*.idf') if path.is_file()))
    templates.extend(sorted(path for path in library_path.glob('*.idf') if path.is_file()))
    if not templates:
        raise FileNotFoundError(f'No IDF templates were found in: {library_path}')

    return library_path, templates


def resolve_template_for_archetype(archetype: str | None, idf_library_path: str | None = None) -> Path:
    _, templates = list_available_templates(idf_library_path)
    normalized_archetype = _normalize_token(archetype)

    for template in templates:
        if normalized_archetype and _normalize_token(template.stem) == normalized_archetype:
            return template

    keyword = ARCHETYPE_TEMPLATE_KEYWORDS.get(normalized_archetype, normalized_archetype or 'office')
    for template in templates:
        normalized_name = _normalize_token(template.stem)
        if keyword and keyword in normalized_name:
            return template

    for template in templates:
        if 'office' in _normalize_token(template.stem):
            return template

    return templates[0]


def _idf_objects(idf: Any, object_key: str) -> list[Any]:
    try:
        return list(idf.idfobjects[object_key.upper()])
    except Exception:
        return []


def _field_names(idf_object: Any) -> list[str]:
    return list(getattr(idf_object, 'fieldnames', []) or getattr(idf_object, 'objls', []))


def _set_if_present(idf_object: Any, field_name: str, value: Any) -> None:
    if field_name in _field_names(idf_object):
        setattr(idf_object, field_name, value)


def _set_first_present(idf_object: Any, field_names: tuple[str, ...], value: Any) -> str:
    """Set the first matching eppy field name and return the matched name.

    EnergyPlus/eppy field names can differ subtly across versions, especially around
    punctuation.  This helper lets runtime-generated objects support both legacy and
    current normalized names without silently missing required fields.
    """
    available = set(_field_names(idf_object))
    for field_name in field_names:
        if field_name in available:
            setattr(idf_object, field_name, value)
            return field_name
    return ''


def _require_first_present(idf_object: Any, field_names: tuple[str, ...], value: Any, *, object_label: str) -> None:
    matched = _set_first_present(idf_object, field_names, value)
    if not matched:
        available = ', '.join(_field_names(idf_object))
        raise ValueError(f'{object_label}: none of the required fields exist: {field_names}. Available fields: {available}')


def _object_name(idf_object: Any) -> str:
    return str(getattr(idf_object, 'Name', '') or '').strip()


def _copy_object_fields(source: Any, target: Any, skip_fields: set[str] | None = None) -> None:
    skip = {'key'} | (skip_fields or set())
    for field_name in _field_names(source):
        if field_name in skip:
            continue

        try:
            value = getattr(source, field_name)
        except Exception:
            continue

        if value in (None, ''):
            continue

        _set_if_present(target, field_name, value)


def _find_named_template(idf: Any, object_keys: list[str], keywords: tuple[str, ...]) -> str:
    objects: list[Any] = []
    for object_key in object_keys:
        objects.extend(_idf_objects(idf, object_key))

    normalized_keywords = tuple(_normalize_token(item) for item in keywords if item)
    for idf_object in objects:
        name = str(getattr(idf_object, 'Name', '') or '')
        normalized_name = _normalize_token(name)
        if normalized_keywords and any(keyword in normalized_name for keyword in normalized_keywords):
            return name

    for idf_object in objects:
        name = str(getattr(idf_object, 'Name', '') or '')
        if name:
            return name

    return ''


def _schedule_object_keys(idf: Any) -> list[str]:
    try:
        return [
            str(key) for key in idf.idfobjects.keys()
            if str(key).upper().startswith('SCHEDULE')
            and str(key).upper() != 'SCHEDULETYPELIMITS'
        ]
    except Exception:
        return []


def _get_template_defaults(idf: Any) -> dict[str, str]:
    schedule_keys = _schedule_object_keys(idf)
    return {
        'wall_construction_name': _find_named_template(idf, ['CONSTRUCTION'], ('wall', 'exterior', 'facade')),
        'roof_construction_name': _find_named_template(idf, ['CONSTRUCTION'], ('roof', 'ceiling')),
        'floor_construction_name': _find_named_template(idf, ['CONSTRUCTION'], ('floor', 'slab')),
        'window_construction_name': _find_named_template(idf, ['CONSTRUCTION'], ('window', 'glazing', 'glass')),
        'people_schedule_name': _find_named_template(idf, schedule_keys, ('people', 'occup', 'occ')),
        'lights_schedule_name': _find_named_template(idf, schedule_keys, ('light',)),
        'equipment_schedule_name': _find_named_template(idf, schedule_keys, ('equip', 'elec')),
    }


def _capture_zone_templates(idf: Any) -> dict[str, list[Any]]:
    return {object_key: _idf_objects(idf, object_key)[:1] for object_key in ZONE_TEMPLATE_OBJECT_KEYS}


def _remove_idf_objects(idf: Any, object_key: str) -> None:
    for idf_object in list(_idf_objects(idf, object_key)):
        idf.removeidfobject(idf_object)


def _reset_geometry_for_rewrite(idf: Any) -> None:
    for object_key in GEOMETRY_RESET_OBJECT_KEYS:
        _remove_idf_objects(idf, object_key)


def _reset_output_requests(idf: Any) -> None:
    for object_key in OUTPUT_RESET_OBJECT_KEYS:
        _remove_idf_objects(idf, object_key)


def configure_annual_output_requests(idf: Any) -> dict[str, Any]:
    _reset_output_requests(idf)

    table_style = idf.newidfobject('OUTPUTCONTROL:TABLE:STYLE')
    _set_if_present(table_style, 'Column_Separator', 'CommaAndHTML')
    _set_if_present(table_style, 'Unit_Conversion', 'JtoKWH')
    _set_if_present(table_style, 'Digits_After_Decimal', 3)

    sqlite_output = idf.newidfobject('OUTPUT:SQLITE')
    _set_if_present(sqlite_output, 'Option_Type', 'SimpleAndTabular')

    summary_reports = idf.newidfobject('OUTPUT:TABLE:SUMMARYREPORTS')
    _set_if_present(summary_reports, 'Report_1_Name', 'AnnualBuildingUtilityPerformanceSummary')
    _set_if_present(summary_reports, 'Report_2_Name', 'InputVerificationandResultsSummary')

    configured_meters: list[str] = []
    for meter_name in ANNUAL_OUTPUT_METERS:
        meter_output = idf.newidfobject('OUTPUT:METER')
        _set_if_present(meter_output, 'Key_Name', meter_name)
        # RunPeriod is supported in all EnergyPlus versions. 'Annual' was added in
        # EnergyPlus 9.4+ and older installs silently ignore it, leaving the SQL empty.
        # EnergyPlus writes RunPeriod as "Run Period" (with space) in the SQL dictionary.
        _set_if_present(meter_output, 'Reporting_Frequency', 'RunPeriod')
        configured_meters.append(meter_name)

        hourly_meter_output = idf.newidfobject('OUTPUT:METER')
        _set_if_present(hourly_meter_output, 'Key_Name', meter_name)
        _set_if_present(hourly_meter_output, 'Reporting_Frequency', 'Hourly')

    configured_variables: list[str] = []
    for key_value, variable_name in ANNUAL_OUTPUT_VARIABLES:
        variable_output = idf.newidfobject('OUTPUT:VARIABLE')
        _set_if_present(variable_output, 'Key_Value', key_value)
        _set_if_present(variable_output, 'Variable_Name', variable_name)
        _set_if_present(variable_output, 'Reporting_Frequency', 'RunPeriod')
        configured_variables.append(variable_name)

        hourly_variable_output = idf.newidfobject('OUTPUT:VARIABLE')
        _set_if_present(hourly_variable_output, 'Key_Value', key_value)
        _set_if_present(hourly_variable_output, 'Variable_Name', variable_name)
        _set_if_present(hourly_variable_output, 'Reporting_Frequency', 'Hourly')

    return {
        'reporting_frequency': 'RunPeriod + Hourly',
        'summary_reports': [
            'AnnualBuildingUtilityPerformanceSummary',
            'InputVerificationandResultsSummary',
        ],
        'meters': configured_meters,
        'variables': configured_variables,
        'eui_breakdown_notes': {
            'total_eui_kwh_m2': 'Derived from total annual site energy divided by total floor area.',
            'cooling_eui_kwh_m2': 'Derived from Cooling + Fans + Pumps annual energy divided by floor area.',
            'heating_eui_kwh_m2': 'Derived from annual Heating energy divided by floor area.',
            'lighting_eui_kwh_m2': 'Derived from annual InteriorLights energy divided by floor area.',
            'equipment_eui_kwh_m2': 'Derived from annual InteriorEquipment energy divided by floor area.',
            'hot_water_eui_kwh_m2': 'Derived from annual WaterSystems/DistrictHeatingWater meters or DHW output variables divided by floor area.',
        },
        'defined_in_code': True,
        'inherits_template_outputs': False,
    }


def _extract_ring_coordinates(geometry: dict[str, Any], *, z_value: float = 0.0) -> list[list[float]]:
    geometry_type = geometry.get('type')
    coordinates = geometry.get('coordinates') or []

    if geometry_type == 'Polygon' and coordinates:
        ring = coordinates[0]
    elif geometry_type == 'MultiPolygon' and coordinates and coordinates[0]:
        ring = coordinates[0][0]
    else:
        return []

    result: list[list[float]] = []
    for point in ring:
        if len(point) < 2:
            continue
        result.append([float(point[0]), float(point[1]), float(z_value)])
    return result


def _is_closed_ring(vertices: list[list[float]]) -> bool:
    if len(vertices) < 2:
        return False
    return all(abs(vertices[0][index] - vertices[-1][index]) < 1e-9 for index in range(min(3, len(vertices[0]), len(vertices[-1]))))


def _dedupe_closed_ring(vertices: list[list[float]]) -> list[list[float]]:
    return vertices[:-1] if _is_closed_ring(vertices) else vertices


def _resolve_local_origin(target_building: dict[str, Any]) -> tuple[float, float]:
    footprint_ring = _extract_ring_coordinates(target_building.get('footprint') or {})
    if not footprint_ring:
        return 0.0, 0.0

    lon = sum(point[0] for point in footprint_ring) / len(footprint_ring)
    lat = sum(point[1] for point in footprint_ring) / len(footprint_ring)
    return lon, lat


def _project_vertices_to_local_coordinates(
    vertices: list[list[float]],
    *,
    origin_lon: float,
    origin_lat: float,
) -> list[list[float]]:
    local_vertices: list[list[float]] = []
    meters_per_deg_lon = 111320.0 * cos(radians(origin_lat or 0.0))
    meters_per_deg_lat = 110540.0

    for vertex in vertices:
        if len(vertex) < 2:
            continue

        x_value = float(vertex[0])
        y_value = float(vertex[1])
        z_value = float(vertex[2]) if len(vertex) > 2 else 0.0

        if abs(x_value) <= 180 and abs(y_value) <= 90:
            local_x = (x_value - origin_lon) * meters_per_deg_lon
            local_y = (y_value - origin_lat) * meters_per_deg_lat
        else:
            local_x = x_value
            local_y = y_value

        local_vertices.append([round(local_x, 3), round(local_y, 3), round(z_value, 3)])

    return _dedupe_closed_ring(local_vertices)


def _estimate_polygon_area(vertices: list[list[float]]) -> float:
    if len(vertices) < 3:
        return 0.0

    area = 0.0
    for index in range(len(vertices)):
        x1, y1 = vertices[index][0], vertices[index][1]
        x2, y2 = vertices[(index + 1) % len(vertices)][0], vertices[(index + 1) % len(vertices)][1]
        area += x1 * y2 - x2 * y1

    return abs(area) * 0.5


def _surface_defaults(surface_type: str, defaults: dict[str, str], z_min: float) -> dict[str, str]:
    normalized_surface_type = _normalize_token(surface_type)

    if normalized_surface_type == 'roof':
        return {
            'surface_type': 'Roof',
            'construction_name': defaults.get('roof_construction_name') or defaults.get('wall_construction_name') or '',
            'outside_boundary_condition': 'Outdoors',
            'sun_exposure': 'SunExposed',
            'wind_exposure': 'WindExposed',
        }

    if normalized_surface_type == 'floor':
        return {
            'surface_type': 'Floor',
            'construction_name': defaults.get('floor_construction_name') or defaults.get('wall_construction_name') or '',
            'outside_boundary_condition': 'Ground' if z_min <= 0.01 else 'Adiabatic',
            'sun_exposure': 'NoSun',
            'wind_exposure': 'NoWind',
        }

    return {
        'surface_type': 'Wall',
        'construction_name': defaults.get('wall_construction_name') or defaults.get('roof_construction_name') or '',
        'outside_boundary_condition': 'Outdoors',
        'sun_exposure': 'SunExposed',
        'wind_exposure': 'WindExposed',
    }


def _write_vertices(idf_object: Any, vertices: list[list[float]]) -> None:
    _set_if_present(idf_object, 'Number_of_Vertices', len(vertices))
    for index, (x_value, y_value, z_value) in enumerate(vertices, start=1):
        _set_if_present(idf_object, f'Vertex_{index}_Xcoordinate', x_value)
        _set_if_present(idf_object, f'Vertex_{index}_Ycoordinate', y_value)
        _set_if_present(idf_object, f'Vertex_{index}_Zcoordinate', z_value)


def _add_building_surface(
    idf: Any,
    *,
    surface: dict[str, Any],
    zone_name: str,
    local_vertices: list[list[float]],
    defaults: dict[str, str],
    z_min: float,
) -> None:
    config = _surface_defaults(str(surface.get('surface_type', 'wall')), defaults, z_min)
    object_name = str(surface.get('surface_id') or f'{zone_name}:{config["surface_type"].lower()}')

    # OSM/GeoJSON polygon rings arrive in CW order (viewed from above), giving outward
    # normal pointing DOWN (tilt=180).  Floors need DOWN (tilt=180) — keep as-is.
    # Roofs need UP (tilt=0) — reverse to CCW so the normal flips to point up.
    vertices = list(reversed(local_vertices)) if config['surface_type'] == 'Roof' else local_vertices

    idf_surface = idf.newidfobject('BUILDINGSURFACE:DETAILED')
    _set_if_present(idf_surface, 'Name', object_name)
    _set_if_present(idf_surface, 'Surface_Type', config['surface_type'])
    _set_if_present(idf_surface, 'Construction_Name', config['construction_name'])
    _set_if_present(idf_surface, 'Zone_Name', zone_name)
    _set_if_present(idf_surface, 'Space_Name', '')
    _set_if_present(idf_surface, 'Outside_Boundary_Condition', config['outside_boundary_condition'])
    _set_if_present(idf_surface, 'Outside_Boundary_Condition_Object', '')
    _set_if_present(idf_surface, 'Sun_Exposure', config['sun_exposure'])
    _set_if_present(idf_surface, 'Wind_Exposure', config['wind_exposure'])
    _set_if_present(idf_surface, 'View_Factor_to_Ground', 'autocalculate')
    _write_vertices(idf_surface, vertices)


def _first_template(templates: dict[str, list[Any]], object_key: str) -> Any | None:
    objects = templates.get(object_key.upper()) or templates.get(object_key) or []
    return objects[0] if objects else None


def _object_name(idf_object: Any) -> str:
    return str(getattr(idf_object, 'Name', '') or '').strip()


def _write_node_list(idf: Any, *, name: str, node_name: str) -> None:
    node_list = idf.newidfobject('NODELIST')
    _set_if_present(node_list, 'Name', name)
    _set_if_present(node_list, 'Node_1_Name', node_name)


def _clone_design_specification_outdoor_air(
    idf: Any,
    *,
    building_id: str,
    templates: dict[str, list[Any]],
) -> str:
    """Clone template DesignSpecification:OutdoorAir once per generated building.

    Sizing:Zone and IdealLoads objects need a valid DSOA reference.  The template
    may point to a SpaceList DSOA that is deleted during geometry reset, so we
    create a fresh building-scoped DSOA object and make all cloned zone objects
    reference it.
    """
    dsoa_name = f'{building_id}:designspecificationoutdoorair'
    template = _first_template(templates, 'DESIGNSPECIFICATION:OUTDOORAIR')
    if template is None:
        return ''

    dsoa = idf.newidfobject('DESIGNSPECIFICATION:OUTDOORAIR')
    _copy_object_fields(template, dsoa, skip_fields={'Name'})
    _set_if_present(dsoa, 'Name', dsoa_name)
    return dsoa_name


def _clone_template_object_for_zone(
    idf: Any,
    *,
    object_key: str,
    template: Any,
    zone_name: str,
    building_id: str,
    dsoa_name: str,
) -> None:
    """Clone one template object and rewrite only zone-scoped references.

    This preserves archetype-specific schedules, densities, thermostat setpoints,
    outdoor-air methods, humidity control and IdealLoads settings from the IDF
    template.  Only hardcoded old shoebox names/nodes are replaced.
    """
    normalized_key = object_key.upper()
    zone_reference_fields = {
        'Zone_or_ZoneList_Name',
        'Zone_or_ZoneList_or_Space_or_SpaceList_Name',
        'Zone_Name',
    }
    dsoa_reference_fields = {'Design_Specification_Outdoor_Air_Object_Name'}

    # DSOA itself is cloned once per building, not once per zone.
    if normalized_key == 'DESIGNSPECIFICATION:OUTDOORAIR':
        return

    new_object = idf.newidfobject(normalized_key)
    skip_fields = {'Name', *zone_reference_fields, *dsoa_reference_fields}

    if normalized_key == 'ZONEHVAC:IDEALLOADSAIRSYSTEM':
        skip_fields.update({
            'Zone_Supply_Air_Node_Name',
            'Zone_Exhaust_Air_Node_Name',
            'System_Inlet_Air_Node_Name',
            'Outdoor_Air_Inlet_Node_Name',
        })
    elif normalized_key == 'ZONEHVAC:EQUIPMENTLIST':
        skip_fields.update({'Zone_Equipment_1_Name'})

    _copy_object_fields(template, new_object, skip_fields=skip_fields)

    if 'Name' in _field_names(new_object):
        suffix = _normalize_token(normalized_key) or 'object'
        _set_if_present(new_object, 'Name', f'{zone_name}:{suffix}')

    for field_name in zone_reference_fields:
        _set_if_present(new_object, field_name, zone_name)

    for field_name in dsoa_reference_fields:
        _set_if_present(new_object, field_name, dsoa_name)

    if normalized_key == 'ZONECONTROL:HUMIDISTAT':
        # Name is not referenced by IdealLoads; Zone_Name is the binding.
        _set_if_present(new_object, 'Name', f'{zone_name}:humidistat')

    if normalized_key == 'ZONECONTROL:THERMOSTAT':
        _set_if_present(new_object, 'Name', f'{zone_name}:thermostat')
        # Keep template Control Type Schedule and setpoint object names.  These
        # are archetype semantics, not geometry.

    if normalized_key == 'SIZING:ZONE':
        for field_name in ('Zone_or_ZoneList_Name', 'Zone_or_ZoneList_or_Space_or_SpaceList_Name'):
            _set_if_present(new_object, field_name, zone_name)
        if dsoa_name:
            _set_if_present(new_object, 'Design_Specification_Outdoor_Air_Object_Name', dsoa_name)

    if normalized_key == 'ZONEHVAC:IDEALLOADSAIRSYSTEM':
        ideal_loads_name = f'{zone_name}:IdealLoads'
        supply_node = f'{zone_name}:SupplyAir'
        exhaust_node = f'{zone_name}:ExhaustAir'
        _set_if_present(new_object, 'Name', ideal_loads_name)
        _set_if_present(new_object, 'Zone_Supply_Air_Node_Name', supply_node)
        _set_if_present(new_object, 'Zone_Exhaust_Air_Node_Name', exhaust_node)
        _set_if_present(new_object, 'System_Inlet_Air_Node_Name', '')
        _set_if_present(new_object, 'Outdoor_Air_Inlet_Node_Name', '')
        if dsoa_name:
            _set_if_present(new_object, 'Design_Specification_Outdoor_Air_Object_Name', dsoa_name)

    if normalized_key == 'ZONEHVAC:EQUIPMENTLIST':
        equip_list_name = f'{zone_name}:EquipList'
        ideal_loads_name = f'{zone_name}:IdealLoads'
        _set_if_present(new_object, 'Name', equip_list_name)
        _set_if_present(new_object, 'Zone_Equipment_1_Object_Type', 'ZoneHVAC:IdealLoadsAirSystem')
        _set_if_present(new_object, 'Zone_Equipment_1_Name', ideal_loads_name)
        _require_first_present(
            new_object,
            ('Zone_Equipment_1_Cooling_Sequence', 'Zone_Equipment_1_Cooling_Priority'),
            1,
            object_label=equip_list_name,
        )
        _require_first_present(
            new_object,
            (
                'Zone_Equipment_1_Heating_or_No_Load_Sequence',
                'Zone_Equipment_1_Heating_or_NoLoad_Sequence',
                'Zone_Equipment_1_Heating_or_No_Load_Priority',
            ),
            1,
            object_label=equip_list_name,
        )


def _write_zone_hvac_connections_from_template(idf: Any, *, zone_name: str) -> None:
    """Create the per-zone node lists and equipment connection wrapper.

    We preserve the template's IdealLoads object fields, but the connection
    wrapper must use the generated zone/node names.
    """
    equip_list_name = f'{zone_name}:EquipList'
    inlet_list_name = f'{zone_name}:InletNodeList'
    exhaust_list_name = f'{zone_name}:ExhaustNodeList'
    supply_node = f'{zone_name}:SupplyAir'
    exhaust_node = f'{zone_name}:ExhaustAir'
    air_node = f'{zone_name}:AirNode'

    _write_node_list(idf, name=inlet_list_name, node_name=supply_node)
    _write_node_list(idf, name=exhaust_list_name, node_name=exhaust_node)

    equip_conn = idf.newidfobject('ZONEHVAC:EQUIPMENTCONNECTIONS')
    _set_if_present(equip_conn, 'Zone_Name', zone_name)
    _set_if_present(equip_conn, 'Zone_Conditioning_Equipment_List_Name', equip_list_name)
    _set_if_present(equip_conn, 'Zone_Air_Inlet_Node_or_NodeList_Name', inlet_list_name)
    _set_if_present(equip_conn, 'Zone_Air_Exhaust_Node_or_NodeList_Name', exhaust_list_name)
    _set_if_present(equip_conn, 'Zone_Air_Node_Name', air_node)


def _clone_template_objects_for_zone(
    idf: Any,
    *,
    zone_name: str,
    building_id: str,
    templates: dict[str, list[Any]],
    dsoa_name: str,
) -> None:
    """Clone all relevant template zone objects for one generated zone."""
    for object_key in ZONE_TEMPLATE_OBJECT_KEYS:
        if object_key == 'DESIGNSPECIFICATION:OUTDOORAIR':
            continue
        template = _first_template(templates, object_key)
        if template is None:
            continue
        _clone_template_object_for_zone(
            idf,
            object_key=object_key,
            template=template,
            zone_name=zone_name,
            building_id=building_id,
            dsoa_name=dsoa_name,
        )

    # EquipmentConnections is not cloned because it is a pure generated wrapper
    # around per-zone node lists and the cloned EquipmentList.
    _write_zone_hvac_connections_from_template(idf, zone_name=zone_name)

def _add_shading_surface(idf: Any, *, surface_name: str, local_vertices: list[list[float]]) -> None:
    shading_surface = idf.newidfobject('SHADING:BUILDING:DETAILED')
    _set_if_present(shading_surface, 'Name', surface_name)
    _write_vertices(shading_surface, local_vertices)


def _add_fenestration_surface(
    idf: Any,
    *,
    window_surface: dict[str, Any],
    host_surface_name: str,
    local_vertices: list[list[float]],
    defaults: dict[str, str],
) -> None:
    fenestration = idf.newidfobject('FENESTRATIONSURFACE:DETAILED')
    _set_if_present(fenestration, 'Name', str(window_surface.get('surface_id') or f'{host_surface_name}:window'))
    _set_if_present(fenestration, 'Surface_Type', 'Window')
    _set_if_present(fenestration, 'Construction_Name', defaults.get('window_construction_name') or defaults.get('wall_construction_name') or '')
    _set_if_present(fenestration, 'Building_Surface_Name', host_surface_name)
    _set_if_present(fenestration, 'Outside_Boundary_Condition_Object', '')
    _set_if_present(fenestration, 'View_Factor_to_Ground', 'autocalculate')
    _set_if_present(fenestration, 'Frame_and_Divider_Name', '')
    _set_if_present(fenestration, 'Multiplier', 1.0)
    _write_vertices(fenestration, local_vertices)


def _build_zone_list(idf: Any, zone_list_name: str, zone_names: list[str]) -> None:
    zone_list = idf.newidfobject('ZONELIST')
    _set_if_present(zone_list, 'Name', zone_list_name)
    for index, zone_name in enumerate(zone_names, start=1):
        _set_if_present(zone_list, f'Zone_{index}_Name', zone_name)


def _clone_template_loads(idf: Any, *, zone_list_name: str, building_id: str, templates: dict[str, list[Any]]) -> None:
    """Deprecated compatibility hook.

    Earlier versions cloned loads/sizing once to a ZoneList.  That was fragile
    because many templates contain zone-level HVAC/control objects that must be
    rebound per generated zone.  v10 clones zone-dependent objects per zone in
    _clone_template_objects_for_zone(), and clones DesignSpecification:OutdoorAir
    once per building before the zone loop.
    """
    return None


def _write_target_building_geometry(
    idf: Any,
    *,
    building: dict[str, Any],
    defaults: dict[str, str],
    templates: dict[str, list[Any]],
) -> dict[str, Any]:
    building_id = str(building.get('building_id', 'target'))
    origin_lon, origin_lat = _resolve_local_origin(building)
    zone_names: list[str] = []
    surface_count = 0
    window_surface_count = 0
    gross_floor_area_m2 = 0.0
    building_dsoa_name = _clone_design_specification_outdoor_air(
        idf,
        building_id=building_id,
        templates=templates,
    )

    for floor in building.get('floors', []):
        z_min = float(floor.get('z_min', 0.0) or 0.0)
        z_max = float(floor.get('z_max', z_min + 3.0) or (z_min + 3.0))
        for zone in floor.get('zones', []):
            zone_name = str(zone.get('zone_id') or f'{building_id}:zone')
            zone_names.append(zone_name)

            footprint_vertices = _project_vertices_to_local_coordinates(
                _extract_ring_coordinates(zone.get('footprint') or {}, z_value=z_min),
                origin_lon=origin_lon,
                origin_lat=origin_lat,
            )
            floor_area = round(_estimate_polygon_area(footprint_vertices), 3)
            gross_floor_area_m2 += floor_area
            ceiling_height = round(max(0.1, z_max - z_min), 3)
            volume = round(max(floor_area * ceiling_height, 0.1), 3)

            zone_object = idf.newidfobject('ZONE')
            _set_if_present(zone_object, 'Name', zone_name)
            _set_if_present(zone_object, 'Direction_of_Relative_North', 0.0)
            _set_if_present(zone_object, 'X_Origin', 0.0)
            _set_if_present(zone_object, 'Y_Origin', 0.0)
            _set_if_present(zone_object, 'Z_Origin', z_min)
            _set_if_present(zone_object, 'Type', 1)
            _set_if_present(zone_object, 'Multiplier', 1)
            _set_if_present(zone_object, 'Ceiling_Height', ceiling_height)
            _set_if_present(zone_object, 'Volume', volume)
            _set_if_present(zone_object, 'Floor_Area', floor_area)
            _set_if_present(zone_object, 'Part_of_Total_Floor_Area', 'Yes')

            _clone_template_objects_for_zone(
                idf,
                zone_name=zone_name,
                building_id=building_id,
                templates=templates,
                dsoa_name=building_dsoa_name,
            )

            for surface in zone.get('surfaces', []):
                local_vertices = _project_vertices_to_local_coordinates(
                    surface.get('vertices', []),
                    origin_lon=origin_lon,
                    origin_lat=origin_lat,
                )
                if len(local_vertices) < 3:
                    continue

                _add_building_surface(
                    idf,
                    surface=surface,
                    zone_name=zone_name,
                    local_vertices=local_vertices,
                    defaults=defaults,
                    z_min=z_min,
                )
                surface_count += 1

            window_surfaces = zone.get('window_surfaces') or build_window_geometry(
                zone.get('surfaces', []),
                archetype=building.get('archetype'),
            )
            for window_surface in window_surfaces:
                host_surface_name = str(window_surface.get('host_surface_id') or '')
                local_vertices = _project_vertices_to_local_coordinates(
                    window_surface.get('vertices', []),
                    origin_lon=origin_lon,
                    origin_lat=origin_lat,
                )
                if not host_surface_name or len(local_vertices) < 3:
                    continue

                _add_fenestration_surface(
                    idf,
                    window_surface=window_surface,
                    host_surface_name=host_surface_name,
                    local_vertices=local_vertices,
                    defaults=defaults,
                )
                window_surface_count += 1

    zone_list_name = f'{building_id}:ZoneList'
    if zone_names:
        _build_zone_list(idf, zone_list_name, zone_names)
        _clone_template_loads(idf, zone_list_name=zone_list_name, building_id=building_id, templates=templates)

    return {
        'building_id': building_id,
        'zone_list_name': zone_list_name,
        'zone_names': zone_names,
        'surface_count': surface_count,
        'window_surface_count': window_surface_count,
        'gross_floor_area_m2': round(gross_floor_area_m2, 3),
        'origin_lon_lat': [round(origin_lon, 8), round(origin_lat, 8)],
    }



def _height_from_shading_building(shading_building: dict[str, Any], fallback: float = 3.0) -> float:
    """Return a robust positive height for a context shading building."""
    try:
        height = float(shading_building.get('height_m') or 0.0)
    except (TypeError, ValueError):
        height = 0.0

    if height > 0:
        return round(height, 3)

    max_z = 0.0
    for surface in shading_building.get('surfaces', []) or []:
        for vertex in surface.get('vertices', []) or []:
            if len(vertex) >= 3:
                try:
                    max_z = max(max_z, float(vertex[2]))
                except (TypeError, ValueError):
                    continue

    return round(max(max_z, fallback), 3)


def _collect_context_footprint_vertices(
    shading_building: dict[str, Any],
    *,
    origin_lon: float,
    origin_lat: float,
) -> list[list[float]]:
    """Collect projected XY footprint vertices for one context shading building."""
    footprint_vertices = _project_vertices_to_local_coordinates(
        _extract_ring_coordinates(shading_building.get('footprint') or {}, z_value=0.0),
        origin_lon=origin_lon,
        origin_lat=origin_lat,
    )
    if len(footprint_vertices) >= 3:
        return footprint_vertices

    vertices: list[list[float]] = []
    for surface in shading_building.get('surfaces', []) or []:
        vertices.extend(_project_vertices_to_local_coordinates(
            surface.get('vertices', []) or [],
            origin_lon=origin_lon,
            origin_lat=origin_lat,
        ))

    seen: set[tuple[float, float]] = set()
    unique: list[list[float]] = []
    for vertex in vertices:
        if len(vertex) < 2:
            continue
        key = (round(float(vertex[0]), 6), round(float(vertex[1]), 6))
        if key in seen:
            continue
        seen.add(key)
        unique.append([float(vertex[0]), float(vertex[1]), 0.0])
    return unique


def _context_shading_bbox_walls(
    shading_building: dict[str, Any],
    *,
    origin_lon: float,
    origin_lat: float,
) -> list[tuple[str, list[list[float]]]]:
    """Simplify a context building to four convex vertical bbox wall shades.

    Context buildings are only solar obstructions. Four opaque bounding-box walls
    are much more stable for EnergyPlus shadowing than arbitrary OSM polygons,
    which may include concave roofs, sliver edges, duplicate points or invalid rings.
    """
    footprint_vertices = _collect_context_footprint_vertices(
        shading_building,
        origin_lon=origin_lon,
        origin_lat=origin_lat,
    )
    if len(footprint_vertices) < 3:
        return []

    xs = [float(vertex[0]) for vertex in footprint_vertices]
    ys = [float(vertex[1]) for vertex in footprint_vertices]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    if max_x - min_x < 0.01 or max_y - min_y < 0.01:
        return []

    height = _height_from_shading_building(shading_building, fallback=3.0)
    if height <= 0:
        return []

    building_id = _safe_file_token(shading_building.get('building_id') or 'context')
    z0 = 0.0
    z1 = height

    return [
        (f'{building_id}:bbox_shade:south', [[min_x, min_y, z0], [max_x, min_y, z0], [max_x, min_y, z1], [min_x, min_y, z1]]),
        (f'{building_id}:bbox_shade:east',  [[max_x, min_y, z0], [max_x, max_y, z0], [max_x, max_y, z1], [max_x, min_y, z1]]),
        (f'{building_id}:bbox_shade:north', [[max_x, max_y, z0], [min_x, max_y, z0], [min_x, max_y, z1], [max_x, max_y, z1]]),
        (f'{building_id}:bbox_shade:west',  [[min_x, max_y, z0], [min_x, min_y, z0], [min_x, min_y, z1], [min_x, max_y, z1]]),
    ]

def _write_context_shading_geometry(
    idf: Any,
    *,
    shading_geometry: dict[str, Any],
    origin_lon: float,
    origin_lat: float,
) -> int:
    """Write robust context shading as simplified opaque bbox walls.

    The source geometry may contain non-convex polygons from OSM/GeoJSON. Passing
    those directly to Shading:Building:Detailed can fail in EnergyPlus's
    DetermineShadow phase. Context buildings are not simulated for energy, so a
    conservative convex bounding-box representation is preferred for stability.
    """
    surface_count = 0
    simplified_building_count = 0
    skipped_building_count = 0
    seen_surface_names: set[str] = set()

    for shading_building in shading_geometry.get('shading_buildings', []):
        bbox_walls = _context_shading_bbox_walls(
            shading_building,
            origin_lon=origin_lon,
            origin_lat=origin_lat,
        )
        if not bbox_walls:
            skipped_building_count += 1
            continue

        simplified_building_count += 1
        for surface_name, local_vertices in bbox_walls:
            if surface_name in seen_surface_names:
                continue
            seen_surface_names.add(surface_name)
            _add_shading_surface(
                idf,
                surface_name=surface_name,
                local_vertices=local_vertices,
            )
            surface_count += 1

    _dbg(
        f'context shading simplified: buildings={simplified_building_count} '
        f'surfaces={surface_count} skipped={skipped_building_count} mode=bbox_walls'
    )
    return surface_count


def _dedupe_shading_buildings_for_target(
    *,
    target_building_id: str,
    context_buildings: list[Any],
    neighbor_buildings: list[Any],
) -> list[Any]:
    """Return per-target shading buildings with no self-shading or duplicate IDs."""
    target_id = str(target_building_id)
    deduped: list[Any] = []
    seen_ids: set[str] = {target_id}

    # Other selected targets are preferred over context copies of the same ID.
    for group in (neighbor_buildings, context_buildings):
        for shading_building in group:
            building_id = str((shading_building or {}).get('building_id', ''))
            if not building_id or building_id in seen_ids:
                continue
            deduped.append(shading_building)
            seen_ids.add(building_id)

    return deduped


def _template_conditioned_floor_area(idf: Any) -> float:
    """Estimate the original template floor area before geometry reset.

    Used only to scale service hot-water peak flow after replacing the template
    shoebox geometry with generated geometry. If the template has no explicit
    zone areas, return 0 and skip scaling.
    """
    total = 0.0
    for zone in _idf_objects(idf, 'ZONE'):
        try:
            area = float(getattr(zone, 'Floor_Area', 0) or 0)
        except (TypeError, ValueError):
            area = 0.0
        if area > 0:
            total += area
    return total


def _ensure_constant_schedule(idf: Any, *, name: str, schedule_type_limits: str, value: float) -> None:
    existing_names = {
        str(getattr(obj, 'Name', '') or '').strip()
        for key in _schedule_object_keys(idf)
        for obj in _idf_objects(idf, key)
    }
    if name in existing_names:
        return
    schedule = idf.newidfobject('SCHEDULE:CONSTANT')
    _set_if_present(schedule, 'Name', name)
    _set_if_present(schedule, 'Schedule_Type_Limits_Name', schedule_type_limits)
    _set_if_present(schedule, 'Hourly_Value', value)


def _update_wateruse_zone_assignments(
    idf: Any,
    zone_names: list[str],
    *,
    target_gfa_m2: float = 0.0,
    template_gfa_m2: float = 0.0,
) -> None:
    """Rebind and scale template SHW equipment for generated geometry.

    The template HDB IDF has a full service-hot-water plant loop and five
    WaterUse:Equipment objects connected through WaterUse:Connections.  We keep
    that plant-loop topology intact, but retarget those equipment objects to the
    generated zones and scale their peak flow by target GFA/template GFA.

    Also split the target temperature schedule from the hot-water supply schedule.
    The template uses 60C for both, which can produce hundreds of thousands of
    floating-point warnings such as target=60.00C being greater than supply=60.00C
    by ~7e-15.  A 59.9C target removes that noise without materially changing DHW.
    """
    if not zone_names:
        return

    water_use_equipment = _idf_objects(idf, 'WATERUSE:EQUIPMENT')
    water_use_connections = _idf_objects(idf, 'WATERUSE:CONNECTIONS')
    water_heaters = _idf_objects(idf, 'WATERHEATER:MIXED') + _idf_objects(idf, 'WATERHEATER:STRATIFIED')
    if not water_use_equipment:
        _dbg('DHW rebinding skipped: no WaterUse:Equipment objects in selected template')
        return

    # Remove numerical-noise warning: target hot-water temp must be <= supply temp.
    target_schedule_name = 'DHW Target 59.9C'
    _ensure_constant_schedule(
        idf,
        name=target_schedule_name,
        schedule_type_limits='Temperature',
        value=59.9,
    )

    scale = 1.0
    if target_gfa_m2 > 0 and template_gfa_m2 > 0:
        # Clamp only to avoid absurd geometry/template mismatch explosions.
        scale = max(0.05, min(target_gfa_m2 / template_gfa_m2, 100.0))

    for index, wu_equip in enumerate(water_use_equipment):
        _set_if_present(wu_equip, 'Zone_Name', zone_names[index % len(zone_names)])
        _set_if_present(wu_equip, 'Target_Temperature_Schedule_Name', target_schedule_name)

        if 'Peak_Flow_Rate' in _field_names(wu_equip):
            raw_peak = getattr(wu_equip, 'Peak_Flow_Rate', None)
            try:
                peak = float(raw_peak)
            except (TypeError, ValueError):
                peak = 0.0
            if peak > 0 and scale != 1.0:
                setattr(wu_equip, 'Peak_Flow_Rate', peak * scale)

    _dbg(
        f'DHW rebinding: wateruse_equipment={len(water_use_equipment)} '
        f'wateruse_connections={len(water_use_connections)} water_heaters={len(water_heaters)} '
        f'template_gfa={template_gfa_m2:.2f} target_gfa={target_gfa_m2:.2f} scale={scale:.3f}'
    )


def _update_site_location(idf: Any, *, lon: float, lat: float) -> None:
    # Singapore: UTC+8 regardless of exact longitude (103.8° → lon/15 ≈ 6.9 which rounds to 7,
    # but the standard time zone for the whole island is UTC+8).
    timezone = 8
    elevation = 15.0
    locations = _idf_objects(idf, 'SITE:LOCATION')
    if locations:
        site = locations[0]
    else:
        site = idf.newidfobject('SITE:LOCATION')
        _set_if_present(site, 'Name', 'Site 1')
    _set_if_present(site, 'Latitude', round(lat, 6))
    _set_if_present(site, 'Longitude', round(lon, 6))
    _set_if_present(site, 'Time_Zone', timezone)
    _set_if_present(site, 'Elevation', elevation)


def _use_robust_solar_distribution(idf: Any) -> None:
    """Use exterior-only solar distribution for generated GIS geometry."""
    buildings = _idf_objects(idf, 'BUILDING')
    if not buildings:
        building = idf.newidfobject('BUILDING')
        _set_if_present(building, 'Name', 'Generated Building')
        buildings = [building]

    for building in buildings:
        _set_if_present(building, 'Solar_Distribution', 'FullExterior')


def _ensure_schedule_type_limits(idf: Any) -> None:
    """Create the ScheduleTypeLimits used by runtime-generated schedules.

    These are metadata objects.  They are not schedules themselves, but if a
    Schedule:Constant references a missing type-limit name, EnergyPlus can fail or
    emit confusing validation messages.  Creating them here keeps the generated
    IDF self-contained regardless of template cleanliness.
    """
    existing = {
        _normalize_token(getattr(obj, 'Name', '') or '')
        for obj in _idf_objects(idf, 'SCHEDULETYPELIMITS')
    }

    definitions = [
        ('Temperature', None, None, 'Continuous', 'Temperature'),
        ('Fraction', 0.0, 1.0, 'Continuous', 'Dimensionless'),
        ('Any Number', None, None, 'Continuous', 'ActivityLevel'),
        ('Control Type', 0, 4, 'Discrete', ''),
    ]

    for name, lower, upper, numeric_type, unit_type in definitions:
        if _normalize_token(name) in existing:
            continue
        limits = idf.newidfobject('SCHEDULETYPELIMITS')
        _set_if_present(limits, 'Name', name)
        if lower is not None:
            _set_if_present(limits, 'Lower_Limit_Value', lower)
        if upper is not None:
            _set_if_present(limits, 'Upper_Limit_Value', upper)
        _set_if_present(limits, 'Numeric_Type', numeric_type)
        
        # Unit_Type is optional. Do not write non-EnergyPlus enum values such as
        # 'ControlMode'; EnergyPlus 24.2 rejects them during IDF parsing.
        if unit_type:
            _set_if_present(limits, 'Unit_Type', unit_type)


def _ensure_constant_schedule(idf: Any, *, name: str, schedule_type_limits: str, value: float) -> None:
    existing = {
        _normalize_token(getattr(obj, 'Name', '') or '')
        for key in _schedule_object_keys(idf)
        for obj in _idf_objects(idf, key)
    }
    if _normalize_token(name) in existing:
        return

    sched = idf.newidfobject('SCHEDULE:CONSTANT')
    _set_if_present(sched, 'Name', name)
    _set_if_present(sched, 'Schedule_Type_Limits_Name', schedule_type_limits)
    _require_first_present(
        sched,
        ('Hourly_Value', 'Schedule_Value'),
        value,
        object_label=f'Schedule:Constant {name}',
    )


def _ensure_setpoint_schedules(idf: Any) -> None:
    """Create constant schedules required by generated thermostats and People."""
    _ensure_schedule_type_limits(idf)

    # Robust defaults for a tropical Singapore baseline model.  Cooling is set
    # low enough to force non-zero cooling load during design sizing; this avoids
    # IdealLoads/PurchasedAir initialization edge-cases where every zone has zero
    # load and EnergyPlus exits with a generic InitPurchasedAir Fatal.
    _ensure_constant_schedule(idf, name='HeatingSetpointSchedule', schedule_type_limits='Temperature', value=18.0)
    _ensure_constant_schedule(idf, name='CoolingSetpointSchedule', schedule_type_limits='Temperature', value=22.0)
    _ensure_constant_schedule(idf, name='Always On', schedule_type_limits='Fraction', value=1.0)

    # People requires Activity Level Schedule Name.  120 W/person is a standard
    # sedentary/light activity assumption and prevents the immediate fatal seen in
    # EnergyPlus 24.2 when this required field is blank.
    _ensure_constant_schedule(idf, name='ActivityLevelSchedule', schedule_type_limits='Any Number', value=120.0)

    # ZoneControl:Thermostat's control-type schedule must return an integer matching
    # the active setpoint type: 4 = DualSetpoint.  "Always On" returns 1.0, which
    # EnergyPlus interprets as SingleHeating and can produce zero cooling load.
    _ensure_constant_schedule(idf, name='ThermostatCtrlDual', schedule_type_limits='Control Type', value=4)

def _write_zone_thermostat(idf: Any, *, zone_name: str) -> None:
    """Write a ThermostatSetpoint:DualSetpoint and ZoneControl:Thermostat for one zone."""
    dual_sp_name = f'{zone_name}:dualsetpoint'

    dual_sp = idf.newidfobject('THERMOSTATSETPOINT:DUALSETPOINT')
    _set_if_present(dual_sp, 'Name', dual_sp_name)
    _set_if_present(dual_sp, 'Heating_Setpoint_Temperature_Schedule_Name', 'HeatingSetpointSchedule')
    _set_if_present(dual_sp, 'Cooling_Setpoint_Temperature_Schedule_Name', 'CoolingSetpointSchedule')

    thermostat = idf.newidfobject('ZONECONTROL:THERMOSTAT')
    _set_if_present(thermostat, 'Name', f'{zone_name}:thermostat')
    # Support both old (pre-24.2) and new field naming; _set_if_present ignores missing fields.
    _set_if_present(thermostat, 'Zone_or_ZoneList_Name', zone_name)
    _set_if_present(thermostat, 'Zone_or_ZoneList_or_Space_or_SpaceList_Name', zone_name)
    _set_if_present(thermostat, 'Control_Type_Schedule_Name', 'ThermostatCtrlDual')
    _set_if_present(thermostat, 'Control_1_Object_Type', 'ThermostatSetpoint:DualSetpoint')
    _set_if_present(thermostat, 'Control_1_Name', dual_sp_name)


def _write_zone_people(idf: Any, *, zone_name: str, people_per_area: float = 0.05) -> None:
    """Write a complete People object for one zone.

    EnergyPlus 24.2 requires Activity Level Schedule Name.  Several other fields
    have defaults in some IDDs but are set explicitly here so batch-generated IDFs
    remain stable across templates and EnergyPlus versions.
    """
    people_name = f'{zone_name}:people'
    people = idf.newidfobject('PEOPLE')
    _set_if_present(people, 'Name', people_name)
    _require_first_present(
        people,
        ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'),
        zone_name,
        object_label=people_name,
    )
    _require_first_present(
        people,
        ('Number_of_People_Schedule_Name',),
        'Always On',
        object_label=people_name,
    )
    _require_first_present(
        people,
        ('Number_of_People_Calculation_Method',),
        'People/Area',
        object_label=people_name,
    )
    _require_first_present(
        people,
        ('People_per_Zone_Floor_Area', 'People_per_Floor_Area'),
        people_per_area,
        object_label=people_name,
    )
    _require_first_present(
        people,
        ('Activity_Level_Schedule_Name',),
        'ActivityLevelSchedule',
        object_label=people_name,
    )

    # Explicit but non-fatal fields.  These improve physical plausibility and avoid
    # relying on IDD/template defaults.
    _set_if_present(people, 'Fraction_Radiant', 0.3)
    _set_if_present(people, 'Sensible_Heat_Fraction', 'autocalculate')
    _set_if_present(people, 'Carbon_Dioxide_Generation_Rate', 3.82e-8)
    _set_if_present(people, 'Enable_ASHRAE_55_Comfort_Warnings', 'No')


def _write_zone_lights(idf: Any, *, zone_name: str, watts_per_area: float = 10.0) -> None:
    """Write a deterministic Lights object for one zone.

    Lights are the most reliable way to guarantee a non-zero sensible cooling load
    in every generated zone, independent of occupancy interpretation, outdoor air,
    or template-specific schedules.
    """
    lights_name = f'{zone_name}:lights'
    lights = idf.newidfobject('LIGHTS')
    _set_if_present(lights, 'Name', lights_name)
    _require_first_present(
        lights,
        ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'),
        zone_name,
        object_label=lights_name,
    )
    _require_first_present(
        lights,
        ('Schedule_Name',),
        'Always On',
        object_label=lights_name,
    )
    _require_first_present(
        lights,
        ('Design_Level_Calculation_Method',),
        'Watts/Area',
        object_label=lights_name,
    )
    _require_first_present(
        lights,
        ('Watts_per_Zone_Floor_Area', 'Watts_per_Floor_Area'),
        watts_per_area,
        object_label=lights_name,
    )
    _set_if_present(lights, 'Return_Air_Fraction', 0.0)
    _set_if_present(lights, 'Fraction_Radiant', 0.6)
    _set_if_present(lights, 'Fraction_Visible', 0.2)
    _set_if_present(lights, 'Fraction_Replaceable', 1.0)
    _set_if_present(lights, 'EndUse_Subcategory', 'GeneralLights')


def _write_zone_electric_equipment(idf: Any, *, zone_name: str, watts_per_area: float = 8.0) -> None:
    """Write deterministic plug/process load for one zone."""
    equip_name = f'{zone_name}:equipment'
    equipment = idf.newidfobject('ELECTRICEQUIPMENT')
    _set_if_present(equipment, 'Name', equip_name)
    _require_first_present(
        equipment,
        ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'),
        zone_name,
        object_label=equip_name,
    )
    _require_first_present(
        equipment,
        ('Schedule_Name',),
        'Always On',
        object_label=equip_name,
    )
    _require_first_present(
        equipment,
        ('Design_Level_Calculation_Method',),
        'Watts/Area',
        object_label=equip_name,
    )
    _require_first_present(
        equipment,
        ('Watts_per_Zone_Floor_Area', 'Watts_per_Floor_Area'),
        watts_per_area,
        object_label=equip_name,
    )
    _set_if_present(equipment, 'Fraction_Latent', 0.0)
    _set_if_present(equipment, 'Fraction_Radiant', 0.5)
    _set_if_present(equipment, 'Fraction_Lost', 0.0)
    _set_if_present(equipment, 'EndUse_Subcategory', 'GeneralEquipment')


def _validate_generated_idf(idf: Any, *, zone_names: list[str]) -> None:
    """Fail fast on common generated-IDF errors before launching EnergyPlus."""
    if not zone_names:
        raise ValueError('No zones were generated for the target building.')

    zone_set = set(zone_names)
    people_objects = _idf_objects(idf, 'PEOPLE')
    lights_objects = _idf_objects(idf, 'LIGHTS')
    electric_equipment_objects = _idf_objects(idf, 'ELECTRICEQUIPMENT')
    thermostats = _idf_objects(idf, 'ZONECONTROL:THERMOSTAT')
    dual_setpoints = _idf_objects(idf, 'THERMOSTATSETPOINT:DUALSETPOINT')
    equip_conns = _idf_objects(idf, 'ZONEHVAC:EQUIPMENTCONNECTIONS')

    def _field_value(obj: Any, names: tuple[str, ...]) -> str:
        for name in names:
            if name in _field_names(obj):
                return str(getattr(obj, name, '') or '').strip()
        return ''

    people_by_zone = {
        _field_value(obj, ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'))
        for obj in people_objects
    }
    lights_by_zone = {
        _field_value(obj, ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'))
        for obj in lights_objects
    }
    equipment_by_zone = {
        _field_value(obj, ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'))
        for obj in electric_equipment_objects
    }
    thermostat_by_zone = {
        _field_value(obj, ('Zone_or_ZoneList_or_Space_or_SpaceList_Name', 'Zone_or_ZoneList_Name'))
        for obj in thermostats
    }
    equip_conn_by_zone = {
        _field_value(obj, ('Zone_Name',))
        for obj in equip_conns
    }

    missing_people = sorted(zone_set - people_by_zone)
    missing_thermostats = sorted(zone_set - thermostat_by_zone)
    missing_hvac = sorted(zone_set - equip_conn_by_zone)
    if missing_people or missing_thermostats or missing_hvac:
        raise ValueError(
            'Generated IDF missing per-zone objects: '
            f'people={missing_people[:5]}, thermostats={missing_thermostats[:5]}, hvac={missing_hvac[:5]}'
        )

    for people in people_objects:
        people_name = _object_name(people)
        if not _field_value(people, ('Activity_Level_Schedule_Name',)):
            raise ValueError(f'People object missing Activity_Level_Schedule_Name: {people_name}')
        if not _field_value(people, ('Number_of_People_Schedule_Name',)):
            raise ValueError(f'People object missing Number_of_People_Schedule_Name: {people_name}')

    # Thermostat setpoint objects are archetype-level template objects and may be
    # shared by all zones (for example HDB uses one "HDB Setpoint" object).  Do
    # not require one setpoint per zone; only ensure each thermostat references a
    # non-empty control object name.
    for thermostat in thermostats:
        thermostat_name = _object_name(thermostat)
        if not _field_value(thermostat, ('Control_1_Object_Type',)):
            raise ValueError(f'Thermostat missing Control_1_Object_Type: {thermostat_name}')
        if not _field_value(thermostat, ('Control_1_Name',)):
            raise ValueError(f'Thermostat missing Control_1_Name: {thermostat_name}')

def write_prepared_idf(
    *,
    template_path: str | Path,
    output_path: str | Path,
    target_building: dict[str, Any],
    shading_geometry: dict[str, Any],
    epw_path: str | None = None,
    idd_path: str | None = None,
) -> dict[str, Any]:
    IDF = _get_idf_class()
    resolved_idd_path = configure_eppy_environment(idd_path)
    resolved_epw_path = resolve_epw_path(epw_path)
    output_file = Path(output_path).resolve()
    output_file.parent.mkdir(parents=True, exist_ok=True)
    source_template_path = Path(template_path).resolve()
    prepared_template_path = _expand_template_objects(
        source_template_path,
        idd_path=Path(resolved_idd_path),
        output_dir=output_file.parent,
    )

    idf = IDF(str(prepared_template_path), str(resolved_epw_path))
    defaults = _get_template_defaults(idf)
    templates = _capture_zone_templates(idf)
    template_gfa_m2 = _template_conditioned_floor_area(idf)
    _reset_geometry_for_rewrite(idf)
    _ensure_setpoint_schedules(idf)
    _use_robust_solar_distribution(idf)
    output_requests = configure_annual_output_requests(idf)

    target_metadata = _write_target_building_geometry(
        idf,
        building=target_building,
        defaults=defaults,
        templates=templates,
    )

    origin_lon, origin_lat = target_metadata['origin_lon_lat']

    # Update Site:Location so EnergyPlus uses the correct coordinates for solar/thermal calcs.
    # The template ships with placeholder 0,0,0 coords; overwrite with the building centroid.
    if origin_lon != 0.0 or origin_lat != 0.0:
        _update_site_location(idf, lon=origin_lon, lat=origin_lat)

    # Template WaterUse:Equipment objects reference old template zone names that were deleted
    # during geometry reset.  Re-assign them to the new building zones so EnergyPlus can find
    # them during sizing (otherwise one Severe Error is raised per orphaned equipment object).
    _update_wateruse_zone_assignments(
        idf,
        target_metadata['zone_names'],
        target_gfa_m2=float(target_metadata.get('gross_floor_area_m2') or 0.0),
        template_gfa_m2=template_gfa_m2,
    )

    shading_surface_count = _write_context_shading_geometry(
        idf,
        shading_geometry=shading_geometry,
        origin_lon=origin_lon,
        origin_lat=origin_lat,
    )

    _validate_generated_idf(idf, zone_names=target_metadata['zone_names'])

    idf.saveas(str(output_file))

    return {
        'idf_path': str(output_file),
        'template_path': str(source_template_path),
        'prepared_template_path': str(prepared_template_path),
        'idd_path': resolved_idd_path,
        'epw_path': str(resolved_epw_path),
        'zone_list_name': target_metadata['zone_list_name'],
        'zone_names': target_metadata['zone_names'],
        'template_defaults': defaults,
        'output_requests': output_requests,
        'target_surface_count': target_metadata['surface_count'],
        'window_surface_count': target_metadata['window_surface_count'],
        'gross_floor_area_m2': target_metadata['gross_floor_area_m2'],
        'template_gross_floor_area_m2': round(template_gfa_m2, 3),
        'shading_surface_count': shading_surface_count,
        'ready_for_runner': True,
    }


def summarize_idf_plan(
    *,
    job_id: str,
    target_geometry: dict[str, Any],
    shading_geometry: dict[str, Any],
    building_details: list[Any] | None = None,
    idf_library_path: str | None = None,
) -> dict[str, Any]:
    library_path, _ = list_available_templates(idf_library_path)
    detail_index = _build_detail_index(building_details)
    bundles: list[dict[str, Any]] = []

    for building in target_geometry.get('buildings', []):
        building_id = str(building.get('building_id', ''))
        detail = detail_index.get(building_id)
        archetype = str(_detail_value(detail, 'archetype', 'office') or 'office')
        template_path = resolve_template_for_archetype(archetype, str(library_path))
        bundles.append({
            'building_id': building_id,
            'archetype': archetype,
            'template_name': template_path.name,
            'target_surface_count': building.get('surface_count', 0),
            'target_zone_count': building.get('zone_count', 0),
            'target_window_count': building.get('window_count', 0),
        })

    return {
        'job_id': job_id,
        'idf_library_path': str(library_path),
        'bundle_count': len(bundles),
        'templates_used': sorted({item['template_name'] for item in bundles}),
        'building_ids': [item['building_id'] for item in bundles],
        'total_target_surfaces': target_geometry.get('surface_count', 0),
        'total_shading_surfaces': shading_geometry.get('surface_count', 0),
        'temp_file_strategy': 'TemporaryDirectory per target building; auto-cleaned after the simulation worker exits; safe for parallel jobs.',
        'output_strategy': 'Annual-only Output:SQLite + Output:Table:SummaryReports + annual Output:Meter requests are defined in code and do not inherit template outputs.',
        'runner_interface': 'app.eppy_runner.run_idf_batch(payload)',
        'bundles': bundles,
    }


def build_eppy_runner_request(
    *,
    job_id: str,
    runtime_bundles: list[dict[str, Any]],
    epw_path: str | None = None,
    keep_temporary: bool = False,
) -> dict[str, Any]:
    resolved_epw_path = str(resolve_epw_path(epw_path))

    return {
        'job_id': job_id,
        'runner_module': 'app.eppy_runner',
        'runner_function': 'run_idf_batch',
        'epw_path': resolved_epw_path,
        'run_count': len(runtime_bundles),
        'runs': [
            {
                'job_id': job_id,
                'building_id': bundle['building_id'],
                'archetype': bundle['archetype'],
                'template_name': bundle['template_name'],
                'idf_path': bundle['idf_path'],
                'geometry_json_path': bundle['geometry_json_path'],
                'output_dir': bundle['output_dir'],
                'epw_path': bundle.get('epw_path', resolved_epw_path),
                'gross_floor_area_m2': bundle.get('gross_floor_area_m2'),
                'keep_temporary': keep_temporary,
                'ready_for_execution': bool(bundle.get('eppy_prepared')),
            }
            for bundle in runtime_bundles
        ],
    }


def submit_to_eppy_runner(
    *,
    job_id: str,
    runtime_bundles: list[dict[str, Any]],
    runner: Callable[[dict[str, Any]], Any] | None = None,
    epw_path: str | None = None,
    keep_temporary: bool = False,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> Any:
    runner_request = build_eppy_runner_request(
        job_id=job_id,
        runtime_bundles=runtime_bundles,
        epw_path=epw_path,
        keep_temporary=keep_temporary,
    )

    if callable(runner):
        return runner(runner_request, on_progress=on_progress)

    return runner_request


@contextmanager
def prepare_temporary_idf_batch(
    *,
    job_id: str,
    target_geometry: dict[str, Any],
    shading_geometry: dict[str, Any],
    building_details: list[Any] | None = None,
    idf_library_path: str | None = None,
    epw_path: str | None = None,
    idd_path: str | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> Iterator[dict[str, Any]]:
    plan = summarize_idf_plan(
        job_id=job_id,
        target_geometry=target_geometry,
        shading_geometry=shading_geometry,
        building_details=building_details,
        idf_library_path=idf_library_path,
    )
    detail_index = _build_detail_index(building_details)
    target_buildings = {str(item.get('building_id', '')): item for item in target_geometry.get('buildings', [])}

    created_temp_dirs: list[Path] = []
    try:
        # Pre-compute all target buildings as potential shading sources ONCE (O(n) instead of O(n²)).
        # Calling build_target_neighbor_shading_geometry inside the loop would invoke it N times,
        # each iterating all N buildings — O(n²) total geometry work.
        _all_neighbor_shading = build_target_neighbor_shading_geometry(target_geometry)
        _neighbor_by_id: dict[str, Any] = {
            str(e.get('building_id', '')): e
            for e in _all_neighbor_shading.get('shading_buildings', [])
        }
        # Cap context buildings to prevent IDF shading surface explosion for large context radii.
        # Each context building writes 4 bbox wall surfaces; 200 buildings → 800 surfaces per IDF.
        # With GIL-bound eppy, this serializes all threads. Cap at 120 by default.
        _max_ctx = int(os.getenv('ENERGYPLUS_MAX_CONTEXT_SHADING', '120'))
        _raw_ctx_buildings: list[Any] = list(shading_geometry.get('shading_buildings', []))
        _ctx_buildings: list[Any] = _raw_ctx_buildings[:_max_ctx]
        if len(_raw_ctx_buildings) > _max_ctx:
            _dbg(f'[{job_id[:8]}] context shading capped: {len(_raw_ctx_buildings)} → {_max_ctx} buildings (set ENERGYPLUS_MAX_CONTEXT_SHADING to adjust)')
        _ctx_missing: list[Any] = list(shading_geometry.get('missing_ids', []))
        _shading_source: str | None = shading_geometry.get('source_path') or _all_neighbor_shading.get('source_path')
        _dbg(f'[{job_id[:8]}] pre-computed neighbor shading: {len(_neighbor_by_id)} target buildings, {len(_ctx_buildings)} context buildings')

        # Phase 1 — plan all bundles sequentially (fast: shading filter, dir creation, template lookup)
        planned: list[dict[str, Any]] = []
        for bundle in plan['bundles']:
            building_id = bundle['building_id']
            detail = detail_index.get(building_id)
            target_building = target_buildings.get(building_id, {})
            # Filter pre-computed neighbor entries to exclude the current building (O(n) filter, not O(n²) recompute)
            neighbor_entries = [e for bid, e in _neighbor_by_id.items() if bid != building_id]
            bundle_shading_buildings = _dedupe_shading_buildings_for_target(
                target_building_id=building_id,
                context_buildings=_ctx_buildings,
                neighbor_buildings=neighbor_entries,
            )
            bundle_shading_geometry: dict[str, Any] = {
                'source_path': _shading_source,
                'shading_buildings': bundle_shading_buildings,
                'missing_ids': _ctx_missing + _all_neighbor_shading.get('missing_ids', []),
                'surface_count': sum(len(e.get('surfaces', [])) for e in bundle_shading_buildings),
            }
            _dbg(f'[{job_id[:8]}] [{building_id}] shading: {len(bundle_shading_buildings)} unique buildings ({len(_ctx_buildings)} context + {len(neighbor_entries)} neighbors before dedupe)')
            template_path = resolve_template_for_archetype(bundle['archetype'], idf_library_path)
            _dbg(f'[{job_id[:8]}] template: {template_path.name} archetype={bundle["archetype"]}')

            temp_dir = Path(tempfile.mkdtemp(
                prefix=f"idf-{_safe_file_token(job_id)}-{_safe_file_token(building_id)}-"
            ))
            created_temp_dirs.append(temp_dir)
            idf_path = temp_dir / f"{_safe_file_token(building_id)}.idf"
            geometry_json_path = temp_dir / f"{_safe_file_token(building_id)}.geometry.json"
            output_dir = temp_dir / 'energyplus-output'
            output_dir.mkdir(parents=True, exist_ok=True)
            _dbg(f'[{job_id[:8]}] temp dir: {temp_dir}')

            planned.append({
                'bundle': bundle,
                'building_id': building_id,
                'detail': detail,
                'target_building': target_building,
                'bundle_shading_geometry': bundle_shading_geometry,
                'template_path': template_path,
                'temp_dir': temp_dir,
                'idf_path': idf_path,
                'geometry_json_path': geometry_json_path,
                'output_dir': output_dir,
            })

        # Pre-load the eppy IDD in the main thread before spawning worker threads.
        # IDF.setiddname() modifies class-level state and is not thread-safe; calling it
        # here ensures workers only encounter an already-set IDD (IDDAlreadySetError is harmless).
        try:
            configure_eppy_environment(idd_path)
        except Exception:
            pass

        # Phase 2 — write IDF files in parallel (each thread owns its own eppy.IDF instance).
        # eppy is mostly GIL-bound (pure Python), so >2 threads gives diminishing returns for
        # geometry writing. 2 threads still parallelize template I/O (read/write disk).
        total_bundles = len(planned)
        n_idf_workers = min(total_bundles, int(os.getenv('ENERGYPLUS_IDF_WORKERS', '2')))
        runtime_bundles: list[dict[str, Any]] = [{}] * total_bundles
        done_count = 0

        def _write_one_idf(item: dict[str, Any]) -> dict[str, Any]:
            bid = item['building_id']
            bundle = item['bundle']
            detail = item['detail']
            t_eppy = time.monotonic()
            eppy_metadata: dict[str, Any] = {}
            eppy_error: str | None = None
            try:
                resolved_epw_path = str(resolve_epw_path(epw_path))
            except Exception:
                resolved_epw_path = str(DEFAULT_EPW_PATH)
            _dbg(f'[{job_id[:8]}] write_prepared_idf start — {bid} epw={resolved_epw_path}')
            try:
                eppy_metadata = write_prepared_idf(
                    template_path=item['template_path'],
                    output_path=item['idf_path'],
                    target_building=item['target_building'],
                    shading_geometry=item['bundle_shading_geometry'],
                    epw_path=epw_path,
                    idd_path=idd_path,
                )
                _dbg(
                    f'[{job_id[:8]}] write_prepared_idf done in {time.monotonic()-t_eppy:.2f}s — '
                    f'zones={len(eppy_metadata.get("zone_names", []))} '
                    f'surfaces={eppy_metadata.get("target_surface_count")} '
                    f'gfa={eppy_metadata.get("gross_floor_area_m2")}'
                )
            except Exception as error:  # pragma: no cover - runtime fallback for missing EnergyPlus/eppy setup
                _dbg(f'[{job_id[:8]}] write_prepared_idf FAILED in {time.monotonic()-t_eppy:.2f}s: {error}')
                shutil.copy2(item['template_path'], item['idf_path'])
                eppy_error = str(error)
                eppy_metadata = {
                    'idf_path': str(item['idf_path']),
                    'epw_path': resolved_epw_path,
                    'ready_for_runner': False,
                }
            item['geometry_json_path'].write_text(json.dumps({
                'job_id': job_id,
                'building_id': bid,
                'archetype': bundle['archetype'],
                'template_name': item['template_path'].name,
                'target_geometry': item['target_building'],
                'shading_geometry': item['bundle_shading_geometry'].get('shading_buildings', []),
                'detail_snapshot': {
                    'archetype': str(_detail_value(detail, 'archetype', '') or ''),
                    'height_m': _detail_value(detail, 'height_m'),
                    'footprint_area_m2': _detail_value(detail, 'footprint_area_m2'),
                },
                'eppy_prepared': bool(eppy_metadata.get('ready_for_runner')),
                'eppy_error': eppy_error,
                'runner_contract': {
                    'module': 'app.eppy_runner',
                    'function': 'run_idf_batch',
                    'run_item_keys': ['job_id', 'building_id', 'idf_path', 'epw_path', 'output_dir'],
                },
            }, ensure_ascii=False, indent=2), encoding='utf-8')
            return {
                **bundle,
                'template_path': str(item['template_path']),
                'working_dir': str(item['temp_dir']),
                'output_dir': str(item['output_dir']),
                'idf_path': str(item['idf_path']),
                'geometry_json_path': str(item['geometry_json_path']),
                'epw_path': eppy_metadata.get('epw_path', resolved_epw_path),
                'gross_floor_area_m2': eppy_metadata.get('gross_floor_area_m2'),
                'shading_building_count': len(item['bundle_shading_geometry'].get('shading_buildings', [])),
                'eppy_prepared': bool(eppy_metadata.get('ready_for_runner')),
                'eppy_error': eppy_error,
                'eppy_metadata': eppy_metadata,
                'temporary': True,
                'thread_safe': True,
            }

        if n_idf_workers <= 1:
            for i, item in enumerate(planned):
                runtime_bundles[i] = _write_one_idf(item)
                done_count += 1
                if callable(on_progress):
                    on_progress(done_count, total_bundles, item['building_id'])
        else:
            with ThreadPoolExecutor(max_workers=n_idf_workers, thread_name_prefix='idf-prep') as executor:
                future_to_idx = {executor.submit(_write_one_idf, item): i for i, item in enumerate(planned)}
                for future in as_completed(future_to_idx):
                    i = future_to_idx[future]
                    done_count += 1
                    try:
                        runtime_bundles[i] = future.result()
                    except Exception as err:
                        _dbg(f'[{job_id[:8]}] IDF prep failed for bundle {i}: {err}')
                        item = planned[i]
                        runtime_bundles[i] = {
                            **item['bundle'],
                            'template_path': str(item['template_path']),
                            'working_dir': str(item['temp_dir']),
                            'output_dir': str(item['output_dir']),
                            'idf_path': str(item['idf_path']),
                            'geometry_json_path': str(item['geometry_json_path']),
                            'eppy_prepared': False,
                            'eppy_error': str(err),
                        }
                    if callable(on_progress):
                        on_progress(done_count, total_bundles, planned[i]['building_id'])

        runner_request = build_eppy_runner_request(
            job_id=job_id,
            runtime_bundles=runtime_bundles,
            epw_path=epw_path,
            keep_temporary=False,
        )

        yield {
            **plan,
            'bundles': runtime_bundles,
            'runner_request': runner_request,
            'temporary_files_cleaned': False,
        }
    finally:
        # Retry cleanup to handle Windows file locks (e.g. eplusout.sql held after EnergyPlus exits).
        for temp_dir in created_temp_dirs:
            if temp_dir.exists():
                _rmtree_with_retry(temp_dir)


__all__ = [
    'build_eppy_runner_request',
    'configure_eppy_environment',
    'prepare_temporary_idf_batch',
    'resolve_epw_path',
    'resolve_idd_path',
    'resolve_template_for_archetype',
    'submit_to_eppy_runner',
    'summarize_idf_plan',
    'write_prepared_idf',
]
