from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PredictArchetypesRequest(BaseModel):
    geojson: dict[str, Any] = Field(..., description="Input GeoJSON FeatureCollection")
    archetype_property: str = Field(default="building_archetype")
    height_property: str = Field(default="height")
    confidence_threshold: float = Field(default=0.2, ge=0.0, le=1.0)
    unknown_values: list[str] = Field(default_factory=lambda: ["unknown", "Unknown", "UNKNOWN", "", "null", "None"])
    test_size: float = Field(default=0.2, ge=0.05, le=0.5)
    random_state: int = Field(default=42)
    n_estimators: int = Field(default=500, ge=50, le=2000)


class HealthResponse(BaseModel):
    status: str
