from __future__ import annotations

import json
import os
from functools import lru_cache
from math import sqrt
from pathlib import Path
from typing import Any

from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = Path(__file__).resolve().parents[1]
USER_DATA_ROOT = REPO_ROOT / 'user-data'
CONFIG_PATH = USER_DATA_ROOT / 'config.json'
TEMPLATES_JSON_PATH = USER_DATA_ROOT / 'simulation' / 'templates.json'


def _resolve_configured_geojson_path() -> Path | None:
    if not CONFIG_PATH.exists():
        return None

    try:
        with CONFIG_PATH.open('r', encoding='utf-8') as handle:
            config = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None

    data_path = str(((config.get('buildings_source') or {}).get('data')) or '').strip()
    if not data_path:
        return None

    candidate = Path(data_path).expanduser()
    if candidate.is_absolute():
        return candidate

    return (REPO_ROOT / data_path.lstrip('/\\')).resolve()


def resolve_building_library_path(geojson_path: str | None = None) -> Path:
    raw_path = str(geojson_path or os.getenv('BUILDING_LIBRARY_GEOJSON') or '').strip()

    if raw_path:
        candidate = Path(raw_path).expanduser()
        resolved = candidate if candidate.is_absolute() else (REPO_ROOT / candidate)
        resolved = resolved.resolve()
        if resolved.exists():
            return resolved
        raise FileNotFoundError(f'Building library GeoJSON not found: {resolved}')

    configured_path = _resolve_configured_geojson_path()
    if configured_path is not None and configured_path.exists():
        return configured_path.resolve()

    raise FileNotFoundError(
        'Building library GeoJSON is not configured. Set `user-data/config.json -> buildings_source.data` '
        'or `BUILDING_LIBRARY_GEOJSON` explicitly.'
    )


def _safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    return number if number > 0 else None


def _string_id(value: Any) -> str:
    return '' if value is None else str(value)


def _normalize_token(value: Any) -> str:
    return ''.join(ch for ch in str(value or '').strip().lower() if ch.isalnum())


def _detail_value(detail: Any, field_name: str, default: Any = None) -> Any:
    if detail is None:
        return default
    if isinstance(detail, dict):
        return detail.get(field_name, default)
    return getattr(detail, field_name, default)


def _build_details_index(building_details: list[Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for detail in building_details or []:
        building_id = _string_id(_detail_value(detail, 'building_id'))
        if building_id:
            result[building_id] = detail
    return result


@lru_cache(maxsize=8)
def load_building_library(geojson_path: str | None = None) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], str]:
    path = resolve_building_library_path(geojson_path)

    with path.open('r', encoding='utf-8') as handle:
        geojson = json.load(handle)

    features: list[dict[str, Any]] = []
    feature_index: dict[str, dict[str, Any]] = {}

    for index, feature in enumerate(geojson.get('features', [])):
        geometry = feature.get('geometry') or {}
        if geometry.get('type') not in {'Polygon', 'MultiPolygon'}:
            continue

        properties = feature.get('properties') or {}
        normalized_feature = {
            **feature,
            'properties': properties,
        }
        features.append(normalized_feature)

        candidate_ids = {
            _string_id(feature.get('id')),
            _string_id(properties.get('simulation_uid')),
            _string_id(properties.get('id')),
            _string_id(properties.get('building_id')),
            _string_id(properties.get('osm_id')),
            _string_id(properties.get('@id')),
            _string_id(index),
        }

        for candidate_id in candidate_ids:
            if candidate_id:
                feature_index[candidate_id] = normalized_feature

    return features, feature_index, str(path)


def _resolve_feature(building_id: str, feature_index: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    return feature_index.get(_string_id(building_id))


def _get_primary_polygon(feature: dict[str, Any]) -> Polygon:
    geometry = feature.get('geometry') or {}
    polygon = shape(geometry)

    if polygon.is_empty:
        raise ValueError('Building footprint geometry is empty.')

    if isinstance(polygon, MultiPolygon):
        polygon = max(polygon.geoms, key=lambda item: item.area)

    if not isinstance(polygon, Polygon):
        raise ValueError(f'Unsupported geometry type: {polygon.geom_type}')

    if not polygon.is_valid:
        polygon = polygon.buffer(0)

    return polygon


def _get_height_m(feature: dict[str, Any], detail: Any = None, default_height_m: float = 3.2) -> float:
    detail_height = _safe_float(_detail_value(detail, 'height_m'))
    if detail_height is not None:
        return detail_height

    properties = feature.get('properties') or {}
    for field_name in ('height', 'building_height', 'render_height'):
        height_value = _safe_float(properties.get(field_name))
        if height_value is not None:
            return height_value

    levels = _safe_float(properties.get('building_levels') or properties.get('building:levels') or properties.get('levels'))
    if levels is not None:
        return levels * 3.2

    return max(default_height_m, 3.2)


def _simplify_target_polygon(polygon: Polygon, geometry_mode: str) -> Polygon:
    mode = (geometry_mode or '').strip().lower()
    if mode in {'minimum_rotated_rectangle', 'rectangle', 'rectangular'}:
        simplified = polygon.minimum_rotated_rectangle
        return simplified if isinstance(simplified, Polygon) and not simplified.is_empty else polygon

    simplified = polygon.simplify(0.000002, preserve_topology=True)
    return simplified if isinstance(simplified, Polygon) and not simplified.is_empty else polygon


def _simplify_context_polygon(polygon: Polygon) -> Polygon:
    simplified = polygon.simplify(0.000003, preserve_topology=True)
    return simplified if isinstance(simplified, Polygon) and not simplified.is_empty else polygon


def _make_zone_polygons(footprint: Polygon, zoning_mode: str) -> dict[str, Polygon]:
    if (zoning_mode or '').strip().lower() != 'core_perimeter':
        return {'single_zone': footprint}

    min_x, min_y, max_x, max_y = footprint.bounds
    width = max_x - min_x
    depth = max_y - min_y
    if width <= 0 or depth <= 0:
        return {'single_zone': footprint}

    perimeter_x = width * 0.2
    perimeter_y = depth * 0.2
    if perimeter_x <= 0 or perimeter_y <= 0 or perimeter_x * 2 >= width or perimeter_y * 2 >= depth:
        return {'single_zone': footprint}

    zones = {
        'west_perimeter': box(min_x, min_y, min_x + perimeter_x, max_y),
        'east_perimeter': box(max_x - perimeter_x, min_y, max_x, max_y),
        'south_perimeter': box(min_x + perimeter_x, min_y, max_x - perimeter_x, min_y + perimeter_y),
        'north_perimeter': box(min_x + perimeter_x, max_y - perimeter_y, max_x - perimeter_x, max_y),
        'core': box(min_x + perimeter_x, min_y + perimeter_y, max_x - perimeter_x, max_y - perimeter_y),
    }

    return {name: zone.intersection(footprint) for name, zone in zones.items() if not zone.intersection(footprint).is_empty}


def _ring_to_vertices(coords: list[tuple[float, float]], z_value: float) -> list[list[float]]:
    return [[round(x, 6), round(y, 6), round(z_value, 2)] for x, y in coords]


@lru_cache(maxsize=1)
def load_template_wwr_map() -> dict[str, float]:
    if not TEMPLATES_JSON_PATH.exists():
        return {}

    try:
        with TEMPLATES_JSON_PATH.open('r', encoding='utf-8') as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}

    entries = data.get('templates') if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return {}

    result: dict[str, float] = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        archetype = _normalize_token(item.get('archetype'))
        params = item.get('simulation_parameters') or {}
        try:
            wwr = float(params.get('wwr'))
        except (TypeError, ValueError):
            continue
        if archetype:
            result[archetype] = max(0.0, min(wwr, 0.95))
    return result


def get_archetype_window_to_wall_ratio(archetype: Any = None) -> float:
    wwr_map = load_template_wwr_map()
    normalized = _normalize_token(archetype)
    if normalized in wwr_map:
        return wwr_map[normalized]
    return wwr_map.get('unknown', 0.4)


def build_window_geometry(surfaces: list[dict[str, Any]], archetype: Any = None) -> list[dict[str, Any]]:
    wwr = max(0.0, min(get_archetype_window_to_wall_ratio(archetype), 0.95))
    if wwr <= 0:
        return []

    inset_factor = (1.0 - sqrt(wwr)) / 2.0
    windows: list[dict[str, Any]] = []

    for surface in surfaces:
        if str(surface.get('surface_type', '')).strip().lower() != 'wall':
            continue

        vertices = surface.get('vertices') or []
        if len(vertices) < 4:
            continue

        bottom_left = vertices[0]
        bottom_right = vertices[1]
        top_left = vertices[3]

        width_vector = [float(bottom_right[i]) - float(bottom_left[i]) for i in range(3)]
        height_vector = [float(top_left[i]) - float(bottom_left[i]) for i in range(3)]

        def point_at(width_factor: float, height_factor: float) -> list[float]:
            return [
                round(float(bottom_left[i]) + width_vector[i] * width_factor + height_vector[i] * height_factor, 6)
                for i in range(3)
            ]

        window_vertices = [
            point_at(inset_factor, inset_factor),
            point_at(1.0 - inset_factor, inset_factor),
            point_at(1.0 - inset_factor, 1.0 - inset_factor),
            point_at(inset_factor, 1.0 - inset_factor),
        ]

        windows.append({
            'surface_id': f"{surface.get('surface_id', 'wall')}:window",
            'building_id': surface.get('building_id'),
            'zone_id': surface.get('zone_id'),
            'surface_type': 'window',
            'host_surface_id': surface.get('surface_id'),
            'wwr': round(wwr, 3),
            'vertices': window_vertices,
        })

    return windows


def _build_floor_and_roof_surfaces(building_id: str, zone_id: str, polygon: Polygon, z_min: float, z_max: float) -> list[dict[str, Any]]:
    ring = list(polygon.exterior.coords)
    return [
        {
            'surface_id': f'{zone_id}:floor',
            'building_id': building_id,
            'zone_id': zone_id,
            'surface_type': 'floor',
            'vertices': _ring_to_vertices(ring, z_min),
        },
        {
            'surface_id': f'{zone_id}:roof',
            'building_id': building_id,
            'zone_id': zone_id,
            'surface_type': 'roof',
            'vertices': _ring_to_vertices(ring, z_max),
        },
    ]


def _build_wall_surfaces(building_id: str, zone_id: str, polygon: Polygon, z_min: float, z_max: float, surface_type: str = 'wall') -> list[dict[str, Any]]:
    ring = list(polygon.exterior.coords)
    surfaces: list[dict[str, Any]] = []

    for index in range(len(ring) - 1):
        start = ring[index]
        end = ring[index + 1]
        surfaces.append({
            'surface_id': f'{zone_id}:{surface_type}_{index + 1}',
            'building_id': building_id,
            'zone_id': zone_id,
            'surface_type': surface_type,
            'vertices': [
                [round(start[0], 6), round(start[1], 6), round(z_min, 2)],
                [round(end[0], 6), round(end[1], 6), round(z_min, 2)],
                [round(end[0], 6), round(end[1], 6), round(z_max, 2)],
                [round(start[0], 6), round(start[1], 6), round(z_max, 2)],
            ],
        })

    return surfaces


def build_target_building_geometry(
    building_ids: list[str],
    *,
    geojson_path: str | None = None,
    building_details: list[Any] | None = None,
    floor_height_m: float = 3.2,
    geometry_mode: str = 'minimum_rotated_rectangle',
    zoning_mode: str = 'core_perimeter',
) -> dict[str, Any]:
    resolved_geojson_path = str(resolve_building_library_path(geojson_path))
    _, feature_index, source_path = load_building_library(resolved_geojson_path)
    details_index = _build_details_index(building_details)

    result: dict[str, Any] = {
        'source_path': source_path,
        'geometry_mode': geometry_mode,
        'zoning_mode': zoning_mode,
        'buildings': [],
        'missing_ids': [],
        'surface_count': 0,
        'zone_count': 0,
        'floor_count': 0,
        'window_count': 0,
    }

    for building_id in building_ids:
        feature = _resolve_feature(building_id, feature_index)
        if not feature:
            result['missing_ids'].append(_string_id(building_id))
            continue

        detail = details_index.get(_string_id(building_id))
        base_polygon = _get_primary_polygon(feature)
        footprint = _simplify_target_polygon(base_polygon, geometry_mode)
        zone_polygons = _make_zone_polygons(footprint, zoning_mode)
        height_m = _get_height_m(feature, detail=detail, default_height_m=floor_height_m)
        properties = feature.get('properties') or {}
        levels_raw = (
            properties.get('building_levels')
            or properties.get('building:levels')
            or properties.get('levels')
        )
        levels_direct = _safe_float(levels_raw)
        if levels_direct is not None:
            floor_count = max(1, round(levels_direct))
        else:
            floor_count = max(1, round(height_m / 3.2))
        archetype = str(_detail_value(detail, 'archetype', feature.get('properties', {}).get('building_archetype', 'unknown')) or 'unknown')
        window_to_wall_ratio = get_archetype_window_to_wall_ratio(archetype)

        floors: list[dict[str, Any]] = []
        building_surface_count = 0
        building_zone_count = 0
        building_window_count = 0

        for floor_index in range(floor_count):
            z_min = round(floor_index * floor_height_m, 2)
            z_max = round(min(height_m, (floor_index + 1) * floor_height_m), 2)
            if z_max <= z_min:
                z_max = round(z_min + floor_height_m, 2)

            floor_zones: list[dict[str, Any]] = []
            for zone_name, zone_polygon in zone_polygons.items():
                zone_id = f'{building_id}:L{floor_index + 1}:{zone_name}'
                surfaces = _build_floor_and_roof_surfaces(building_id, zone_id, zone_polygon, z_min, z_max)
                surfaces.extend(_build_wall_surfaces(building_id, zone_id, zone_polygon, z_min, z_max, surface_type='wall'))
                window_surfaces = build_window_geometry(surfaces, archetype=archetype)
                floor_zones.append({
                    'zone_id': zone_id,
                    'zone_name': zone_name,
                    'z_min': z_min,
                    'z_max': z_max,
                    'footprint': mapping(zone_polygon),
                    'surfaces': surfaces,
                    'window_surfaces': window_surfaces,
                    'window_count': len(window_surfaces),
                    'window_to_wall_ratio': round(window_to_wall_ratio, 3),
                })
                building_surface_count += len(surfaces)
                building_zone_count += 1
                building_window_count += len(window_surfaces)

            floors.append({
                'floor_index': floor_index + 1,
                'z_min': z_min,
                'z_max': z_max,
                'zones': floor_zones,
            })

        result['buildings'].append({
            'building_id': _string_id(building_id),
            'archetype': archetype,
            'window_to_wall_ratio': round(window_to_wall_ratio, 3),
            'height_m': round(height_m, 2),
            'floor_height_m': round(floor_height_m, 2),
            'footprint': mapping(footprint),
            'floors': floors,
            'surface_count': building_surface_count,
            'zone_count': building_zone_count,
            'window_count': building_window_count,
        })
        result['surface_count'] += building_surface_count
        result['zone_count'] += building_zone_count
        result['floor_count'] += floor_count
        result['window_count'] += building_window_count

    return result


def _build_shading_building_entry(building_id: str, polygon: Polygon, height_m: float, source: str = 'context') -> dict[str, Any]:
    shade_id = f'{_string_id(building_id)}:shade'
    surfaces = _build_wall_surfaces(_string_id(building_id), shade_id, polygon, 0.0, height_m, surface_type='shading_wall')
    surfaces.append({
        'surface_id': f'{shade_id}:shading_roof',
        'building_id': _string_id(building_id),
        'zone_id': shade_id,
        'surface_type': 'shading_roof',
        'vertices': _ring_to_vertices(list(polygon.exterior.coords), height_m),
    })

    return {
        'building_id': _string_id(building_id),
        'height_m': round(height_m, 2),
        'footprint': mapping(polygon),
        'surfaces': surfaces,
        'source': source,
    }


def build_target_neighbor_shading_geometry(
    target_geometry: dict[str, Any],
    *,
    exclude_building_id: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        'source_path': target_geometry.get('source_path'),
        'shading_buildings': [],
        'missing_ids': [],
        'surface_count': 0,
    }
    excluded_id = _string_id(exclude_building_id)

    for building in target_geometry.get('buildings', []):
        building_id = _string_id(building.get('building_id'))
        if not building_id or building_id == excluded_id:
            continue

        footprint_geometry = building.get('footprint') or {}
        try:
            polygon = _simplify_context_polygon(_get_primary_polygon({'geometry': footprint_geometry}))
        except Exception:
            result['missing_ids'].append(building_id)
            continue

        height_m = _safe_float(building.get('height_m')) or 12.0
        shading_building = _build_shading_building_entry(building_id, polygon, height_m, source='other_target')
        result['shading_buildings'].append(shading_building)
        result['surface_count'] += len(shading_building.get('surfaces', []))

    return result


def merge_shading_geometries(*shading_geometries: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {
        'source_path': None,
        'shading_buildings': [],
        'missing_ids': [],
        'surface_count': 0,
    }
    seen_building_ids: set[str] = set()

    for shading_geometry in shading_geometries:
        if not shading_geometry:
            continue

        if not result['source_path']:
            result['source_path'] = shading_geometry.get('source_path')

        for missing_id in shading_geometry.get('missing_ids', []):
            normalized_id = _string_id(missing_id)
            if normalized_id and normalized_id not in result['missing_ids']:
                result['missing_ids'].append(normalized_id)

        for shading_building in shading_geometry.get('shading_buildings', []):
            building_id = _string_id(shading_building.get('building_id'))
            if not building_id or building_id in seen_building_ids:
                continue

            result['shading_buildings'].append(shading_building)
            result['surface_count'] += len(shading_building.get('surfaces', []))
            seen_building_ids.add(building_id)

    return result


def build_context_shading_geometry(
    building_ids: list[str],
    *,
    geojson_path: str | None = None,
    building_details: list[Any] | None = None,
    default_height_m: float = 12.0,
) -> dict[str, Any]:
    resolved_geojson_path = str(resolve_building_library_path(geojson_path))
    _, feature_index, source_path = load_building_library(resolved_geojson_path)
    details_index = _build_details_index(building_details)

    result: dict[str, Any] = {
        'source_path': source_path,
        'shading_buildings': [],
        'missing_ids': [],
        'surface_count': 0,
    }

    for building_id in building_ids:
        feature = _resolve_feature(building_id, feature_index)
        if not feature:
            result['missing_ids'].append(_string_id(building_id))
            continue

        detail = details_index.get(_string_id(building_id))
        polygon = _simplify_context_polygon(_get_primary_polygon(feature))
        height_m = _get_height_m(feature, detail=detail, default_height_m=default_height_m)
        shading_building = _build_shading_building_entry(_string_id(building_id), polygon, height_m, source='context')

        result['shading_buildings'].append(shading_building)
        result['surface_count'] += len(shading_building.get('surfaces', []))

    return result


__all__ = [
    'build_context_shading_geometry',
    'build_target_building_geometry',
    'build_target_neighbor_shading_geometry',
    'build_window_geometry',
    'get_archetype_window_to_wall_ratio',
    'load_building_library',
    'merge_shading_geometries',
    'resolve_building_library_path',
]
