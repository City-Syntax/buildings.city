# ML Service

This service trains a random-forest archetype classifier from the labeled features already present in a user GeoJSON file and predicts archetypes for features whose `building_archetype` is unknown.

Backend entry path remains unchanged:

- `POST /predict-archetypes`
- `POST /predict-archetypes/jobs`
- `GET /predict-archetypes/jobs/{job_id}`

The model implementation now lives in `app/random_forest_model.py`, while `app/main.py` stays responsible only for FastAPI request handling and job orchestration.

## Model setup

- Features derived from geometry only: `perimeter`, `aspect_ratio`, `compactness_ratio`, `convexity_ratio`, `building_footprint`
- Resampling: dynamic `SMOTE`
- Large classes remain unchanged
- Smaller classes are oversampled more aggressively
- No class is oversampled beyond `10x` its original count
- Random forest hyperparameters: `n_estimators=500`, `max_depth=20`, `min_samples_split=10`, `min_samples_leaf=4`

## API

### `POST /predict-archetypes`

Request body:

```json
{
  "geojson": { "type": "FeatureCollection", "features": [] },
  "archetype_property": "building_archetype",
  "unknown_values": ["unknown", "Unknown", "UNKNOWN", "", "null", "None"],
  "test_size": 0.2,
  "random_state": 42,
  "n_estimators": 500
}
```

Response body contains:

- `metrics`: accuracy, train/test sizes, class distribution, classification report, confusion matrix
- `predictions`: one record per formerly unknown feature with predicted class and probability
- `feature_importance`: random-forest feature importances for the geometry feature set
- `geojson`: updated FeatureCollection with predicted archetypes written back into `building_archetype`

## Run locally

Recommended from the repository root:

```bash
npm run ml:start
```

This bootstraps `.venv`, installs Python dependencies, and starts the FastAPI service on `http://localhost:8000`.

Manual option:

```bash
cd ml-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The frontend can then call `http://localhost:8000/predict-archetypes`.