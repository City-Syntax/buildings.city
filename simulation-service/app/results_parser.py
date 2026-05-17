from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from functools import lru_cache
from math import cos, radians
from pathlib import Path
from typing import Any

JOULES_PER_KWH = 3_600_000.0
REPO_ROOT = Path(__file__).resolve().parents[2]
USER_TEMPLATE_PATH = REPO_ROOT / 'user-data' / 'simulation' / 'templates.json'
DEFAULT_ENERGY_CONVERSIONS = {
    'cop_cool': 4.0,
    'cop_heat': 1.0,
    'cop_dhw': 2.5,
}

FACILITY_TOTAL_METERS = (
    'Electricity:Facility',
    'Gas:Facility',
    'DistrictCooling:Facility',
    'DistrictHeating:Facility',
    'DistrictHeatingWater:Facility',
)

ANNUAL_METER_GROUPS: dict[str, tuple[str, ...]] = {
    'cooling_energy_kwh': (
        'Cooling:Electricity',
        'Cooling:DistrictCooling',
        'Fans:Electricity',
        'Pumps:Electricity',
    ),
    'heating_energy_kwh': (
        'Heating:Electricity',
        'Heating:Gas',
        'Heating:DistrictHeating',
    ),
    'lighting_energy_kwh': (
        'InteriorLights:Electricity',
    ),
    'equipment_energy_kwh': (
        'InteriorEquipment:Electricity',
    ),
    'hot_water_energy_kwh': (
        'WaterSystems:Electricity',
        'WaterSystems:Gas',
        'WaterSystems:DistrictHeating',
        'WaterSystems:DistrictHeatingWater',
        "WaterSystems:Energy",
        "WaterSystems:Electricity",
    ),
}

HOURLY_SERIES_GROUPS: dict[str, dict[str, Any]] = {
    'total_electricity': {
        'label': 'Total Electricity Equivalent',
        'unit': 'kWh',
        'meters': ('Electricity:Facility', 'DistrictCooling:Facility', 'DistrictHeatingWater:Facility'),
    },
    'cooling': {
        'label': 'Cooling',
        'unit': 'kWh',
        'meters': ('Cooling:Electricity', 'Cooling:DistrictCooling'),
    },
    'heating': {
        'label': 'Heating',
        'unit': 'kWh',
        'meters': ('Heating:Electricity', 'Heating:Gas', 'Heating:DistrictHeating'),
    },
    'fans_pumps': {
        'label': 'Fans + Pumps',
        'unit': 'kWh',
        'meters': ('Fans:Electricity', 'Pumps:Electricity'),
    },
    'lighting': {
        'label': 'Lighting',
        'unit': 'kWh',
        'meters': ('InteriorLights:Electricity',),
    },
    'equipment': {
        'label': 'Equipment',
        'unit': 'kWh',
        'meters': ('InteriorEquipment:Electricity',),
    },
    'hot_water': {
        'label': 'Hot Water',
        'unit': 'kWh',
        'meters': (
            'WaterSystems:Electricity',
            'WaterSystems:Gas',
            'WaterSystems:DistrictHeating',
            'WaterSystems:DistrictHeatingWater',
            'WaterSystems:Energy',
        ),
    },
}

COOLING_ELECTRIC_METERS = ('Cooling:Electricity',)
COOLING_THERMAL_METERS = ('Cooling:DistrictCooling',)
FAN_PUMP_ELECTRIC_METERS = ('Fans:Electricity', 'Pumps:Electricity')
HEATING_ELECTRIC_OR_FUEL_METERS = ('Heating:Electricity', 'Heating:Gas')
HEATING_THERMAL_METERS = ('Heating:DistrictHeating',)
LIGHTING_ELECTRIC_METERS = ('InteriorLights:Electricity',)
EQUIPMENT_ELECTRIC_METERS = ('InteriorEquipment:Electricity',)
HOT_WATER_ELECTRIC_OR_FUEL_METERS = ('WaterSystems:Electricity', 'WaterSystems:Gas')
HOT_WATER_THERMAL_METERS = (
    'WaterSystems:DistrictHeating',
    'WaterSystems:DistrictHeatingWater',
    'WaterSystems:Energy',
)


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _positive_float(value: Any, default: float) -> float:
    numeric = _safe_float(value)
    return numeric if numeric is not None and numeric > 0 else default


def _convert_to_kwh(value: Any, units: str | None) -> float:
    numeric_value = _safe_float(value) or 0.0
    normalized_units = str(units or '').strip().lower()

    if normalized_units in {'j', 'joule', 'joules'}:
        return numeric_value / JOULES_PER_KWH
    if normalized_units == 'mj':
        return numeric_value / 3_600.0
    if normalized_units == 'gj':
        return numeric_value / 3.6
    if normalized_units in {'wh', 'watt-hours', 'watthours'}:
        return numeric_value / 1_000.0
    if normalized_units in {'kwh', 'kwh/m2', 'kwh/m^2'}:
        return numeric_value

    return numeric_value


def _normalize_match_key(value: Any) -> str:
    return ''.join(ch for ch in str(value or '').lower() if ch.isalnum())


@lru_cache(maxsize=1)
def _load_template_parameter_map() -> dict[str, dict[str, Any]]:
    if not USER_TEMPLATE_PATH.exists():
        return {}

    try:
        payload = json.loads(USER_TEMPLATE_PATH.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}

    entries = payload.get('templates') if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        return {}

    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        archetype = str(entry.get('archetype') or '')
        params = entry.get('simulation_parameters') or {}
        if archetype and isinstance(params, dict):
            result[_normalize_match_key(archetype)] = params
    return result


def _load_geometry_payload(geometry_json_path: str | Path | None) -> dict[str, Any]:
    if not geometry_json_path:
        return {}

    path = Path(geometry_json_path).expanduser().resolve()
    if not path.exists():
        return {}

    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}

    return payload if isinstance(payload, dict) else {}


def _template_params_for_archetype(archetype: Any) -> dict[str, Any]:
    template_map = _load_template_parameter_map()
    key = _normalize_match_key(archetype)
    if key in template_map:
        return template_map[key]

    for template_key, params in template_map.items():
        if key and (key in template_key or template_key in key):
            return params
    return {}


def resolve_energy_conversions(run_result: dict[str, Any] | None = None) -> dict[str, float]:
    run_result = run_result or {}
    payload = _load_geometry_payload(run_result.get('geometry_json_path'))
    archetype = (
        run_result.get('archetype')
        or payload.get('archetype')
        or (payload.get('detail_snapshot') or {}).get('archetype')
    )
    params = _template_params_for_archetype(archetype)

    return {
        'cop_cool': _positive_float(params.get('cop_cool'), DEFAULT_ENERGY_CONVERSIONS['cop_cool']),
        'cop_heat': _positive_float(params.get('cop_heat'), DEFAULT_ENERGY_CONVERSIONS['cop_heat']),
        'cop_dhw': _positive_float(params.get('cop_dhw'), DEFAULT_ENERGY_CONVERSIONS['cop_dhw']),
    }


def _convert_meter_kwh_for_site_equivalent(
    meter_name: str,
    value: Any,
    units: str | None,
    energy_conversions: dict[str, float] | None = None,
) -> float:
    kwh = _convert_to_kwh(value, units)
    conversions = {**DEFAULT_ENERGY_CONVERSIONS, **(energy_conversions or {})}
    normalized_name = str(meter_name or '').strip()

    if normalized_name in {'Cooling:DistrictCooling', 'DistrictCooling:Facility'}:
        return kwh / _positive_float(conversions.get('cop_cool'), DEFAULT_ENERGY_CONVERSIONS['cop_cool'])

    if normalized_name in {'Heating:DistrictHeating', 'DistrictHeating:Facility'}:
        return kwh / _positive_float(conversions.get('cop_heat'), DEFAULT_ENERGY_CONVERSIONS['cop_heat'])

    if normalized_name in {
        'WaterSystems:DistrictHeating',
        'WaterSystems:DistrictHeatingWater',
        'DistrictHeatingWater:Facility',
        'Water Use Equipment Heating Energy',
    }:
        return kwh / _positive_float(conversions.get('cop_dhw'), DEFAULT_ENERGY_CONVERSIONS['cop_dhw'])

    return kwh


def _extract_ring_coordinates(geometry: dict[str, Any], *, z_value: float = 0.0) -> list[list[float]]:
    geometry_type = geometry.get('type')
    coordinates = geometry.get('coordinates') or []

    if geometry_type == 'Polygon' and coordinates:
        ring = coordinates[0]
    elif geometry_type == 'MultiPolygon' and coordinates and coordinates[0]:
        ring = coordinates[0][0]
    else:
        return []

    vertices: list[list[float]] = []
    for point in ring:
        if len(point) < 2:
            continue
        vertices.append([float(point[0]), float(point[1]), float(z_value)])
    return vertices


def _is_closed_ring(vertices: list[list[float]]) -> bool:
    if len(vertices) < 2:
        return False
    return all(abs(vertices[0][index] - vertices[-1][index]) < 1e-9 for index in range(3))


def _dedupe_closed_ring(vertices: list[list[float]]) -> list[list[float]]:
    return vertices[:-1] if _is_closed_ring(vertices) else vertices


def _resolve_local_origin(target_geometry: dict[str, Any]) -> tuple[float, float]:
    footprint_ring = _extract_ring_coordinates(target_geometry.get('footprint') or {})
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

        local_vertices.append([local_x, local_y, z_value])

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


def load_target_geometry(geometry_json_path: str | Path | None) -> dict[str, Any]:
    return _load_geometry_payload(geometry_json_path).get('target_geometry') or {}


def compute_gross_floor_area_m2(target_geometry: dict[str, Any]) -> float:
    direct_value = _safe_float(target_geometry.get('gross_floor_area_m2'))
    if direct_value is not None and direct_value > 0:
        return round(direct_value, 3)

    origin_lon, origin_lat = _resolve_local_origin(target_geometry)
    gross_floor_area_m2 = 0.0

    for floor in target_geometry.get('floors', []):
        z_min = _safe_float(floor.get('z_min')) or 0.0
        for zone in floor.get('zones', []):
            footprint_vertices = _project_vertices_to_local_coordinates(
                _extract_ring_coordinates(zone.get('footprint') or {}, z_value=z_min),
                origin_lon=origin_lon,
                origin_lat=origin_lat,
            )
            gross_floor_area_m2 += _estimate_polygon_area(footprint_vertices)

    return round(gross_floor_area_m2, 3)


def load_annual_meter_values(sql_path: str | Path | None) -> dict[str, float]:
    if not sql_path:
        return {}

    path = Path(sql_path).expanduser().resolve()
    if not path.exists():
        return {}

    meter_values: dict[str, float] = {}

    max_retries = 10
    retry_delay = 0.5

    for attempt in range(max_retries):
        try:
            # Use closing() to guarantee connection.close() is called immediately,
            # not deferred to GC — prevents Windows file-lock on eplusout.sql during cleanup.
            with closing(sqlite3.connect(path, timeout=5.0)) as connection:
                # Accept both 'Annual' (EnergyPlus >= 9.4) and 'Run Period' (all versions,
                # which is what EnergyPlus writes to SQL when the IDF uses RunPeriod frequency).
                rows = connection.execute(
                    '''
                    SELECT rdd.Name AS meter_name, rdd.Units AS units, SUM(rd.Value) AS total_value
                    FROM ReportData AS rd
                    JOIN ReportDataDictionary AS rdd
                      ON rd.ReportDataDictionaryIndex = rdd.ReportDataDictionaryIndex
                    WHERE UPPER(COALESCE(rdd.ReportingFrequency, '')) IN ('ANNUAL', 'RUN PERIOD', 'RUNPERIOD')
                    GROUP BY rdd.Name, rdd.Units
                    '''
                ).fetchall()

            for meter_name, units, total_value in rows:
                normalized_name = str(meter_name or '').strip()
                if not normalized_name:
                    continue
                meter_values[normalized_name] = meter_values.get(normalized_name, 0.0) + _convert_to_kwh(total_value, units)

            return meter_values

        except sqlite3.OperationalError as error:
            if 'database is locked' in str(error).lower():
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    continue
            return {}
        except sqlite3.Error:
            return {}

    return meter_values


def _sum_meter_group(meter_values: dict[str, float], meter_names: tuple[str, ...]) -> float:
    return round(sum(float(meter_values.get(name, 0.0) or 0.0) for name in meter_names), 3)


def _sum_converted_meter_group(
    meter_values: dict[str, float],
    meter_names: tuple[str, ...],
    energy_conversions: dict[str, float] | None = None,
) -> float:
    return round(
        sum(
            _convert_meter_kwh_for_site_equivalent(name, meter_values.get(name, 0.0), 'kWh', energy_conversions)
            for name in meter_names
        ),
        3,
    )


def build_eui_metrics(
    meter_values: dict[str, float],
    gross_floor_area_m2: float,
    energy_conversions: dict[str, float] | None = None,
) -> dict[str, Any]:
    conversions = {**DEFAULT_ENERGY_CONVERSIONS, **(energy_conversions or {})}
    component_energy: dict[str, float] = {
        'cooling_energy_kwh': round(
            _sum_converted_meter_group(meter_values, COOLING_ELECTRIC_METERS, conversions)
            + _sum_converted_meter_group(meter_values, COOLING_THERMAL_METERS, conversions)
            + _sum_converted_meter_group(meter_values, FAN_PUMP_ELECTRIC_METERS, conversions),
            3,
        ),
        'heating_energy_kwh': round(
            _sum_converted_meter_group(meter_values, HEATING_ELECTRIC_OR_FUEL_METERS, conversions)
            + _sum_converted_meter_group(meter_values, HEATING_THERMAL_METERS, conversions),
            3,
        ),
        'lighting_energy_kwh': _sum_converted_meter_group(meter_values, LIGHTING_ELECTRIC_METERS, conversions),
        'equipment_energy_kwh': _sum_converted_meter_group(meter_values, EQUIPMENT_ELECTRIC_METERS, conversions),
        'hot_water_energy_kwh': round(
            _sum_converted_meter_group(meter_values, HOT_WATER_ELECTRIC_OR_FUEL_METERS, conversions)
            + _sum_converted_meter_group(meter_values, HOT_WATER_THERMAL_METERS, conversions),
            3,
        ),
    }

    total_energy_kwh = round(sum(component_energy.values()), 3)
    if total_energy_kwh <= 0:
        total_energy_kwh = _sum_converted_meter_group(meter_values, FACILITY_TOTAL_METERS, conversions)

    def eui_for(energy_kwh: float) -> float | None:
        if gross_floor_area_m2 <= 0:
            return None
        return round(energy_kwh / gross_floor_area_m2, 3)

    cooling_eui    = eui_for(component_energy['cooling_energy_kwh'])
    heating_eui    = eui_for(component_energy['heating_energy_kwh'])
    lighting_eui   = eui_for(component_energy['lighting_energy_kwh'])
    equipment_eui  = eui_for(component_energy['equipment_energy_kwh'])
    hot_water_eui  = eui_for(component_energy['hot_water_energy_kwh'])
    total_eui = round(
        sum(v for v in [cooling_eui, heating_eui, lighting_eui, equipment_eui, hot_water_eui] if v is not None),
        3,
    ) if gross_floor_area_m2 > 0 else None

    annual_energy_kwh = round(total_eui * gross_floor_area_m2, 3) if total_eui is not None else 0.0

    return {
        'gross_floor_area_m2': round(gross_floor_area_m2, 3),
        'total_energy_kwh': round(total_energy_kwh, 3),
        'annual_energy_kwh': annual_energy_kwh,
        'total_eui_kwh_m2': total_eui,
        'annual_site_eui_kwh_m2': total_eui,
        'cooling_energy_kwh': component_energy['cooling_energy_kwh'],
        'cooling_eui_kwh_m2': cooling_eui,
        'heating_energy_kwh': component_energy['heating_energy_kwh'],
        'heating_eui_kwh_m2': heating_eui,
        'lighting_energy_kwh': component_energy['lighting_energy_kwh'],
        'lighting_eui_kwh_m2': lighting_eui,
        'equipment_energy_kwh': component_energy['equipment_energy_kwh'],
        'equipment_eui_kwh_m2': equipment_eui,
        'hot_water_energy_kwh': component_energy['hot_water_energy_kwh'],
        'hot_water_eui_kwh_m2': hot_water_eui,
        'raw_meter_values_are_kwh': True,
        'energy_conversion_basis': {
            'cooling_district_kwh_divided_by_cop_cool': conversions['cop_cool'],
            'dhw_district_kwh_divided_by_cop_dhw': conversions['cop_dhw'],
        },
    }


def _query_sql_frequencies(sql_path: str | Path | None) -> list[str]:
    if not sql_path:
        return []
    path = Path(sql_path).expanduser().resolve()
    if not path.exists():
        return []
    try:
        with closing(sqlite3.connect(path, timeout=5.0)) as connection:
            rows = connection.execute(
                'SELECT DISTINCT ReportingFrequency FROM ReportDataDictionary ORDER BY ReportingFrequency'
            ).fetchall()
            return [str(row[0]) for row in rows if row[0]]
    except Exception:
        return []


def _normalize_sql_name(value: Any) -> str:
    return str(value or '').strip().upper()


def load_hourly_key_outputs(
    sql_path: str | Path | None,
    energy_conversions: dict[str, float] | None = None,
) -> dict[str, Any]:
    if not sql_path:
        return {'labels': [], 'series': [], 'available_series': []}

    path = Path(sql_path).expanduser().resolve()
    if not path.exists():
        return {'labels': [], 'series': [], 'available_series': []}

    meter_names = sorted({
        meter
        for group in HOURLY_SERIES_GROUPS.values()
        for meter in group['meters']
    })
    meter_name_lookup = {_normalize_sql_name(name): name for name in meter_names}
    normalized_meter_names = sorted(meter_name_lookup)
    placeholders = ','.join('?' for _ in normalized_meter_names)

    try:
        with closing(sqlite3.connect(path, timeout=5.0)) as connection:
            rows = connection.execute(
                f'''
                SELECT
                    rdd.Name AS meter_name,
                    rdd.Units AS units,
                    t.Month,
                    t.Day,
                    t.Hour,
                    t.Minute,
                    rd.Value
                FROM ReportData AS rd
                JOIN ReportDataDictionary AS rdd
                  ON rd.ReportDataDictionaryIndex = rdd.ReportDataDictionaryIndex
                JOIN Time AS t
                  ON rd.TimeIndex = t.TimeIndex
                WHERE UPPER(COALESCE(rdd.ReportingFrequency, '')) = 'HOURLY'
                  AND UPPER(COALESCE(rdd.Name, '')) IN ({placeholders})
                ORDER BY t.TimeIndex, rdd.Name
                ''',
                normalized_meter_names,
            ).fetchall()
    except sqlite3.Error:
        return {'labels': [], 'series': [], 'available_series': []}

    labels_by_time: dict[tuple[int, int, int, int], str] = {}
    value_lookup: dict[tuple[str, tuple[int, int, int, int]], float] = {}
    available_meter_names: set[str] = set()

    for meter_name, units, month, day, hour, minute, value in rows:
        time_key = (int(month or 1), int(day or 1), int(hour or 0), int(minute or 0))
        labels_by_time[time_key] = f'{time_key[0]}/{time_key[1]} {time_key[2]:02d}:00'
        canonical_meter_name = meter_name_lookup.get(_normalize_sql_name(meter_name), str(meter_name))
        available_meter_names.add(canonical_meter_name)
        lookup_key = (canonical_meter_name, time_key)
        converted_value = _convert_meter_kwh_for_site_equivalent(
            canonical_meter_name,
            value,
            units,
            energy_conversions,
        )
        value_lookup[lookup_key] = value_lookup.get(lookup_key, 0.0) + converted_value

    sorted_time_keys = sorted(labels_by_time)
    labels = [labels_by_time[key] for key in sorted_time_keys]
    series: list[dict[str, Any]] = []

    for key, meta in HOURLY_SERIES_GROUPS.items():
        values: list[float] = []
        has_any_value = False
        has_meter_rows = any(meter in available_meter_names for meter in meta['meters'])
        for time_key in sorted_time_keys:
            total_value = sum(value_lookup.get((meter, time_key), 0.0) for meter in meta['meters'])
            if abs(total_value) > 1e-12:
                has_any_value = True
            values.append(round(total_value, 5))

        if has_any_value or has_meter_rows:
            series.append({
                'key': key,
                'label': meta['label'],
                'unit': meta['unit'],
                'values': values,
            })

    return {
        'labels': labels,
        'series': series,
        'energy_conversion_basis': {
            'cooling_district_kwh_divided_by_cop_cool': (energy_conversions or DEFAULT_ENERGY_CONVERSIONS).get('cop_cool'),
            'dhw_district_kwh_divided_by_cop_dhw': (energy_conversions or DEFAULT_ENERGY_CONVERSIONS).get('cop_dhw'),
        },
        'available_series': [
            {'key': item['key'], 'label': item['label'], 'unit': item['unit']}
            for item in series
        ],
    }


def parse_run_results(run_result: dict[str, Any]) -> dict[str, Any]:
    artifacts = run_result.get('artifacts') or {}
    sql_path = artifacts.get('sql')
    target_geometry = load_target_geometry(run_result.get('geometry_json_path'))
    gross_floor_area_m2 = compute_gross_floor_area_m2(target_geometry) or _safe_float(run_result.get('gross_floor_area_m2')) or 0.0
    meter_values = load_annual_meter_values(sql_path)
    energy_conversions = resolve_energy_conversions(run_result)
    metrics = build_eui_metrics(meter_values, gross_floor_area_m2, energy_conversions)

    return {
        'building_id': str(run_result.get('building_id', '')),
        'archetype': run_result.get('archetype') or _load_geometry_payload(run_result.get('geometry_json_path')).get('archetype'),
        'gross_floor_area_m2': metrics.get('gross_floor_area_m2', gross_floor_area_m2),
        'meter_values_kwh': meter_values,
        'energy_conversions': energy_conversions,
        'metrics': metrics,
        'sql_available_frequencies': _query_sql_frequencies(sql_path),
    }


def aggregate_batch_metrics(results: list[dict[str, Any]]) -> dict[str, Any]:
    energy_totals = {
        'total_energy_kwh': 0.0,
        'cooling_energy_kwh': 0.0,
        'heating_energy_kwh': 0.0,
        'lighting_energy_kwh': 0.0,
        'equipment_energy_kwh': 0.0,
        'hot_water_energy_kwh': 0.0,
    }
    gross_floor_area_m2 = 0.0
    contributing_runs = 0

    for result in results:
        if result.get('status') != 'completed':
            continue

        parsed = result.get('parsed_results') or {}
        metrics = parsed.get('metrics') or {}
        run_floor_area = _safe_float(metrics.get('gross_floor_area_m2')) or 0.0

        if run_floor_area <= 0:
            continue

        gross_floor_area_m2 += run_floor_area
        contributing_runs += 1

        for key in energy_totals:
            energy_totals[key] += _safe_float(metrics.get(key)) or 0.0

    if gross_floor_area_m2 <= 0:
        return {
            'gross_floor_area_m2': 0.0,
            'contributing_runs': contributing_runs,
        }

    def eui_for(metric_name: str) -> float:
        return round(energy_totals[metric_name] / gross_floor_area_m2, 3)

    cooling_eui   = eui_for('cooling_energy_kwh')
    heating_eui   = eui_for('heating_energy_kwh')
    lighting_eui  = eui_for('lighting_energy_kwh')
    equipment_eui = eui_for('equipment_energy_kwh')
    hot_water_eui = eui_for('hot_water_energy_kwh')
    total_eui     = round(cooling_eui + heating_eui + lighting_eui + equipment_eui + hot_water_eui, 3)
    annual_energy_kwh = round(total_eui * gross_floor_area_m2, 3)

    return {
        'gross_floor_area_m2': round(gross_floor_area_m2, 3),
        'contributing_runs': contributing_runs,
        'total_energy_kwh': round(energy_totals['total_energy_kwh'], 3),
        'annual_energy_kwh': annual_energy_kwh,
        'total_eui_kwh_m2': total_eui,
        'annual_site_eui_kwh_m2': total_eui,
        'cooling_energy_kwh': round(energy_totals['cooling_energy_kwh'], 3),
        'cooling_eui_kwh_m2': cooling_eui,
        'heating_energy_kwh': round(energy_totals['heating_energy_kwh'], 3),
        'heating_eui_kwh_m2': heating_eui,
        'lighting_energy_kwh': round(energy_totals['lighting_energy_kwh'], 3),
        'lighting_eui_kwh_m2': lighting_eui,
        'equipment_energy_kwh': round(energy_totals['equipment_energy_kwh'], 3),
        'equipment_eui_kwh_m2': equipment_eui,
        'hot_water_energy_kwh': round(energy_totals['hot_water_energy_kwh'], 3),
        'hot_water_eui_kwh_m2': hot_water_eui,
    }


__all__ = [
    'aggregate_batch_metrics',
    'build_eui_metrics',
    'compute_gross_floor_area_m2',
    'load_annual_meter_values',
    'load_hourly_key_outputs',
    'parse_run_results',
    'resolve_energy_conversions',
]
