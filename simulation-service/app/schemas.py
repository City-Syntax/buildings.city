from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = 'ok'


class Coordinates(BaseModel):
    lng: float
    lat: float


class SelectionPayload(BaseModel):
    mode: Literal['single_building', 'circular_cluster'] = 'circular_cluster'
    center: Coordinates
    target_radius_m: float = Field(default=80.0, ge=0.0)
    context_radius_m: float = Field(default=500.0, ge=0.0)


class TargetGroup(BaseModel):
    valid_building_ids: list[str] = Field(default_factory=list)
    invalid_building_ids: list[str] = Field(default_factory=list)


class ContextGroup(BaseModel):
    shading_building_ids: list[str] = Field(default_factory=list)
    excluded_building_ids: list[str] = Field(default_factory=list)


class SimulationSettings(BaseModel):
    floor_height_m: float = Field(default=3.0, gt=0.0)
    default_wwr: float = Field(default=0.4, ge=0.0, le=1.0)
    geometry_mode: str = Field(default='minimum_rotated_rectangle')
    zoning_mode: str = Field(default='core_perimeter')
    template_strategy: str = Field(default='archetype_idf_replace_geometry')


class BuildingDetails(BaseModel):
    building_id: str
    role: str
    archetype: str | None = None
    height_m: float | None = None
    footprint_area_m2: float | None = None
    centroid: Coordinates | None = None


class SimulationJobRequest(BaseModel):
    selection: SelectionPayload
    targets: TargetGroup
    context: ContextGroup
    simulation_settings: SimulationSettings = Field(default_factory=SimulationSettings)
    building_details: list[BuildingDetails] = Field(default_factory=list)


class TemplateSyncRequest(BaseModel):
    archetype: str
    simulation_parameters: dict[str, Any]
