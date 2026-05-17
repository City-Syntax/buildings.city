from __future__ import annotations

import json
import os
import subprocess
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from .idf_writer import DEFAULT_EPW_PATH, resolve_epw_path
from .results_parser import aggregate_batch_metrics, parse_run_results

DEFAULT_TIMEOUT_SECONDS = int(os.getenv('ENERGYPLUS_TIMEOUT_SECONDS', '3600'))
DEFAULT_MAX_WORKERS = int(os.getenv('ENERGYPLUS_MAX_WORKERS', '3'))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dbg(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime('%H:%M:%S.%f')[:-3]
    print(f'[EPW {ts}] {msg}', flush=True)


@lru_cache(maxsize=4)
def resolve_energyplus_executable(executable_path: str | None = None) -> Path:
    candidates: list[Path] = []

    if executable_path:
        candidates.append(Path(executable_path))

    for env_name in ('ENERGYPLUS_EXE', 'EPLUS_EXE', 'ENERGYPLUS_BIN'):
        env_value = os.getenv(env_name)
        if env_value:
            candidates.append(Path(env_value))

    for env_name in ('ENERGYPLUS_HOME', 'ENERGYPLUS_ROOT'):
        env_value = os.getenv(env_name)
        if env_value:
            home = Path(env_value)
            candidates.extend([
                home / 'energyplus.exe',
                home / 'energyplus',
                home / 'RunEnergyPlus.bat',
            ])

    system_drive = os.getenv('SystemDrive', 'C:')
    try:
        candidates.extend(sorted(Path(f'{system_drive}/').glob('EnergyPlusV*/energyplus.exe'), reverse=True))
        candidates.extend(sorted(Path(f'{system_drive}/').glob('EnergyPlusV*/RunEnergyPlus.bat'), reverse=True))
    except OSError:
        pass

    for candidate in candidates:
        resolved = Path(candidate).expanduser()
        if resolved.exists():
            return resolved.resolve()

    raise FileNotFoundError(
        'EnergyPlus executable was not found. Set `ENERGYPLUS_EXE` or `ENERGYPLUS_HOME`, or install EnergyPlus on this machine.'
    )


def _read_text_snippet(file_path: Path, max_chars: int = 4000) -> str:
    if not file_path.exists():
        return ''

    try:
        text = file_path.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return ''

    return text[-max_chars:]




def _read_full_text(file_path: Path) -> str:
    if not file_path.exists():
        return ''
    try:
        return file_path.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return ''


def _extract_err_blocks(
    text: str,
    *,
    keywords: tuple[str, ...] = ('**  Fatal  **', '** Fatal **', 'Fatal error -- final processing'),
    context: int = 10,
    max_blocks: int = 20,
) -> str:
    """Return context blocks around important EnergyPlus .err lines.

    EnergyPlus often writes the real fatal/severe cause in the middle of eplusout.err,
    while the head/tail only show summaries. This helper extracts the actual blocks.
    """
    lines = text.splitlines()
    blocks: list[str] = []
    seen_ranges: set[tuple[int, int]] = set()

    for index, line in enumerate(lines):
        if not any(keyword in line for keyword in keywords):
            continue

        start = max(0, index - context)
        end = min(len(lines), index + context + 1)
        key = (start, end)
        if key in seen_ranges:
            continue

        seen_ranges.add(key)
        blocks.append('\n'.join(lines[start:end]))
        if len(blocks) >= max_blocks:
            break

    return '\n\n---\n\n'.join(blocks)


def _extract_severe_blocks(text: str, *, context: int = 5, max_blocks: int = 30) -> str:
    return _extract_err_blocks(
        text,
        keywords=('** Severe  **', '** Severe **'),
        context=context,
        max_blocks=max_blocks,
    )


def run_idf_case(
    run_item: dict[str, Any],
    *,
    energyplus_exe: str | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    building_id = str(run_item.get('building_id', 'unknown'))
    job_id = str(run_item.get('job_id', ''))
    started_at = utc_now_iso()
    geometry_json_path = str(run_item.get('geometry_json_path') or '')
    gross_floor_area_m2 = run_item.get('gross_floor_area_m2')

    idf_path = Path(str(run_item.get('idf_path', ''))).expanduser().resolve()
    if not idf_path.exists():
        return {
            'job_id': job_id,
            'building_id': building_id,
            'status': 'failed',
            'started_at': started_at,
            'completed_at': utc_now_iso(),
            'geometry_json_path': geometry_json_path,
            'gross_floor_area_m2': gross_floor_area_m2,
            'error': f'IDF file not found: {idf_path}',
        }

    output_dir = Path(str(run_item.get('output_dir') or (idf_path.parent / 'energyplus-output'))).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        epw_path = resolve_epw_path(run_item.get('epw_path') or str(DEFAULT_EPW_PATH))
        executable = resolve_energyplus_executable(energyplus_exe)
    except Exception as error:
        return {
            'job_id': job_id,
            'building_id': building_id,
            'status': 'failed',
            'started_at': started_at,
            'completed_at': utc_now_iso(),
            'idf_path': str(idf_path),
            'output_dir': str(output_dir),
            'geometry_json_path': geometry_json_path,
            'gross_floor_area_m2': gross_floor_area_m2,
            'error': str(error),
        }

    command = [str(executable)]
    if executable.name.lower().endswith('.bat'):
        command.extend([str(idf_path), str(epw_path), 'idf', str(output_dir), 'N', 'nolimit'])
    else:
        command.extend(['-x', '-w', str(epw_path), '-d', str(output_dir), '-r', str(idf_path)])

    # Redirect stdout/stderr to log files instead of capturing via pipes.
    # capture_output=True on Windows spawns reader threads per process; with 3+ concurrent
    # EnergyPlus runs this causes GIL contention and can deadlock when the timeout fires
    # (Python calls communicate() again after kill() to drain pipes, blocking for minutes).
    stdout_log = output_dir / 'eplusout.stdout'
    stderr_log = output_dir / 'eplusout.stderr'

    _dbg(f'[{job_id[:8]}] [{building_id}] launching EnergyPlus: {" ".join(command[:3])} ...')
    _dbg(f'[{job_id[:8]}] [{building_id}]   idf={idf_path}')
    _dbg(f'[{job_id[:8]}] [{building_id}]   output_dir={output_dir}')
    t_proc = time.monotonic()
    return_code: int | None = None
    stdout_tail = ''
    stderr_tail = ''
    timed_out = False

    try:
        with (
            open(str(stdout_log), 'w', encoding='utf-8', errors='ignore') as _fout,
            open(str(stderr_log), 'w', encoding='utf-8', errors='ignore') as _ferr,
        ):
            proc = subprocess.Popen(
                command,
                cwd=str(output_dir),
                stdout=_fout,
                stderr=_ferr,
            )
            _dbg(f'[{job_id[:8]}] [{building_id}] EnergyPlus PID={proc.pid} — process started')

            deadline = time.monotonic() + timeout_seconds
            last_heartbeat = time.monotonic()

            while True:
                rc = proc.poll()
                if rc is not None:
                    return_code = rc
                    break
                now = time.monotonic()
                if now >= deadline:
                    _dbg(f'[{job_id[:8]}] [{building_id}] EnergyPlus PID={proc.pid} TIMEOUT after {now-t_proc:.0f}s — killing process')
                    proc.kill()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
                    timed_out = True
                    break
                if now - last_heartbeat >= 30:
                    remaining = deadline - now
                    _dbg(f'[{job_id[:8]}] [{building_id}] EnergyPlus PID={proc.pid} still running — {now-t_proc:.0f}s elapsed, {remaining:.0f}s remaining')
                    last_heartbeat = now
                time.sleep(1)

        stdout_tail = _read_text_snippet(stdout_log)
        stderr_tail = _read_text_snippet(stderr_log)

        if timed_out:
            return {
                'job_id': job_id,
                'building_id': building_id,
                'status': 'failed',
                'started_at': started_at,
                'completed_at': utc_now_iso(),
                'idf_path': str(idf_path),
                'output_dir': str(output_dir),
                'epw_path': str(epw_path),
                'geometry_json_path': geometry_json_path,
                'gross_floor_area_m2': gross_floor_area_m2,
                'command': command,
                'error': f'EnergyPlus timed out after {timeout_seconds}s.',
                'stdout_tail': stdout_tail,
                'stderr_tail': stderr_tail,
            }

        _dbg(f'[{job_id[:8]}] [{building_id}] EnergyPlus finished in {time.monotonic()-t_proc:.2f}s — return_code={return_code}')

        # On Windows, EnergyPlus can hold a lock on eplusout.sql briefly after the process exits.
        # Poll until the file is writable (no lock) before returning, so the caller can clean up.
        sql_lock_path = output_dir / 'eplusout.sql'
        if sql_lock_path.exists():
            _dbg(f'[{job_id[:8]}] [{building_id}] polling SQL lock on {sql_lock_path.name} ...')
            for poll_attempt in range(20):
                try:
                    with open(str(sql_lock_path), 'ab'):
                        _dbg(f'[{job_id[:8]}] [{building_id}] SQL lock released after {poll_attempt} poll(s)')
                        break
                except OSError:
                    _dbg(f'[{job_id[:8]}] [{building_id}] SQL still locked (poll {poll_attempt+1}/20) — waiting 0.5s')
                    time.sleep(0.5)
        else:
            _dbg(f'[{job_id[:8]}] [{building_id}] eplusout.sql not found — EnergyPlus may have failed early')
            time.sleep(0.5)

    except Exception as exc:
        _dbg(f'[{job_id[:8]}] [{building_id}] run_idf_case EXCEPTION: {type(exc).__name__}: {exc}')
        return {
            'job_id': job_id,
            'building_id': building_id,
            'status': 'failed',
            'started_at': started_at,
            'completed_at': utc_now_iso(),
            'idf_path': str(idf_path),
            'output_dir': str(output_dir),
            'geometry_json_path': geometry_json_path,
            'gross_floor_area_m2': gross_floor_area_m2,
            'command': command,
            'error': f'{type(exc).__name__}: {exc}',
            'stdout_tail': _read_text_snippet(stdout_log) if stdout_log.exists() else '',
            'stderr_tail': _read_text_snippet(stderr_log) if stderr_log.exists() else '',
        }

    end_file = output_dir / 'eplusout.end'
    err_file = output_dir / 'eplusout.err'
    sql_file = output_dir / 'eplusout.sql'
    csv_file = output_dir / 'eplusout.csv'
    html_file = output_dir / 'eplustbl.htm'

    full_err_text = _read_full_text(err_file)
    error_snippet = full_err_text[-4000:] if full_err_text else ''
    end_snippet = _read_text_snippet(end_file)
    fatal_in_err = 'fatal' in full_err_text.lower()
    success = return_code == 0 and not fatal_in_err

    _dbg(f'[{job_id[:8]}] [{building_id}] artifacts — sql={sql_file.exists()} csv={csv_file.exists()} end={end_file.exists()}')
    _dbg(f'[{job_id[:8]}] [{building_id}] success={success} (rc={return_code} fatal_in_err={fatal_in_err})')
    if full_err_text:
        err_head = full_err_text[:4000]
        err_tail = full_err_text[-1200:]
        fatal_blocks = _extract_err_blocks(full_err_text, context=12, max_blocks=20)
        severe_blocks = _extract_severe_blocks(full_err_text, context=6, max_blocks=30)

        _dbg(f'[{job_id[:8]}] [{building_id}] .err head:\n{err_head.strip()}')
        if fatal_blocks:
            _dbg(f'[{job_id[:8]}] [{building_id}] .err FATAL BLOCKS:\n{fatal_blocks.strip()}')
        if severe_blocks:
            _dbg(f'[{job_id[:8]}] [{building_id}] .err SEVERE BLOCKS:\n{severe_blocks.strip()}')
        _dbg(f'[{job_id[:8]}] [{building_id}] .err tail:\n{err_tail.strip()}')

    result = {
        'job_id': job_id,
        'building_id': building_id,
        'archetype': run_item.get('archetype'),
        'template_path': run_item.get('template_path'),
        'status': 'completed' if success else 'failed',
        'started_at': started_at,
        'completed_at': utc_now_iso(),
        'idf_path': str(idf_path),
        'output_dir': str(output_dir),
        'epw_path': str(epw_path),
        'geometry_json_path': geometry_json_path,
        'gross_floor_area_m2': gross_floor_area_m2,
        'energyplus_exe': str(executable),
        'command': command,
        'return_code': return_code,
        'stdout_tail': stdout_tail,
        'stderr_tail': stderr_tail,
        'end_summary': end_snippet,
        'error_summary': error_snippet,
        'artifacts': {
            'sql': str(sql_file) if sql_file.exists() else None,
            'csv': str(csv_file) if csv_file.exists() else None,
            'html': str(html_file) if html_file.exists() else None,
            'err': str(err_file) if err_file.exists() else None,
            'end': str(end_file) if end_file.exists() else None,
        },
    }

    _dbg(f'[{job_id[:8]}] [{building_id}] parsing SQL results ...')
    t_parse = time.monotonic()
    try:
        result['parsed_results'] = parse_run_results(result)
        parsed = result['parsed_results']
        _dbg(f'[{job_id[:8]}] [{building_id}] parse done in {time.monotonic()-t_parse:.2f}s — gfa={parsed.get("gross_floor_area_m2")} sql_freqs={parsed.get("sql_available_frequencies")}')
        metrics = parsed.get('metrics') or {}
        _dbg(f'[{job_id[:8]}] [{building_id}] metrics — total_energy={metrics.get("total_energy_kwh")} total_eui={metrics.get("total_eui_kwh_m2")}')
    except Exception as error:  # pragma: no cover - defensive parsing
        _dbg(f'[{job_id[:8]}] [{building_id}] parse FAILED in {time.monotonic()-t_parse:.2f}s: {error}')
        result['parsed_results'] = {}
        result['parsing_error'] = str(error)

    return result


def summarize_batch_results(payload: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any]:
    completed_runs = [item for item in results if item.get('status') == 'completed']
    failed_runs = [item for item in results if item.get('status') != 'completed']

    if completed_runs and failed_runs:
        status = 'partial'
    elif failed_runs:
        status = 'failed'
    else:
        status = 'completed'

    return {
        'job_id': str(payload.get('job_id', '')),
        'status': status,
        'requested_runs': len(payload.get('runs', [])),
        'completed_runs': len(completed_runs),
        'failed_runs': len(failed_runs),
        'epw_path': str(payload.get('epw_path') or DEFAULT_EPW_PATH),
        'aggregated_metrics': aggregate_batch_metrics(results),
        'results': results,
    }


def run_idf_batch(
    payload: dict[str, Any],
    *,
    energyplus_exe: str | None = None,
    max_workers: int | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    on_progress: Any = None,
) -> dict[str, Any]:
    run_items = list(payload.get('runs', []))
    if not run_items:
        return {
            'job_id': str(payload.get('job_id', '')),
            'status': 'failed',
            'requested_runs': 0,
            'completed_runs': 0,
            'failed_runs': 0,
            'epw_path': str(payload.get('epw_path') or DEFAULT_EPW_PATH),
            'results': [],
            'error': 'No run items were provided to eppy_runner.run_idf_batch(payload).',
        }

    total = len(run_items)
    worker_count = max(1, min(total, max_workers or DEFAULT_MAX_WORKERS))
    results: list[dict[str, Any]] = []

    if worker_count == 1:
        for run_item in run_items:
            merged_item = {**run_item, 'epw_path': run_item.get('epw_path') or payload.get('epw_path')}
            results.append(run_idf_case(merged_item, energyplus_exe=energyplus_exe, timeout_seconds=timeout_seconds))
            if callable(on_progress):
                on_progress(len(results), total, str(run_item.get('building_id', '')))
        return summarize_batch_results(payload, results)

    # Heartbeat: call on_progress every 20 s so the UI shows elapsed time even when
    # no futures have completed yet (prevents the job appearing frozen at [0/N]).
    _done_ref = [0]
    _heartbeat_stop = threading.Event()

    def _heartbeat_loop() -> None:
        while not _heartbeat_stop.wait(timeout=5):
            if callable(on_progress) and _done_ref[0] < total:
                try:
                    on_progress(_done_ref[0], total, '__heartbeat__')
                except Exception:
                    pass

    _hb_thread = threading.Thread(target=_heartbeat_loop, daemon=True, name='energyplus-heartbeat')
    _hb_thread.start()

    try:
        with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix='energyplus') as executor:
            future_map = {
                executor.submit(
                    run_idf_case,
                    {**run_item, 'epw_path': run_item.get('epw_path') or payload.get('epw_path')},
                    energyplus_exe=energyplus_exe,
                    timeout_seconds=timeout_seconds,
                ): run_item
                for run_item in run_items
            }

            for future in as_completed(future_map):
                run_item = future_map[future]
                try:
                    results.append(future.result())
                except Exception as error:  # pragma: no cover - defensive aggregation
                    results.append({
                        'job_id': str(run_item.get('job_id', payload.get('job_id', ''))),
                        'building_id': str(run_item.get('building_id', 'unknown')),
                        'status': 'failed',
                        'started_at': utc_now_iso(),
                        'completed_at': utc_now_iso(),
                        'error': str(error),
                    })
                _done_ref[0] = len(results)
                if callable(on_progress):
                    on_progress(len(results), total, str(run_item.get('building_id', '')))
    finally:
        _heartbeat_stop.set()
        _hb_thread.join(timeout=5)

    results.sort(key=lambda item: str(item.get('building_id', '')))
    return summarize_batch_results(payload, results)


def load_runner_request(json_path: str | Path) -> dict[str, Any]:
    path = Path(json_path).expanduser().resolve()
    return json.loads(path.read_text(encoding='utf-8'))

__all__ = [
    'load_runner_request',
    'resolve_energyplus_executable',
    'run_idf_batch',
    'run_idf_case',
    'summarize_batch_results',
]
