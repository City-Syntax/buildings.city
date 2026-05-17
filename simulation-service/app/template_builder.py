"""Standalone archetype-template to IDF builder.

This file copies the useful GloBI pattern: compact archetype parameters become an
epinterface ZoneComponent, and epinterface Model.build writes the EnergyPlus IDF.
It intentionally does not import from the ``globi`` package.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from epinterface.sbem.components.envelope import (
    ConstructionAssemblyComponent,
    ConstructionLayerComponent,
    EnvelopeAssemblyComponent,
    GlazingConstructionSimpleComponent,
    InfiltrationComponent,
    ZoneEnvelopeComponent,
)
from epinterface.sbem.components.materials import ConstructionMaterialComponent
from epinterface.sbem.components.operations import ZoneOperationsComponent
from epinterface.sbem.components.schedules import (
    DayComponent,
    WeekComponent,
    YearComponent,
    YearScheduleCategory,
)
from epinterface.sbem.components.space_use import (
    EquipmentComponent,
    LightingComponent,
    OccupancyComponent,
    ThermostatComponent,
    WaterUseComponent,
    ZoneSpaceUseComponent,
)
from epinterface.sbem.components.systems import (
    ConditioningSystemsComponent,
    DHWComponent,
    ThermalSystemComponent,
    VentilationComponent,
    ZoneHVACComponent,
)
from epinterface.sbem.components.zones import ZoneComponent


MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
WEEKEND_NAMES = ("Saturday", "Sunday")


class TemplateGeometryConfig(BaseModel):
    """Shoebox geometry used to export a representative archetype IDF."""

    length: float = Field(default=20.0, ge=3)
    width: float = Field(default=15.0, ge=3)
    num_floors: int = Field(default=2, ge=1)
    f2f_height: float = Field(default=3.5, ge=2)
    basement: bool = False
    attic_height: float | None = Field(default=None, ge=0)
    basement_conditioned: bool = False
    basement_use_fraction: float | None = Field(default=None, ge=0, le=1)
    attic_conditioned: bool = False
    attic_use_fraction: float | None = Field(default=None, ge=0, le=1)
    exposed_basement_frac: float = Field(default=0.25, ge=0, le=1)
    zoning: Literal["by_storey", "core/perim"] | None = None

    @model_validator(mode="after")
    def order_length_width(self) -> "TemplateGeometryConfig":
        """Keep length as the long edge."""
        if self.length < self.width:
            self.length, self.width = self.width, self.length
        return self

    def to_shoebox(self, wwr: float):
        """Convert to epinterface ShoeboxGeometry."""
        from epinterface.geometry import ShoeboxGeometry

        zoning = self.zoning or (
            "core/perim" if self.length > 15 and self.width > 15 else "by_storey"
        )
        return ShoeboxGeometry(
            x=0,
            y=0,
            w=self.length,
            d=self.width,
            h=self.f2f_height,
            wwr=wwr,
            num_stories=self.num_floors,
            basement=self.basement,
            zoning=zoning,
            roof_height=self.attic_height,
            exposed_basement_frac=self.exposed_basement_frac,
        )


class SimulationTemplateParameters(BaseModel):
    """Fields expected in ``templates.json[*].simulation_parameters``."""

    model_config = ConfigDict(extra="allow")

    hvac_system: Literal["ideal_loads_air_system"] = "ideal_loads_air_system"
    wwr: float = Field(default=0.35, ge=0, le=1)
    u_roof: float = Field(default=0.35, gt=0)
    u_wall: float = Field(default=0.6, gt=0)
    u_floor: float = Field(default=0.5, gt=0)
    u_win: float = Field(default=2.8, gt=0)
    shgc: float = Field(default=0.35, ge=0, le=1)
    tvis: float = Field(default=0.6, ge=0, le=1)
    ach: float = Field(default=0.35, ge=0)
    occ: float = Field(default=0.08, ge=0)
    epd: float = Field(default=12.0, ge=0)
    lpd: float = Field(default=8.0, ge=0)
    hw_lppd: float = Field(default=35.0, ge=0)
    cop_cool: float = Field(default=3.5, gt=0)
    cop_heat: float | None = Field(default=None, gt=0)
    cop_dhw: float = Field(default=1.0, gt=0)
    t_heat: float = 20.0
    t_cool: float = 24.0
    dhw_supply_temp: float = Field(default=60.0, ge=0, le=100)
    dhw_inlet_temp: float = Field(default=15.0, ge=0, le=100)
    fresh_air_per_person: float = Field(default=0.004, ge=0, le=0.05)
    fresh_air_per_floor_area: float = Field(default=0.0, ge=0, le=0.05)
    schedules: dict[str, list[float]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_schedule_lengths(self) -> "SimulationTemplateParameters":
        """Hourly profiles must contain exactly 24 values."""
        for name, values in self.schedules.items():
            if len(values) != 24:
                raise ValueError(f"Schedule {name!r} must have 24 hourly values.")
        return self


class ArchetypeTemplateConfig(BaseModel):
    """One archetype entry."""

    archetype: str
    simulation_parameters: SimulationTemplateParameters
    geometry: TemplateGeometryConfig | None = None


def slugify(value: str) -> str:
    """Return a filesystem-safe name."""
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip()).strip("._")
    return slug or "archetype"


def load_template_configs(path: Path | str) -> list[ArchetypeTemplateConfig]:
    """Load a JSON list or ``{"templates": [...]}`` file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = data["templates"] if isinstance(data, dict) and "templates" in data else data
    if not isinstance(entries, list):
        raise ValueError("Expected a JSON list or an object with a templates list.")
    return [ArchetypeTemplateConfig.model_validate(entry) for entry in entries]


def _metadata(name: str) -> dict[str, str]:
    return {
        "Category": "Generated",
        "Comment": f"Generated from compact archetype config for {name}.",
        "DataSource": "templates.json",
        "Version": "1",
    }


def _day(name: str, values: list[float], schedule_type: str) -> DayComponent:
    data: dict[str, Any] = {"Name": name, "Type": schedule_type}
    data.update({f"Hour_{hour:02d}": float(value) for hour, value in enumerate(values)})
    return DayComponent.model_validate(data)


def _week(name: str, weekday: list[float], weekend: list[float], schedule_type: str):
    weekday_day = _day(f"{name}_Weekday", weekday, schedule_type)
    weekend_day = _day(f"{name}_Weekend", weekend, schedule_type)
    data = {"Name": f"{name}_Week"}
    data.update({day: weekday_day for day in WEEKDAY_NAMES})
    data.update({day: weekend_day for day in WEEKEND_NAMES})
    return WeekComponent.model_validate(data)


def _year_schedule(
    name: str,
    category: YearScheduleCategory,
    weekday: list[float],
    weekend: list[float] | None = None,
    schedule_type: Literal["Fraction", "Temperature", "AnyNumber"] = "Fraction",
) -> YearComponent:
    week = _week(name, weekday, weekend or weekday, schedule_type)
    data: dict[str, Any] = {"Name": name, "Type": category}
    data.update({month: week for month in MONTH_NAMES})
    return YearComponent.model_validate(data)


def _schedule_values(
    params: SimulationTemplateParameters,
    key: str,
    default: float,
) -> list[float]:
    return [float(v) for v in params.schedules.get(key, [default] * 24)]


def _material(name: str, conductivity: float = 0.1) -> ConstructionMaterialComponent:
    return ConstructionMaterialComponent(
        Name=f"{name}_Material",
        Conductivity=conductivity,
        Density=1800,
        Roughness="MediumRough",
        SpecificHeat=900,
        ThermalAbsorptance=0.9,
        SolarAbsorptance=0.7,
        VisibleAbsorptance=0.7,
        TemperatureCoefficientThermalConductivity=0,
        Type="Other",
        **_metadata(name),
    )


def _opaque_assembly(
    name: str,
    surface_type: str,
    u_value: float,
) -> ConstructionAssemblyComponent:
    conductivity = 0.1
    thickness = min(max(conductivity / u_value, 0.003), 2.0)
    layer = ConstructionLayerComponent(
        Thickness=thickness,
        LayerOrder=0,
        ConstructionMaterial=_material(name, conductivity=conductivity),
    )
    return ConstructionAssemblyComponent(
        Name=name,
        Layers=[layer],
        VegetationLayer=None,
        Type=surface_type,
        **_metadata(name),
    )


def _infiltration(name: str, ach: float) -> InfiltrationComponent:
    return InfiltrationComponent(
        Name=name,
        IsOn=ach > 0,
        ConstantCoefficient=1,
        TemperatureCoefficient=0,
        WindVelocityCoefficient=0,
        WindVelocitySquaredCoefficient=0,
        AFNAirMassFlowCoefficientCrack=0,
        AirChangesPerHour=ach,
        FlowPerExteriorSurfaceArea=0,
        CalculationMethod="AirChanges/Hour",
        **_metadata(name),
    )


def envelope_from_parameters(
    archetype: str,
    params: SimulationTemplateParameters,
) -> ZoneEnvelopeComponent:
    """Build envelope components from compact U-values and window fields."""
    prefix = slugify(archetype)
    assemblies = EnvelopeAssemblyComponent(
        Name=f"{prefix}_EnvelopeAssemblies",
        FlatRoofAssembly=_opaque_assembly(f"{prefix}_FlatRoof", "FlatRoof", params.u_roof),
        FacadeAssembly=_opaque_assembly(f"{prefix}_Facade", "Facade", params.u_wall),
        FloorCeilingAssembly=_opaque_assembly(
            f"{prefix}_FloorCeiling", "FloorCeiling", params.u_floor
        ),
        AtticRoofAssembly=_opaque_assembly(
            f"{prefix}_AtticRoof", "AtticRoof", params.u_roof
        ),
        AtticFloorAssembly=_opaque_assembly(
            f"{prefix}_AtticFloor", "AtticFloor", params.u_roof
        ),
        PartitionAssembly=_opaque_assembly(f"{prefix}_Partition", "Partition", params.u_wall),
        ExternalFloorAssembly=_opaque_assembly(
            f"{prefix}_ExternalFloor", "ExternalFloor", params.u_floor
        ),
        GroundSlabAssembly=_opaque_assembly(
            f"{prefix}_GroundSlab", "GroundSlab", params.u_floor
        ),
        GroundWallAssembly=_opaque_assembly(
            f"{prefix}_GroundWall", "GroundWall", params.u_wall
        ),
        BasementCeilingAssembly=_opaque_assembly(
            f"{prefix}_BasementCeiling", "BasementCeiling", params.u_floor
        ),
        InternalMassAssembly=None,
        InternalMassExposedAreaPerArea=None,
        **_metadata(prefix),
    )
    window = GlazingConstructionSimpleComponent(
        Name=f"{prefix}_Window",
        SHGF=params.shgc,
        UValue=params.u_win,
        TVis=params.tvis,
        Type="Double",
        **_metadata(prefix),
    )
    return ZoneEnvelopeComponent(
        Name=f"{prefix}_Envelope",
        Assemblies=assemblies,
        Infiltration=_infiltration(f"{prefix}_Infiltration", params.ach),
        AtticInfiltration=_infiltration(f"{prefix}_AtticInfiltration", params.ach),
        BasementInfiltration=_infiltration(f"{prefix}_BasementInfiltration", params.ach),
        Window=window,
        **_metadata(prefix),
    )


def operations_from_parameters(
    archetype: str,
    params: SimulationTemplateParameters,
) -> ZoneOperationsComponent:
    """Build space-use, HVAC, and DHW components from compact fields."""
    prefix = slugify(archetype)
    occupancy_schedule = _year_schedule(
        f"{prefix}_Occupancy_Schedule",
        "Occupancy",
        _schedule_values(params, "occupancy_weekday", 1.0),
        _schedule_values(params, "occupancy_weekend", 1.0),
    )
    lighting_schedule = _year_schedule(
        f"{prefix}_Lighting_Schedule",
        "Lighting",
        _schedule_values(params, "lighting_weekday", 1.0),
        _schedule_values(params, "lighting_weekend", 1.0),
    )
    equipment_schedule = _year_schedule(
        f"{prefix}_Equipment_Schedule",
        "Equipment",
        _schedule_values(params, "equipment_weekday", 1.0),
        _schedule_values(params, "equipment_weekend", 1.0),
    )
    water_schedule = _year_schedule(
        f"{prefix}_HotWater_Schedule",
        "WaterUse",
        _schedule_values(params, "hotwater_weekday", 1.0),
        _schedule_values(params, "hotwater_weekend", 1.0),
    )
    ventilation_schedule = _year_schedule(
        f"{prefix}_Ventilation_Schedule", "Equipment", [1.0] * 24
    )
    heating_schedule = _year_schedule(
        f"{prefix}_HeatingSetpoint_Schedule",
        "Setpoint",
        [params.t_heat] * 24,
        schedule_type="Temperature",
    )
    cooling_schedule = _year_schedule(
        f"{prefix}_CoolingSetpoint_Schedule",
        "Setpoint",
        [params.t_cool] * 24,
        schedule_type="Temperature",
    )

    space_use = ZoneSpaceUseComponent(
        Name=f"{prefix}_SpaceUse",
        Occupancy=OccupancyComponent(
            Name=f"{prefix}_Occupancy",
            PeopleDensity=params.occ,
            Schedule=occupancy_schedule,
            IsOn=params.occ > 0,
            **_metadata(prefix),
        ),
        Lighting=LightingComponent(
            Name=f"{prefix}_Lighting",
            PowerDensity=params.lpd,
            DimmingType="Off",
            Schedule=lighting_schedule,
            IsOn=params.lpd > 0,
            **_metadata(prefix),
        ),
        Equipment=EquipmentComponent(
            Name=f"{prefix}_Equipment",
            PowerDensity=params.epd,
            Schedule=equipment_schedule,
            IsOn=params.epd > 0,
            **_metadata(prefix),
        ),
        Thermostat=ThermostatComponent(
            Name=f"{prefix}_Thermostat",
            IsOn=True,
            HeatingSetpoint=params.t_heat,
            HeatingSchedule=heating_schedule,
            CoolingSetpoint=params.t_cool,
            CoolingSchedule=cooling_schedule,
            **_metadata(prefix),
        ),
        WaterUse=WaterUseComponent(
            Name=f"{prefix}_WaterUse",
            FlowRatePerPerson=params.hw_lppd / 1000,
            Schedule=water_schedule,
            **_metadata(prefix),
        ),
        **_metadata(prefix),
    )

    heating = (
        ThermalSystemComponent(
            Name=f"{prefix}_HeatingSystem",
            ConditioningType="Heating",
            Fuel="Electricity",
            SystemCOP=params.cop_heat,
            DistributionCOP=1,
            **_metadata(prefix),
        )
        if params.cop_heat is not None
        else None
    )
    cooling = ThermalSystemComponent(
        Name=f"{prefix}_CoolingSystem",
        ConditioningType="Cooling",
        Fuel="Electricity",
        SystemCOP=params.cop_cool,
        DistributionCOP=1,
        **_metadata(prefix),
    )
    hvac = ZoneHVACComponent(
        Name=f"{prefix}_HVAC",
        ConditioningSystems=ConditioningSystemsComponent(
            Name=f"{prefix}_ConditioningSystems",
            Heating=heating,
            Cooling=cooling,
            **_metadata(prefix),
        ),
        Ventilation=VentilationComponent(
            Name=f"{prefix}_Ventilation",
            FreshAirPerFloorArea=params.fresh_air_per_floor_area,
            FreshAirPerPerson=params.fresh_air_per_person,
            Schedule=ventilation_schedule,
            Provider="Mechanical",
            HRV="NoHRV",
            Economizer="NoEconomizer",
            DCV="NoDCV",
            **_metadata(prefix),
        ),
        **_metadata(prefix),
    )
    dhw = DHWComponent(
        Name=f"{prefix}_DHW",
        SystemCOP=params.cop_dhw,
        WaterTemperatureInlet=params.dhw_inlet_temp,
        DistributionCOP=1,
        WaterSupplyTemperature=params.dhw_supply_temp,
        IsOn=params.hw_lppd > 0,
        FuelType="Electricity",
        **_metadata(prefix),
    )
    return ZoneOperationsComponent(
        Name=f"{prefix}_Operations",
        SpaceUse=space_use,
        HVAC=hvac,
        DHW=dhw,
        **_metadata(prefix),
    )


def zone_component_from_parameters(
    archetype: str,
    params: SimulationTemplateParameters | dict[str, Any],
) -> ZoneComponent:
    """Create the in-memory template passed to epinterface Model."""
    if not isinstance(params, SimulationTemplateParameters):
        params = SimulationTemplateParameters.model_validate(params)
    prefix = slugify(archetype)
    return ZoneComponent(
        Name=f"{prefix}_Zone",
        Operations=operations_from_parameters(archetype, params),
        Envelope=envelope_from_parameters(archetype, params),
    )


def model_from_template_config(
    config: ArchetypeTemplateConfig,
    weather: str | Path,
    geometry: TemplateGeometryConfig | None = None,
):
    """Create an epinterface Model for one archetype."""
    from epinterface.sbem.builder import AtticAssumptions, BasementAssumptions, Model

    archetype_geometry = config.geometry or geometry or TemplateGeometryConfig()
    return Model(
        Weather=Path(weather).resolve() if isinstance(weather, Path) else weather,
        Zone=zone_component_from_parameters(
            config.archetype, config.simulation_parameters
        ),
        Attic=AtticAssumptions(
            Conditioned=archetype_geometry.attic_conditioned,
            UseFraction=archetype_geometry.attic_use_fraction,
        ),
        Basement=BasementAssumptions(
            Conditioned=archetype_geometry.basement_conditioned,
            UseFraction=archetype_geometry.basement_use_fraction,
        ),
        geometry=archetype_geometry.to_shoebox(config.simulation_parameters.wwr),
    )


def make_idf_energyplus_24_2_compatible(path: Path | str) -> None:
    """Patch known EnergyPlus 22.2 generator output differences for 24.2."""
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    text = text.replace("ZoneAveraged", "EnclosureAveraged")
    text = re.sub(
        r"(Version,\s*)(?:22\.2|22\.2\.0)(\s*;)",
        r"\g<1>24.2\2",
        text,
        count=1,
        flags=re.IGNORECASE,
    )
    path.write_text(text, encoding="utf-8")


def write_archetype_idf(
    config: ArchetypeTemplateConfig,
    weather: str | Path,
    output_dir: Path | str,
    geometry: TemplateGeometryConfig | None = None,
    weather_cache_dir: Path | str | None = None,
    work_dir: Path | str | None = None,
    write_zone_json: bool = True,
) -> Path:
    """Build and write one archetype IDF."""
    import epinterface.sbem.builder as ep_builder
    from epinterface.ddy_injector_bayes import DDYSizingSpec
    from epinterface.sbem.builder import SimulationPathConfig

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    archetype_slug = slugify(config.archetype)
    build_root = Path(work_dir) if work_dir else output_dir
    archetype_work_dir = build_root / archetype_slug
    archetype_work_dir.mkdir(parents=True, exist_ok=True)

    model = model_from_template_config(config, weather=weather, geometry=geometry)
    sim_config = SimulationPathConfig(
        output_dir=archetype_work_dir / "eplus_work",
        weather_dir=Path(weather_cache_dir)
        if weather_cache_dir
        else build_root / "weather_cache",
    )

    class LenientDDYSizingSpec(DDYSizingSpec):
        """Use all design days available in the local DDY file."""

        def __init__(self, **data: Any) -> None:
            data["design_days"] = "All"
            data["conditions_types"] = "All"
            data["raise_on_not_found"] = False
            super().__init__(**data)

    original_ddy_sizing_spec = ep_builder.DDYSizingSpec
    ep_builder.DDYSizingSpec = LenientDDYSizingSpec
    try:
        idf = model.build(sim_config)
    finally:
        ep_builder.DDYSizingSpec = original_ddy_sizing_spec

    idf_path = output_dir / f"{archetype_slug}.idf"
    idf.saveas(idf_path.as_posix())
    make_idf_energyplus_24_2_compatible(idf_path)

    if write_zone_json:
        (archetype_work_dir / f"{archetype_slug}.zone.json").write_text(
            model.Zone.model_dump_json(indent=2),
            encoding="utf-8",
        )
    return idf_path


def write_archetype_idfs(
    configs: list[ArchetypeTemplateConfig],
    weather: str | Path,
    output_dir: Path | str,
    geometry: TemplateGeometryConfig | None = None,
    weather_cache_dir: Path | str | None = None,
    work_dir: Path | str | None = None,
    write_zone_json: bool = True,
) -> dict[str, Path]:
    """Build all archetype IDFs."""
    return {
        config.archetype: write_archetype_idf(
            config,
            weather=weather,
            output_dir=output_dir,
            geometry=geometry,
            weather_cache_dir=weather_cache_dir,
            work_dir=work_dir,
            write_zone_json=write_zone_json,
        )
        for config in configs
    }
