from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock, Thread
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .random_forest_model import predict_archetypes
from .schemas import HealthResponse, PredictArchetypesRequest

app = FastAPI(title="Buildings.city ML Service", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

job_store: dict[str, dict] = {}
job_store_lock = Lock()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def update_job(job_id: str, **fields) -> None:
    with job_store_lock:
        job = job_store.get(job_id)
        if not job:
            return
        job.update(fields)
        job["updated_at"] = utc_now_iso()


def run_prediction_job(job_id: str, request: PredictArchetypesRequest) -> None:
    def progress_callback(stage: str, progress: int, message: str) -> None:
        update_job(job_id, stage=stage, progress=progress, message=message)

    try:
        update_job(job_id, status="running", stage="starting", progress=32, message="Starting prediction job")
        result = predict_archetypes(
            geojson=request.geojson,
            archetype_property=request.archetype_property,
            height_property=request.height_property,
            confidence_threshold=request.confidence_threshold,
            unknown_values=set(request.unknown_values),
            test_size=request.test_size,
            random_state=request.random_state,
            n_estimators=request.n_estimators,
            progress_callback=progress_callback,
        )
        update_job(job_id, status="completed", stage="completed", progress=100, message="Prediction completed", result=result)
    except ValueError as error:
        update_job(job_id, status="failed", stage="failed", progress=100, message=str(error), error=str(error))
    except Exception as error:
        update_job(job_id, status="failed", stage="failed", progress=100, message="Unexpected server error", error=str(error))


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/predict-archetypes")
def predict(request: PredictArchetypesRequest) -> dict:
    try:
        return predict_archetypes(
            geojson=request.geojson,
            archetype_property=request.archetype_property,
            height_property=request.height_property,
            confidence_threshold=request.confidence_threshold,
            unknown_values=set(request.unknown_values),
            test_size=request.test_size,
            random_state=request.random_state,
            n_estimators=request.n_estimators,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/predict-archetypes/jobs")
def create_prediction_job(request: PredictArchetypesRequest) -> dict:
    job_id = str(uuid4())
    with job_store_lock:
        job_store[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "stage": "queued",
            "progress": 28,
            "message": "Job queued",
            "error": None,
            "result": None,
            "created_at": utc_now_iso(),
            "updated_at": utc_now_iso(),
        }

    Thread(target=run_prediction_job, args=(job_id, request), daemon=True).start()

    return {
        "job_id": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": 28,
        "message": "Job queued",
    }


@app.get("/predict-archetypes/jobs/{job_id}")
def get_prediction_job(job_id: str) -> dict:
    with job_store_lock:
        job = job_store.get(job_id)

    if not job:
        raise HTTPException(status_code=404, detail="Prediction job not found")

    return job