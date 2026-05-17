from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PredictArchetypesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    geojson: dict[str, Any] = Field(..., description="Input GeoJSON FeatureCollection")
    archetype_property: str = Field(default="building_archetype")
    height_property: str = Field(default="height")
    confidence_threshold: float = Field(default=0.2, ge=0.0, le=1.0)
    feature_names: list[str] | None = Field(default=None)
    smote_max_multiplier: float = Field(default=10.0, ge=1.0, le=30.0)
    smote_majority_boost: float = Field(default=1.0, ge=0.1, le=2.0)
    unknown_values: list[str] = Field(default_factory=lambda: ["unknown", "Unknown", "UNKNOWN", "", "null", "None"])
    test_size: float = Field(default=0.2, ge=0.05, le=0.5)
    random_state: int = Field(default=42)
    n_estimators: int = Field(default=500, ge=50, le=2000)


class HealthResponse(BaseModel):
    status: str
