from __future__ import annotations

import shutil
import time as _time
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, Thread
from time import sleep
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .eppy_runner import run_idf_batch
from .geometry_service import build_context_shading_geometry, build_target_building_geometry, load_building_library
from .idf_writer import prepare_temporary_idf_batch, resolve_template_for_archetype, submit_to_eppy_runner
from .results_parser import load_hourly_key_outputs, resolve_energy_conversions
from .schemas import HealthResponse, SimulationJobRequest, TemplateSyncRequest
from .template_manager import regenerate_idf_templates, sync_archetype_template

app = FastAPI(title='Buildings.city Simulation Service', version='0.1.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

job_store: dict[str, dict] = {}
job_store_lock = Lock()
SERVICE_ROOT = Path(__file__).resolve().parents[1]
RESULTS_ROOT = SERVICE_ROOT / 'results'


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def update_job(job_id: str, **fields) -> None:
    with job_store_lock:
        job = job_store.get(job_id)
        if not job:
            return
        job.update(fields)
        job['updated_at'] = utc_now_iso()


def build_mock_result(
    request: SimulationJobRequest,
    target_geometry: dict | None = None,
    shading_geometry: dict | None = None,
    idf_prep: dict | None = None,
    runner_result: dict | None = None,
) -> dict:
    target_ids = request.targets.valid_building_ids
    invalid_ids = request.targets.invalid_building_ids
    shading_ids = request.context.shading_building_ids
    target_details = [
        item for item in request.building_details
        if item.building_id in set(target_ids)
    ]

    target_area_m2 = sum((item.footprint_area_m2 or 0.0) for item in target_details)
    if target_area_m2 <= 0:
        target_area_m2 = max(len(target_ids), 1) * 180.0

    average_height_m = (
        sum((item.height_m or 0.0) for item in target_details) / len(target_details)
        if target_details else 12.0
    )

    target_geometry = target_geometry or {}
    shading_geometry = shading_geometry or {}
    idf_prep = idf_prep or {}
    runner_result = runner_result or {}
    aggregated_metrics = runner_result.get('aggregated_metrics') or {}

    area_factor = 1.08 if request.selection.mode == 'circular_cluster' else 1.0
    annual_site_eui = round(76 + min(len(target_ids) * 6.0, 30) + average_height_m * 0.6, 1)
    annual_energy_kwh = round(target_area_m2 * annual_site_eui * area_factor, 1)
    has_parsed_metrics = (
        runner_result.get('completed_runs', 0) > 0
        and float(aggregated_metrics.get('gross_floor_area_m2') or 0) > 0
        and float(aggregated_metrics.get('annual_energy_kwh') or 0) > 0
    )

    metrics = {
        'gross_floor_area_m2': aggregated_metrics.get('gross_floor_area_m2') if has_parsed_metrics else None,
        'total_eui_kwh_m2': aggregated_metrics.get('total_eui_kwh_m2') if has_parsed_metrics else annual_site_eui,
        'annual_site_eui_kwh_m2': aggregated_metrics.get('annual_site_eui_kwh_m2') if has_parsed_metrics else annual_site_eui,
        'total_energy_kwh': aggregated_metrics.get('total_energy_kwh') if has_parsed_metrics else annual_energy_kwh,
        'annual_energy_kwh': aggregated_metrics.get('annual_energy_kwh') if has_parsed_metrics else annual_energy_kwh,
        'cooling_eui_kwh_m2': aggregated_metrics.get('cooling_eui_kwh_m2') if has_parsed_metrics else None,
        'heating_eui_kwh_m2': aggregated_metrics.get('heating_eui_kwh_m2') if has_parsed_metrics else None,
        'lighting_eui_kwh_m2': aggregated_metrics.get('lighting_eui_kwh_m2') if has_parsed_metrics else None,
        'equipment_eui_kwh_m2': aggregated_metrics.get('equipment_eui_kwh_m2') if has_parsed_metrics else None,
        'hot_water_eui_kwh_m2': aggregated_metrics.get('hot_water_eui_kwh_m2') if has_parsed_metrics else None,
        'cooling_energy_kwh': aggregated_metrics.get('cooling_energy_kwh') if has_parsed_metrics else None,
        'heating_energy_kwh': aggregated_metrics.get('heating_energy_kwh') if has_parsed_metrics else None,
        'lighting_energy_kwh': aggregated_metrics.get('lighting_energy_kwh') if has_parsed_metrics else None,
        'equipment_energy_kwh': aggregated_metrics.get('equipment_energy_kwh') if has_parsed_metrics else None,
        'hot_water_energy_kwh': aggregated_metrics.get('hot_water_energy_kwh') if has_parsed_metrics else None,
    }

    resolved_target_ids = [item['building_id'] for item in target_geometry.get('buildings', [])]
    missing_target_ids = target_geometry.get('missing_ids', [])
    missing_shading_ids = shading_geometry.get('missing_ids', [])
    effective_shading_buildings = max(
        (int(bundle.get('shading_building_count', 0)) for bundle in idf_prep.get('bundles', [])),
        default=len(shading_ids),
    )
    other_target_shading_buildings = max(effective_shading_buildings - len(shading_ids), 0)

    first_run = next(iter(runner_result.get('results') or []), {})
    first_parsed = first_run.get('parsed_results') or {}
    sql_frequencies = first_parsed.get('sql_available_frequencies') or []
    first_run_error = first_run.get('error') or ''
    first_return_code = first_run.get('return_code')

    notes = [
        'Annual EnergyPlus outputs were parsed from the simulation artifacts.' if has_parsed_metrics else 'Mock fallback metrics are shown because parsed annual EnergyPlus outputs are not available yet.',
        'Target and context geometry are now resolved server-side from the GeoJSON library by building_id.',
        'For each per-building run, all other selected targets are also added as shading sources alongside the context buildings.',
        f"EnergyPlus runner status: {runner_result.get('status', 'not-run')} | return_code: {first_return_code}",
        f"Result source: {'parsed annual EnergyPlus outputs' if has_parsed_metrics else 'mock fallback metrics'}",
        f"SQL reporting frequencies found: {sql_frequencies or 'none — SQL may be missing, empty, or meter frequency not supported'}",
        *(([f'First run error: {first_run_error}']) if first_run_error else []),
    ]

    if missing_target_ids:
        notes.append(f'Missing target geometry ids: {", ".join(missing_target_ids[:10])}')
    if missing_shading_ids:
        notes.append(f'Missing shading geometry ids: {", ".join(missing_shading_ids[:10])}')

    return {
        'engine': 'energyplus-eppy-annual' if has_parsed_metrics else 'mock-eppy-energyplus-preview',
        'summary': {
            'mode': request.selection.mode,
            'target_radius_m': request.selection.target_radius_m,
            'context_radius_m': request.selection.context_radius_m,
            'target_buildings': len(target_ids),
            'invalid_targets': len(invalid_ids),
            'shading_buildings': effective_shading_buildings,
            'other_target_shading_buildings': other_target_shading_buildings,
            'resolved_target_geometry': len(resolved_target_ids),
            'missing_target_geometry': len(missing_target_ids),
            'missing_shading_geometry': len(missing_shading_ids),
            'target_floor_count': target_geometry.get('floor_count', 0),
            'target_zone_count': target_geometry.get('zone_count', 0),
            'target_surface_count': target_geometry.get('surface_count', 0),
            'shading_surface_count': shading_geometry.get('surface_count', 0),
            'idf_bundle_count': idf_prep.get('bundle_count', 0),
            'idf_template_count': len(idf_prep.get('templates_used', [])),
            'runner_status': runner_result.get('status', 'not-run'),
            'runner_completed_runs': runner_result.get('completed_runs', 0),
            'runner_failed_runs': runner_result.get('failed_runs', 0),
            'eui_source': 'energyplus_annual_outputs' if has_parsed_metrics else 'mock_fallback',
            'geometry_mode': request.simulation_settings.geometry_mode,
            'zoning_mode': request.simulation_settings.zoning_mode,
        },
        'metrics': metrics,
        'artifacts': {
            'result_field_name': 'simulation_mock_summary',
            'save_strategy': 'append-to-geojson-or-export-new-geojson',
            'geometry_lookup': 'backend_lookup_by_building_id',
            'geometry_source_path': target_geometry.get('source_path') or shading_geometry.get('source_path'),
            'resolved_target_ids': resolved_target_ids,
            'idf_generation': {
                'idf_library_path': idf_prep.get('idf_library_path'),
                'templates_used': idf_prep.get('templates_used', []),
                'temp_file_strategy': idf_prep.get('temp_file_strategy'),
                'temporary_files_cleaned': True,
                'building_ids': idf_prep.get('building_ids', []),
            },
            'runner_result': runner_result,
        },
        'notes': notes,
    }


def _safe_artifact_token(value: object) -> str:
    token = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in str(value or '').strip())
    return token.strip('._') or 'building'


def persist_runner_sql_artifacts(job_id: str, runner_result: dict | None) -> dict:
    if not isinstance(runner_result, dict):
        return runner_result or {}

    persisted_dir = RESULTS_ROOT / _safe_artifact_token(job_id)
    persisted_dir.mkdir(parents=True, exist_ok=True)

    for run in runner_result.get('results') or []:
        artifacts = run.get('artifacts') or {}
        sql_path = artifacts.get('sql')
        if not sql_path:
            continue

        source = Path(sql_path)
        if not source.exists():
            continue

        building_id = _safe_artifact_token(run.get('building_id'))
        target_dir = persisted_dir / building_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target_sql = target_dir / 'eplusout.sql'
        shutil.copy2(source, target_sql)
        artifacts['sql'] = str(target_sql)
        artifacts['sql_persisted'] = True
        run['artifacts'] = artifacts

    runner_result['persisted_artifacts_dir'] = str(persisted_dir)
    return runner_result


def find_job_building_run(job_id: str, building_id: str) -> dict | None:
    with job_store_lock:
        job = job_store.get(job_id)

    persisted_sql = RESULTS_ROOT / _safe_artifact_token(job_id) / _safe_artifact_token(building_id) / 'eplusout.sql'
    if not job:
        if persisted_sql.exists():
            return {
                'building_id': str(building_id),
                'status': 'completed',
                'artifacts': {
                    'sql': str(persisted_sql),
                    'sql_persisted': True,
                },
            }
        return None

    target_id = str(building_id)
    results = (((job.get('result') or {}).get('artifacts') or {}).get('runner_result') or {}).get('results') or []
    for run in results:
        if str(run.get('building_id')) == target_id:
            return run

    if persisted_sql.exists():
        return {
            'building_id': target_id,
            'status': 'completed',
            'artifacts': {
                'sql': str(persisted_sql),
                'sql_persisted': True,
            },
        }
    return None


def _dbg(job_id: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime('%H:%M:%S.%f')[:-3]
    print(f'[SIM {ts}] [{job_id[:8]}] {msg}', flush=True)


def run_simulation_job(job_id: str, request: SimulationJobRequest) -> None:
    t0 = _time.monotonic()
    _dbg(job_id, f'job started — targets={len(request.targets.valid_building_ids)} shading={len(request.context.shading_building_ids)}')
    try:
        update_job(job_id, status='running', stage='resolve_target_geometry', progress=15, message='Resolving target geometry from backend GeoJSON library')
        _dbg(job_id, 'stage: resolve_target_geometry')
        t1 = _time.monotonic()
        target_geometry = build_target_building_geometry(
            request.targets.valid_building_ids,
            building_details=request.building_details,
            floor_height_m=request.simulation_settings.floor_height_m,
            geometry_mode=request.simulation_settings.geometry_mode,
            zoning_mode=request.simulation_settings.zoning_mode,
        )
        _dbg(job_id, f'target geometry done in {_time.monotonic()-t1:.2f}s — buildings={len(target_geometry.get("buildings", []))} missing={len(target_geometry.get("missing_ids", []))}')
        if not target_geometry.get('buildings'):
            missing_ids = ', '.join(target_geometry.get('missing_ids', [])[:10]) or '(none)'
            source_path = target_geometry.get('source_path') or 'unknown'
            raise ValueError(
                'No target geometry could be resolved from the backend GeoJSON library for the submitted building ids. '
                f'Backend source: {source_path}. Missing ids: {missing_ids}. '
                'This usually means the frontend and backend are pointing at different GeoJSON files.'
            )

        sleep(0.2)
        update_job(job_id, stage='resolve_context_shading', progress=30, message='Building context shading surfaces from backend GeoJSON')
        _dbg(job_id, 'stage: resolve_context_shading')
        t2 = _time.monotonic()
        shading_geometry = build_context_shading_geometry(
            request.context.shading_building_ids,
            building_details=request.building_details,
        )
        _dbg(job_id, f'shading geometry done in {_time.monotonic()-t2:.2f}s — shading_buildings={len(shading_geometry.get("shading_buildings", []))}')

        total_targets = len(request.targets.valid_building_ids)

        def on_idf_progress(done: int, total: int, building_id: str) -> None:
            pct = 48 + round(done / total * 20) if total > 0 else 68
            update_job(job_id, stage='prepare_idf', progress=pct,
                       message=f'Preparing IDF files [{done}/{total} targets]')
            _dbg(job_id, f'IDF prep {done}/{total} — {building_id}')

        _ep_dot_tick = [0]
        _DOT_FRAMES = [' .', ' ..', ' ...', ' ..']

        def on_run_progress(done: int, total: int, building_id: str) -> None:
            _ep_dot_tick[0] += 1
            dots = _DOT_FRAMES[_ep_dot_tick[0] % len(_DOT_FRAMES)]
            pct = 70 + round(done / total * 29) if total > 0 else 99
            update_job(job_id, stage='run_energyplus', progress=pct,
                       message=f'Running EnergyPlus [{done}/{total} targets]{dots}')
            if building_id != '__heartbeat__':
                _dbg(job_id, f'EnergyPlus run {done}/{total} — {building_id}')

        sleep(0.2)
        update_job(job_id, stage='prepare_idf', progress=48,
                   message=f'Preparing IDF files [0/{total_targets} targets]')
        _dbg(job_id, 'stage: prepare_idf — entering prepare_temporary_idf_batch context')
        t3 = _time.monotonic()
        with prepare_temporary_idf_batch(
            job_id=job_id,
            target_geometry=target_geometry,
            shading_geometry=shading_geometry,
            building_details=request.building_details,
            on_progress=on_idf_progress,
        ) as idf_prep:
            _dbg(job_id, f'IDF prep done in {_time.monotonic()-t3:.2f}s — bundles={len(idf_prep.get("bundles", []))}')
            if not idf_prep.get('bundles'):
                raise ValueError('No temporary IDF bundle could be prepared for the resolved target buildings.')

            for i, bundle in enumerate(idf_prep.get('bundles', [])):
                _dbg(job_id, f'  bundle[{i}] building={bundle.get("building_id")} eppy_prepared={bundle.get("eppy_prepared")} idf={bundle.get("idf_path")} eppy_error={bundle.get("eppy_error")}')

            sleep(0.2)
            update_job(job_id, stage='run_energyplus', progress=70,
                       message=f'Running EnergyPlus [0/{total_targets} targets]')
            _dbg(job_id, 'stage: run_energyplus — calling submit_to_eppy_runner')
            t4 = _time.monotonic()
            runner_result = submit_to_eppy_runner(
                job_id=job_id,
                runtime_bundles=idf_prep.get('bundles', []),
                runner=run_idf_batch,
                on_progress=on_run_progress,
            )
            _dbg(job_id, f'EnergyPlus runner done in {_time.monotonic()-t4:.2f}s — status={runner_result.get("status")} completed={runner_result.get("completed_runs")} failed={runner_result.get("failed_runs")}')
            runner_result = persist_runner_sql_artifacts(job_id, runner_result)
            result = build_mock_result(
                request,
                target_geometry=target_geometry,
                shading_geometry=shading_geometry,
                idf_prep=idf_prep,
                runner_result=runner_result,
            )

        _dbg(job_id, f'cleanup done — total elapsed {_time.monotonic()-t0:.2f}s')
        update_job(job_id, status='completed', stage='completed', progress=100, message='Mock simulation completed', result=result)
    except Exception as error:
        _dbg(job_id, f'FAILED after {_time.monotonic()-t0:.2f}s — {type(error).__name__}: {error}')
        update_job(job_id, status='failed', stage='failed', progress=100, message='Unexpected simulation service error', error=str(error))


@app.get('/health', response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status='ok')


@app.post('/building-library/reload')
def reload_building_library() -> dict:
    load_building_library.cache_clear()
    features, _, source_path = load_building_library()
    return {
        'status': 'ok',
        'source_path': source_path,
        'feature_count': len(features),
    }


@app.post('/idf-templates/regenerate')
def regenerate_templates() -> dict:
    try:
        return regenerate_idf_templates()
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post('/idf-templates/sync')
def sync_template(request: TemplateSyncRequest) -> dict:
    try:
        return sync_archetype_template(
            request.archetype,
            request.simulation_parameters,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.get('/idf-templates/file/{archetype}')
def get_idf_template_file(archetype: str):
    try:
        template_path = resolve_template_for_archetype(archetype)
    except Exception as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return FileResponse(
        path=str(template_path),
        media_type='text/plain',
        filename=f'{template_path.stem}.idf',
    )


@app.post('/simulation-jobs')
def create_simulation_job(request: SimulationJobRequest) -> dict:
    if not request.targets.valid_building_ids:
        raise HTTPException(status_code=400, detail='Simulation job requires at least one valid target building.')

    job_id = str(uuid4())
    with job_store_lock:
        job_store[job_id] = {
            'job_id': job_id,
            'job_type': 'building_energy_simulation',
            'status': 'queued',
            'stage': 'queued',
            'progress': 8,
            'message': 'Simulation job queued',
            'error': None,
            'result': None,
            'submitted_payload': request.model_dump(),
            'created_at': utc_now_iso(),
            'updated_at': utc_now_iso(),
        }

    Thread(target=run_simulation_job, args=(job_id, request), daemon=True).start()

    return {
        'job_id': job_id,
        'job_type': 'building_energy_simulation',
        'status': 'queued',
        'stage': 'queued',
        'progress': 8,
        'message': 'Simulation job queued',
    }


@app.get('/simulation-jobs/{job_id}')
def get_simulation_job(job_id: str) -> dict:
    with job_store_lock:
        job = job_store.get(job_id)

    if not job:
        raise HTTPException(status_code=404, detail='Simulation job not found')

    return job


@app.get('/simulation-jobs/{job_id}/buildings/{building_id}/sql')
def download_building_sql(job_id: str, building_id: str):
    run = find_job_building_run(job_id, building_id)
    if not run:
        raise HTTPException(status_code=404, detail='Building run not found for this simulation job')

    sql_path = (run.get('artifacts') or {}).get('sql')
    if not sql_path:
        raise HTTPException(status_code=404, detail='SQL artifact is not available for this building')

    path = Path(sql_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail='SQL artifact file is no longer available')

    return FileResponse(
        path=str(path),
        media_type='application/vnd.sqlite3',
        filename=f'{_safe_artifact_token(building_id)}_eplusout.sql',
    )


@app.get('/simulation-jobs/{job_id}/building-sql')
def download_building_sql_by_query(job_id: str, building_id: str):
    return download_building_sql(job_id, building_id)


@app.get('/simulation-jobs/{job_id}/buildings/{building_id}/hourly')
def get_building_hourly_outputs(job_id: str, building_id: str) -> dict:
    run = find_job_building_run(job_id, building_id)
    if not run:
        raise HTTPException(status_code=404, detail='Building run not found for this simulation job')

    sql_path = (run.get('artifacts') or {}).get('sql')
    if not sql_path:
        raise HTTPException(status_code=404, detail='SQL artifact is not available for this building')

    return {
        'job_id': job_id,
        'building_id': building_id,
        **load_hourly_key_outputs(sql_path, resolve_energy_conversions(run)),
    }


@app.get('/simulation-jobs/{job_id}/building-hourly')
def get_building_hourly_outputs_by_query(job_id: str, building_id: str) -> dict:
    return get_building_hourly_outputs(job_id, building_id)
