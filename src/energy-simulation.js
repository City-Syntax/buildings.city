import mapboxgl from 'mapbox-gl';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import config from '../user-data/config.json';
import {
    createSimulationJob,
    getBuildingHourlyOutputs,
    getBuildingSqlDownloadUrl,
    getSimulationJob,
    syncIdfTemplate
} from './simulation-api.js';
import { reloadSimulationBuildingLibrary, syncGeoJSONDataset } from './data-sync-api.js';
import idfTemplateLibrary from '../user-data/simulation/templates.json';

const DEFAULT_RADIUS_METERS = 200;
const DEFAULT_CONTEXT_RADIUS_METERS = 200;
const MAX_TARGET_BUILDINGS = 50;
const DEFAULT_MAP_CENTER = [8.5417, 47.3769];
const TARGET_COLOR = '#b9e6ff';
const INVALID_COLOR = '#595b5c';
const CONTEXT_COLOR = '#e5ebed';
const BACKGROUND_COLOR = '#101010';
const DEFAULT_SCHEDULES = {
    occupancy_weekday: [0.05, 0.05, 0.05, 0.05, 0.05, 0.08, 0.18, 0.45, 0.75, 0.9, 0.95, 0.95, 0.85, 0.9, 0.95, 0.95, 0.85, 0.6, 0.35, 0.2, 0.12, 0.08, 0.05, 0.05],
    occupancy_weekend: [0.05, 0.05, 0.05, 0.05, 0.05, 0.06, 0.08, 0.15, 0.28, 0.42, 0.55, 0.6, 0.58, 0.55, 0.52, 0.5, 0.45, 0.35, 0.25, 0.18, 0.12, 0.08, 0.05, 0.05],
    lighting_weekday: [0.05, 0.05, 0.05, 0.05, 0.05, 0.08, 0.18, 0.55, 0.85, 0.95, 0.95, 0.95, 0.85, 0.9, 0.95, 0.95, 0.9, 0.65, 0.35, 0.18, 0.1, 0.07, 0.05, 0.05],
    lighting_weekend: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.08, 0.12, 0.25, 0.38, 0.48, 0.52, 0.5, 0.48, 0.45, 0.42, 0.35, 0.25, 0.18, 0.12, 0.08, 0.06, 0.05, 0.05],
    equipment_weekday: [0.1, 0.1, 0.1, 0.1, 0.1, 0.12, 0.2, 0.5, 0.82, 0.95, 0.95, 0.95, 0.9, 0.92, 0.95, 0.95, 0.88, 0.62, 0.35, 0.2, 0.14, 0.12, 0.1, 0.1],
    equipment_weekend: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.12, 0.16, 0.25, 0.35, 0.45, 0.5, 0.48, 0.46, 0.44, 0.4, 0.35, 0.28, 0.2, 0.15, 0.12, 0.1, 0.1, 0.1],
    hotwater_weekday: [0.05, 0.05, 0.05, 0.05, 0.08, 0.18, 0.45, 0.75, 0.58, 0.35, 0.28, 0.32, 0.45, 0.38, 0.3, 0.32, 0.45, 0.65, 0.55, 0.32, 0.2, 0.12, 0.08, 0.05],
    hotwater_weekend: [0.05, 0.05, 0.05, 0.05, 0.06, 0.1, 0.2, 0.38, 0.55, 0.5, 0.38, 0.32, 0.42, 0.4, 0.32, 0.3, 0.35, 0.48, 0.52, 0.38, 0.24, 0.14, 0.08, 0.05]
};
const HVAC_OPTIONS = [
    ['ideal_loads_air_system', 'Ideal Loads Air System'],
    ['vav_reheat', 'VAV with Reheat'],
    ['vrf_doas', 'VRF with DOAS'],
    ['fcu_chiller_boiler', 'Fan Coil + Chiller/Boiler'],
    ['ptac_dx', 'Packaged Terminal AC'],
    ['split_dx', 'Split DX System']
];
const PARAMETER_FIELDS = [
    { key: 'wwr', label: 'Window to wall ratio', group: 'Envelope', min: 0, max: 0.95, step: 0.01 },
    { key: 'u_roof', label: 'Roof U-value', unit: 'W/m2K', group: 'Envelope', min: 0.05, max: 5, step: 0.01 },
    { key: 'u_wall', label: 'Wall U-value', unit: 'W/m2K', group: 'Envelope', min: 0.05, max: 5, step: 0.01 },
    { key: 'u_floor', label: 'Floor U-value', unit: 'W/m2K', group: 'Envelope', min: 0.05, max: 5, step: 0.01 },
    { key: 'u_win', label: 'Window U-value', unit: 'W/m2K', group: 'Envelope', min: 0.2, max: 8, step: 0.01 },
    { key: 'shgc', label: 'Solar Heat Gain Coefficient', group: 'Envelope', min: 0, max: 1, step: 0.01 },
    { key: 'ach', label: 'Air Changes per Hour', unit: '1/hr', group: 'Envelope', min: 0, max: 5, step: 0.05 },
    { key: 'occ', label: 'Occupancy density', unit: 'person/m2', group: 'Internal Loads', min: 0, max: 1, step: 0.005 },
    { key: 'epd', label: 'Equipment power density', unit: 'W/m2', group: 'Internal Loads', min: 0, max: 100, step: 0.5 },
    { key: 'lpd', label: 'Lighting power density', unit: 'W/m2', group: 'Internal Loads', min: 0, max: 60, step: 0.5 },
    { key: 'hw_lppd', label: 'Hot Water per person', unit: 'L/person/day', group: 'Internal Loads', min: 0, max: 200, step: 1 },
    { key: 'hvac_system', label: 'HVAC System', group: 'HVAC', type: 'select', options: HVAC_OPTIONS },
    { key: 'cop_cool', label: 'Cooling COP', group: 'HVAC', min: 1, max: 8, step: 0.1 },
    { key: 't_cool', label: 'Cooling Setpoint', unit: 'C', group: 'HVAC', min: 18, max: 30, step: 0.5 }
];
const SCHEDULE_CHARTS = [
    { key: 'occupancy_weekday', title: 'Occupancy Weekday' },
    { key: 'occupancy_weekend', title: 'Occupancy weekend / holiday' },
    { key: 'lighting_weekday', title: 'Lighting Weekday' },
    { key: 'lighting_weekend', title: 'Lighting weekend / holiday' },
    { key: 'equipment_weekday', title: 'Equipment Weekday' },
    { key: 'equipment_weekend', title: 'Equipment weekend / holiday' },
    { key: 'hotwater_weekday', title: 'Hot Water Weekday' },
    { key: 'hotwater_weekend', title: 'Hot water weekend / holiday' }
];
const BASIC_INFO_FIELDS = [
    { key: 'building_id', label: 'Building ID', type: 'text', disabled: true },
    { key: 'building_archetype', label: 'Archetype', type: 'select' },
    { key: 'height', label: 'Height (m)', type: 'number', min: 0, max: 500, step: 0.1 },
    { key: 'building_levels', label: 'Levels', type: 'number', min: 0, max: 150, step: 1 },
    { key: 'building_footprint', label: 'Footprint (m2)', type: 'number', min: 0, max: 1000000, step: 1 },
    { key: 'template_source', label: 'Template Source', type: 'text', disabled: true }
];

const state = {
    map: null,
    draw: null,
    geojson: null,
    sourceGeojson: null,
    hasPendingGeojsonEdits: false,
    buildingMeta: [],
    mode: 'buildings',
    center: null,
    selectedFeatureId: null,
    selectedFeatureIds: new Set(),
    radiusMeters: DEFAULT_RADIUS_METERS,
    contextRadiusMeters: DEFAULT_CONTEXT_RADIUS_METERS,
    areaSelectionArmed: false,
    selectionGeometryMode: 'buildings',
    roleCounts: {
        target: 0,
        invalid: 0,
        context: 0
    },
    activeSimulationJobId: null,
    lastSimulationJob: null,
    focusedSummaryBuildingId: null,
    simulationHistory: { single: [], area: [] },
    hourlyChart: {
        jobId: null,
        buildingId: null,
        labels: [],
        series: [],
        selectedKeys: new Set(),
        windowStart: 0,
        windowSize: 24 * 7
    },
    archetypeTemplates: {},
    archetypeOptions: [],
    buildingEditor: {
        featureUid: null,
        animationFrame: null,
        rotation: 0,
        scheduleValues: {},
        scheduleResetValues: cloneSchedules(DEFAULT_SCHEDULES),
        scheduleHeight: 150,
        activeScheduleDrag: null
    }
};

const radiusInput = document.getElementById('radiusInput');
const contextRadiusInput = document.getElementById('contextRadiusInput');
const radiusValue = document.getElementById('radiusValue');
const contextRadiusValue = document.getElementById('contextRadiusValue');
const resetRadiusButton = document.getElementById('resetRadius');
const resetContextRadiusButton = document.getElementById('resetContextRadius');
const resetButton = document.getElementById('resetSelection');
const drawAreaButton = document.getElementById('drawAreaSelection');
const syncGeojsonButton = document.getElementById('syncGeojsonDataset');
const confirmSimulationButton = document.getElementById('confirmSimulation');
const modePrompt = document.getElementById('modePrompt');
const modeDescription = document.getElementById('modeDescription');
const controlStrip = document.querySelector('.control-strip');
const selectionHint = document.getElementById('selectionHint');
const simulationResult = document.getElementById('simulationResult');
const targetCount = document.getElementById('targetCount');
const invalidCount = document.getElementById('invalidCount');
const contextCount = document.getElementById('contextCount');
const simulationProgressOverlay = document.getElementById('simulationProgressOverlay');
const simulationSummaryOverlay = document.getElementById('simulationSummaryOverlay');
const simulationProgressBar = document.getElementById('simulationProgressBarInner');
const simulationProgressPercent = document.getElementById('simulationProgressPercent');
const simulationProgressStage = document.getElementById('simulationProgressStage');
const simulationProgressMessage = document.getElementById('simulationProgressMessage');
const simulationSummaryTitle = document.getElementById('simulationSummaryTitle');
const simulationSummaryMessage = document.getElementById('simulationSummaryMessage');
const simulationOverviewGrid = document.getElementById('simulationOverviewGrid');
const simulationAverageGrid = document.getElementById('simulationAverageGrid');
const simulationResultsTableBody = document.getElementById('simulationResultsTableBody');
const simulationTableSection = document.getElementById('simulationTableSection');
const simulationTableNote = document.getElementById('simulationTableNote');
const simulationDownloadSummaryButton = document.getElementById('simulationDownloadSummary');
const simulationDownloadSqlButton = document.getElementById('simulationDownloadSql');
const simulationSaveToListButton = document.getElementById('simulationSaveToList');
const simulationCloseSummaryButton = document.getElementById('simulationCloseSummary');
const simulationHourlySection = document.getElementById('simulationHourlySection');
const simulationHourlyCanvas = document.getElementById('simulationHourlyCanvas');
const simulationHourlySeriesList = document.getElementById('simulationHourlySeriesList');
const simulationHourlyRangeStart = document.getElementById('simulationHourlyRangeStart');
const simulationHourlyRangeEnd = document.getElementById('simulationHourlyRangeEnd');
const simulationHourlyRangeFill = document.getElementById('simulationHourlyRangeFill');
const simulationHourlyMonth = document.getElementById('simulationHourlyMonth');
const simulationHourlyRangeLabel = document.getElementById('simulationHourlyRangeLabel');
const simulationHourlyNote = document.getElementById('simulationHourlyNote');
const simulationDownloadHourlyChartButton = document.getElementById('simulationDownloadHourlyChart');
const simResultsPanel = document.getElementById('simResultsPanel');
const simResultsList = document.getElementById('simResultsList');
const simResultsSelectAll = document.getElementById('simResultsSelectAll');
const simResultsClear = document.getElementById('simResultsClear');
const simResultsExportCsv = document.getElementById('simResultsExportCsv');
const simResultsDownloadGeojson = document.getElementById('simResultsDownloadGeojson');
const buildingEditorOverlay = document.getElementById('buildingEditorOverlay');
const buildingEditorClose = document.getElementById('buildingEditorClose');
const buildingEditorSaveBuilding = document.getElementById('buildingEditorSaveBuilding');
const buildingEditorSaveArchetype = document.getElementById('buildingEditorSaveArchetype');
const buildingEditorDownloadBuilding = document.getElementById('buildingEditorDownloadBuilding');
const buildingEditorDownloadTemplate = document.getElementById('buildingEditorDownloadTemplate');
const buildingInfoGrid = document.getElementById('buildingInfoGrid');
const buildingParameterGrid = document.getElementById('buildingParameterGrid');
const buildingScheduleSection = document.getElementById('buildingScheduleSection');
const scheduleHeightInput = document.getElementById('scheduleHeightInput');
const scheduleHeightValue = document.getElementById('scheduleHeightValue');
const scheduleResetAll = document.getElementById('scheduleResetAll');
const scheduleChartGrid = document.getElementById('scheduleChartGrid');
const buildingPreviewCanvas = document.getElementById('buildingPreviewCanvas');
const buildingPreviewTitle = document.getElementById('buildingPreviewTitle');
const buildingPreviewSubtitle = document.getElementById('buildingPreviewSubtitle');
const buildingEditorSaveStatus = document.getElementById('buildingEditorSaveStatus');

function getActiveRadiusMeters() {
    const nextValue = Number(radiusInput?.value);

    if (Number.isFinite(nextValue) && nextValue > 0) {
        return nextValue;
    }

    return state.radiusMeters || DEFAULT_RADIUS_METERS;
}

function getActiveContextRadiusMeters() {
    const nextValue = Number(contextRadiusInput?.value);

    if (Number.isFinite(nextValue) && nextValue > 0) {
        return nextValue;
    }

    return state.contextRadiusMeters || DEFAULT_CONTEXT_RADIUS_METERS;
}

void init();

async function init() {
    try {
        mapboxgl.accessToken = config.mapbox_token;
        state.archetypeTemplates = loadArchetypeTemplates();
        const coords = await getCityCoords(config.city_name);
        const response = await fetch(config.buildings_source?.data || '/user-data/buildings/export.compact.geojson');

        if (!response.ok) {
            throw new Error(`Failed to load building GeoJSON (${response.status})`);
        }

        const geojson = await response.json();
        state.sourceGeojson = geojson;
        state.geojson = prepareGeoJSON(geojson);
        state.buildingMeta = state.geojson.features.map(feature => buildFeatureMeta(feature));
        state.archetypeOptions = getArchetypeOptions(state.geojson);

        createMap(coords);
        bindUI();
    } catch (error) {
        console.error(error);
        if (selectionHint) {
            selectionHint.textContent = error.message || 'Unable to start the energy simulation mode.';
        }
    }
}

function prepareGeoJSON(geojson) {
    const featuresById = new Map();

    (geojson?.features || [])
        .filter(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type))
        .forEach((feature, index) => {
            const simulationUid = String(
                feature?.properties?.simulation_uid
                ?? feature?.properties?.id
                ?? feature?.properties?.building_id
                ?? feature.id
                ?? index
            );

            const prepared = {
                ...feature,
                id: feature.id ?? index,
                properties: {
                    ...(feature.properties || {}),
                    simulation_uid: simulationUid,
                    simulation_role: 'background'
                }
            };
            const previous = featuresById.get(simulationUid);
            featuresById.set(simulationUid, previous
                ? {
                    ...previous,
                    ...prepared,
                    properties: {
                        ...(previous.properties || {}),
                        ...(prepared.properties || {})
                    }
                }
                : prepared
            );
        });

    return {
        type: 'FeatureCollection',
        features: Array.from(featuresById.values())
    };
}

function buildFeatureMeta(feature) {
    return {
        id: feature.id,
        uid: String(feature?.properties?.simulation_uid ?? feature.id ?? ''),
        centroid: turf.centroid(feature),
        invalid: isInvalidBuilding(feature.properties || {})
    };
}

async function getCityCoords(city) {
    try {
        const response = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(city)}.json?access_token=${mapboxgl.accessToken}&limit=1`);
        const data = await response.json();
        return data.features?.length ? data.features[0].center : DEFAULT_MAP_CENTER;
    } catch (error) {
        return DEFAULT_MAP_CENTER;
    }
}

function createMap(center = DEFAULT_MAP_CENTER) {
    state.map = new mapboxgl.Map({
        container: 'map',
        style: config.map_style || 'mapbox://styles/mapbox/dark-v11',
        center,
        zoom: 15,
        pitch: 0,
        bearing: 0,
        attributionControl: true
    });

    window.map = state.map;
    window.draw = null;

    setupMapControls();

    state.map.on('load', () => {
        addSourcesAndLayers();
        fitMapToBuildings();
        bindMapInteractions();
        modePrompt?.classList.remove('show');
        updateModeText();
        updateHint('Click buildings to add or remove simulation targets. Up to 30 buildings can be selected.');
    });
}

function setupMapControls() {
    state.map.doubleClickZoom.disable();

    const geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl,
        marker: { color: '#333', scale: 0.8 },
        placeholder: 'Search for buildings...'
    });

    state.map.addControl(geocoder, 'bottom-right');
    state.map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    state.draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: { polygon: true, trash: true }
    });
    state.map.addControl(state.draw, 'top-right');
    window.draw = state.draw;

    const topRightCtrl = document.querySelector('.mapboxgl-ctrl-top-right');
    if (topRightCtrl) {
        topRightCtrl.style.top = '46px';
    }

    const ctrlGroups = document.querySelectorAll('.mapboxgl-ctrl-group');
    ctrlGroups.forEach(group => {
        group.style.borderRadius = '10px';
        group.style.overflow = 'hidden';
    });

    const ctrlButtons = document.querySelectorAll('.mapboxgl-ctrl-group > button');
    ctrlButtons.forEach(button => {
        button.style.width = '28px';
        button.style.height = '28px';
    });

    const geocoderCtrl = document.querySelector('.mapboxgl-ctrl-geocoder');
    if (geocoderCtrl) {
        geocoderCtrl.style.borderRadius = '10px';
        geocoderCtrl.style.margin = '8px';

        const input = geocoderCtrl.querySelector('input');
        if (input) {
            input.style.borderRadius = '10px';
        }

        const dropdown = geocoderCtrl.querySelector('.suggestions');
        if (dropdown) {
            dropdown.style.borderRadius = '10px';
        }
    }
}

function addSourcesAndLayers() {
    state.map.addSource('simulation-buildings', {
        type: 'geojson',
        data: state.geojson,
        generateId: false
    });

    state.map.addSource('target-zone', {
        type: 'geojson',
        data: emptyFeatureCollection()
    });

    state.map.addSource('context-zone', {
        type: 'geojson',
        data: emptyFeatureCollection()
    });

    const roleExpr = ['coalesce', ['get', 'simulation_role'], 'background'];

    state.map.addLayer({
        id: 'simulation-buildings-fill',
        type: 'fill',
        source: 'simulation-buildings',
        paint: {
            'fill-color': [
                'match',
                roleExpr,
                'target', TARGET_COLOR,
                'invalid', INVALID_COLOR,
                'context', CONTEXT_COLOR,
                BACKGROUND_COLOR
            ],
            'fill-opacity': [
                'match',
                roleExpr,
                'target', 0.9,
                'invalid', 0.6,
                'context', 0.5,
                0.4
            ]
        }
    });

    state.map.addLayer({
        id: 'simulation-buildings-outline',
        type: 'line',
        source: 'simulation-buildings',
        paint: {
            'line-color': [
                'match',
                roleExpr,
                'target', '#ecfaff',
                'invalid', '#5a5d5f',
                'context', '#bfc2c6',
                '#151d28'
            ],
            'line-width': [
                'match',
                roleExpr,
                'target', 1.2,
                'invalid', 1.2,
                'context', 1,
                0.5
            ],
            'line-opacity': 0.9
        }
    });

    state.map.addLayer({
        id: 'context-zone-line',
        type: 'line',
        source: 'context-zone',
        paint: {
            'line-color': CONTEXT_COLOR,
            'line-width': 2,
            'line-opacity': 0.7,
            'line-dasharray': [2, 2]
        }
    });

    state.map.addLayer({
        id: 'target-zone-fill',
        type: 'fill',
        source: 'target-zone',
        paint: {
            'fill-color': TARGET_COLOR,
            'fill-opacity': 0.08
        }
    });

    state.map.addLayer({
        id: 'target-zone-line',
        type: 'line',
        source: 'target-zone',
        paint: {
            'line-color': TARGET_COLOR,
            'line-width': 2.2,
            'line-opacity': 0.95,
            'line-dasharray': [3, 2]
        }
    });
}

function bindUI() {
    modePrompt?.classList.remove('show');
    updateRadiusReadouts();

    radiusInput?.addEventListener('input', () => {
        state.radiusMeters = getActiveRadiusMeters();
        updateRadiusReadouts();

        if (state.center) {
            applyClassification();
        }
    });

    contextRadiusInput?.addEventListener('input', () => {
        state.contextRadiusMeters = getActiveContextRadiusMeters();
        updateRadiusReadouts();

        if (state.center || state.selectedFeatureIds.size) {
            applyClassification();
        }
    });

    resetRadiusButton?.addEventListener('click', event => {
        event.preventDefault();
        state.radiusMeters = DEFAULT_RADIUS_METERS;
        if (radiusInput) radiusInput.value = String(DEFAULT_RADIUS_METERS);
        updateRadiusReadouts();
        if (state.center || state.selectedFeatureIds.size) {
            applyClassification();
        }
    });

    resetContextRadiusButton?.addEventListener('click', event => {
        event.preventDefault();
        state.contextRadiusMeters = DEFAULT_CONTEXT_RADIUS_METERS;
        if (contextRadiusInput) contextRadiusInput.value = String(DEFAULT_CONTEXT_RADIUS_METERS);
        updateRadiusReadouts();
        if (state.center || state.selectedFeatureIds.size) {
            applyClassification();
        }
    });

    drawAreaButton?.addEventListener('click', () => {
        state.areaSelectionArmed = true;
        drawAreaButton.classList.add('active');
        updateHint('Area circle armed: click anywhere on the map once to draw the target circle.');
    });

    resetButton?.addEventListener('click', () => {
        clearSelection();
        updateModeText();
    });

    syncGeojsonButton?.addEventListener('click', () => {
        void handleSyncGeojsonDataset();
    });

    confirmSimulationButton?.addEventListener('click', () => {
        void handleConfirmSimulation();
    });

    simulationCloseSummaryButton?.addEventListener('click', () => {
        hideSimulationSummaryOverlay();
    });

    simulationDownloadSummaryButton?.addEventListener('click', () => {
        if (state.lastSimulationJob) {
            downloadSimulationSummaryCsv(state.lastSimulationJob);
        }
    });

    simulationDownloadSqlButton?.addEventListener('click', () => {
        const buildingId = getFocusedSummaryBuildingId(state.lastSimulationJob);
        if (state.lastSimulationJob?.job_id && buildingId) {
            downloadBuildingSql(state.lastSimulationJob.job_id, buildingId);
        }
    });

    simulationDownloadHourlyChartButton?.addEventListener('click', () => {
        downloadHourlyChartPng();
    });

    simulationSaveToListButton?.addEventListener('click', () => {
        if (state.lastSimulationJob) {
            addToSimulationHistory(state.lastSimulationJob);
            renderSimulationHistoryPanel();
            hideSimulationSummaryOverlay();
        }
    });


    simResultsSelectAll?.addEventListener('click', () => {
        const history = getCurrentModeHistory();
        const allSelected = history.length > 0 && history.every(item => item.selected);
        history.forEach(item => { item.selected = !allSelected; });
        renderSimulationHistoryPanel();
    });

    simResultsClear?.addEventListener('click', () => {
        const modeKey = state.mode === 'single' ? 'single' : 'area';
        state.simulationHistory[modeKey] = [];
        renderSimulationHistoryPanel();
    });

    simResultsExportCsv?.addEventListener('click', () => {
        const selected = getCurrentModeHistory().filter(item => item.selected);
        if (!selected.length) {
            window.alert('Please select at least one building to export.');
            return;
        }
        downloadHistoryCsv(selected);
    });

    simResultsDownloadGeojson?.addEventListener('click', () => {
        const selected = getCurrentModeHistory().filter(item => item.selected);
        if (!selected.length) {
            window.alert('Please select at least one building to export.');
            return;
        }
        downloadHistoryGeoJSON(selected);
    });

    simulationHourlyRangeStart?.addEventListener('input', () => {
        setHourlyWindowRange(Number(simulationHourlyRangeStart.value) || 0, state.hourlyChart.windowStart + state.hourlyChart.windowSize);
    });

    simulationHourlyRangeEnd?.addEventListener('input', () => {
        setHourlyWindowRange(state.hourlyChart.windowStart, Number(simulationHourlyRangeEnd.value) || state.hourlyChart.windowSize);
    });

    simulationHourlyMonth?.addEventListener('change', () => {
        const start = Number(simulationHourlyMonth.value);
        if (Number.isFinite(start)) {
            setHourlyWindowRange(start, Math.min(start + state.hourlyChart.windowSize, state.hourlyChart.labels.length));
        }
    });

    buildingEditorClose?.addEventListener('click', () => {
        closeBuildingEditor();
    });

    buildingEditorSaveBuilding?.addEventListener('click', () => {
        void saveBuildingEditorParameters('building');
    });

    buildingEditorSaveArchetype?.addEventListener('click', () => {
        void saveBuildingEditorParameters('archetype');
    });

    buildingEditorDownloadBuilding?.addEventListener('click', () => {
        downloadBuildingEditorJson();
    });

    buildingEditorDownloadTemplate?.addEventListener('click', () => {
        void syncBuildingTemplateIdf();
    });

    scheduleHeightInput?.addEventListener('input', () => {
        state.buildingEditor.scheduleHeight = Number(scheduleHeightInput.value) || 150;
        renderScheduleCharts();
    });

    scheduleResetAll?.addEventListener('click', () => {
        state.buildingEditor.scheduleValues = getBuildingEditorScheduleResetValues();
        renderScheduleCharts();
    });

    window.addEventListener('pointermove', event => {
        handleSchedulePointerMove(event);
    });

    window.addEventListener('pointerup', () => {
        const drag = state.buildingEditor.activeScheduleDrag;
        state.buildingEditor.activeScheduleDrag = null;
        if (drag?.key) {
            const canvas = scheduleChartGrid?.querySelector(`[data-schedule-canvas="${drag.key}"]`);
            if (canvas) {
                drawScheduleCanvas(canvas, drag.key);
            }
        }
    });
}

function bindMapInteractions() {
    const interactiveLayers = ['simulation-buildings-fill'];

    state.map.on('mousemove', event => {
        const features = state.map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
        const canvas = state.map.getCanvas();
        canvas.style.cursor = state.areaSelectionArmed ? 'crosshair' : features.length ? 'pointer' : '';
    });

    state.map.on('click', event => {
        if (state.areaSelectionArmed) {
            state.areaSelectionArmed = false;
            state.selectionGeometryMode = 'area';
            state.mode = 'buildings';
            state.center = [event.lngLat.lng, event.lngLat.lat];
            state.selectedFeatureId = null;
            drawAreaButton?.classList.remove('active');
            applyClassification();
            return;
        }

        const features = state.map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
        if (!features.length) {
            updateHint('Click directly on a building, or use the circle button to select an area.');
            return;
        }

        const selectedFeature = features[0];
        const selectedUid = String(selectedFeature?.properties?.simulation_uid ?? selectedFeature.id ?? '');
        const centroid = turf.centroid(selectedFeature);

        state.selectionGeometryMode = 'buildings';
        state.areaSelectionArmed = false;
        drawAreaButton?.classList.remove('active');

        if (state.selectedFeatureIds.has(selectedUid)) {
            state.selectedFeatureIds.delete(selectedUid);
        } else {
            if (state.selectedFeatureIds.size >= MAX_TARGET_BUILDINGS) {
                window.alert(`You can select up to ${MAX_TARGET_BUILDINGS} buildings for one simulation.`);
                updateHint(`Selection limit reached: ${MAX_TARGET_BUILDINGS} buildings.`);
                return;
            }

            state.selectedFeatureIds.add(selectedUid);
            state.center = centroid.geometry.coordinates;
        }

        state.selectedFeatureId = state.selectedFeatureIds.size === 1
            ? Array.from(state.selectedFeatureIds)[0]
            : null;

        if (!state.selectedFeatureIds.size) {
            state.center = null;
        }

        applyClassification();
        return;

        /*
        if (state.mode === 'single') {
            if (selectedMeta?.invalid) {
                clearSelection();
                window.alert('This building is invalid for single-building simulation. Please choose a building with height ≥ 3 m and a known archetype.');
                updateHint('Single building mode: please click a valid building.');
                return;
            }

            state.selectedFeatureId = selectedUid;
            state.center = centroid.geometry.coordinates;
            applyClassification();
            return;
        }

        state.selectedFeatureId = null;
        state.center = centroid.geometry.coordinates;
        applyClassification();
        */
    });

    state.map.on('dblclick', event => {
        const features = state.map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
        if (!features.length) {
            updateHint('Double-click directly on a building to edit its simulation parameters.');
            return;
        }

        openBuildingEditor(features[0]);
    });
}

function applyClassification() {
    if (!state.map?.getSource('simulation-buildings')) {
        return;
    }

    state.radiusMeters = getActiveRadiusMeters();
    state.contextRadiusMeters = getActiveContextRadiusMeters();
    updateRadiusReadouts();

    const isAreaSelection = state.selectionGeometryMode === 'area' && state.center;
    const centerPoint = state.center ? turf.point(state.center) : null;
    const targetRadiusMeters = state.radiusMeters;
    const contextBufferMeters = state.contextRadiusMeters;
    const contextOuterRadiusMeters = targetRadiusMeters + contextBufferMeters;
    const targetZone = isAreaSelection
        ? turf.circle(state.center, targetRadiusMeters / 1000, { steps: 80, units: 'kilometers' })
        : emptyFeatureCollection();
    const selectedUids = new Set(state.selectedFeatureIds);

    if (isAreaSelection) {
        const remainingCapacity = Math.max(0, MAX_TARGET_BUILDINGS - selectedUids.size);

        state.geojson.features
            .map((feature, index) => {
                const meta = state.buildingMeta[index];
                const distanceMeters = turf.distance(centerPoint, meta.centroid, { units: 'kilometers' }) * 1000;
                return {
                    uid: String(feature?.properties?.simulation_uid ?? feature.id ?? ''),
                    distanceMeters
                };
            })
            .filter(item => item.distanceMeters <= targetRadiusMeters)
            .filter(item => !selectedUids.has(item.uid))
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, remainingCapacity)
            .forEach(item => selectedUids.add(item.uid));

        state.selectedFeatureIds = selectedUids;
        state.selectedFeatureId = selectedUids.size === 1 ? Array.from(selectedUids)[0] : null;
    }

    const contextZone = buildContextZoneGeometry({
        selectedUids,
        isAreaSelection,
        contextOuterRadiusMeters,
        contextBufferMeters
    });

    const counts = {
        target: 0,
        invalid: 0,
        context: 0
    };

    state.geojson.features.forEach((feature, index) => {
        const meta = state.buildingMeta[index];
        const distanceMeters = centerPoint ? turf.distance(centerPoint, meta.centroid, { units: 'kilometers' }) * 1000 : Infinity;
        const featureUid = String(feature?.properties?.simulation_uid ?? feature.id ?? '');
        const isSelectedTarget = selectedUids.has(featureUid);

        let role = 'background';

        if (isSelectedTarget) {
            role = meta.invalid ? 'invalid' : 'target';
        } else if (isWithinSelectionContext({
            meta,
            selectedUids,
            isAreaSelection,
            distanceMeters,
            targetRadiusMeters,
            contextOuterRadiusMeters,
            contextBufferMeters
        })) {
            role = 'context';
        }

        feature.properties.simulation_role = role;

        if (role === 'target') counts.target += 1;
        if (role === 'invalid') counts.invalid += 1;
        if (role === 'context') counts.context += 1;
    });

    state.map.getSource('simulation-buildings').setData(state.geojson);
    state.map.getSource('target-zone').setData(targetZone);
    state.map.getSource('context-zone').setData(contextZone);

    state.roleCounts = counts;

    if (targetCount) targetCount.textContent = String(counts.target);
    if (invalidCount) invalidCount.textContent = String(counts.invalid);
    if (contextCount) contextCount.textContent = String(counts.context);

    const modeLabel = isAreaSelection ? 'Area circle' : 'Building';
    const capNote = isAreaSelection && selectedUids.size >= MAX_TARGET_BUILDINGS ? ` Selection capped at ${MAX_TARGET_BUILDINGS} buildings.` : '';
    updateHint(`${modeLabel} selection ready.${capNote} Ice blue = valid target buildings, dark gray = invalid target buildings, light gray = context buildings.`);
}

function buildContextZoneGeometry({ selectedUids, isAreaSelection, contextOuterRadiusMeters, contextBufferMeters }) {
    const contextFeatures = [];

    if (isAreaSelection && state.center) {
        contextFeatures.push(turf.circle(state.center, contextOuterRadiusMeters / 1000, { steps: 80, units: 'kilometers' }));
    }

    contextFeatures.push(...buildSelectedBuildingContextFeatures(contextBufferMeters, selectedUids));

    return mergeContextFeatures(contextFeatures);
}

function buildSelectedBuildingContextFeatures(contextRadiusMeters, selectedUids = state.selectedFeatureIds) {
    if (!selectedUids?.size) {
        return [];
    }

    return state.buildingMeta
        .filter(meta => selectedUids.has(meta.uid))
        .map(meta => turf.circle(meta.centroid.geometry.coordinates, contextRadiusMeters / 1000, { steps: 48, units: 'kilometers' }));
}

function mergeContextFeatures(features) {
    if (!features.length) {
        return emptyFeatureCollection();
    }

    if (features.length === 1) {
        return {
            type: 'FeatureCollection',
            features
        };
    }

    try {
        const merged = turf.union({
            type: 'FeatureCollection',
            features
        });

        if (merged) {
            return {
                type: 'FeatureCollection',
                features: [merged]
            };
        }
    } catch (error) {
        console.warn('Unable to merge context radius outlines.', error);
    }

    return {
        type: 'FeatureCollection',
        features
    };
}

function isWithinSelectedBuildingContext(meta, contextRadiusMeters, selectedUids = state.selectedFeatureIds) {
    if (!selectedUids?.size) {
        return false;
    }

    return state.buildingMeta
        .filter(targetMeta => selectedUids.has(targetMeta.uid))
        .some(targetMeta => {
            const distanceMeters = turf.distance(targetMeta.centroid, meta.centroid, { units: 'kilometers' }) * 1000;
            return distanceMeters <= contextRadiusMeters;
        });
}

function isWithinSelectionContext({
    meta,
    selectedUids,
    isAreaSelection,
    distanceMeters,
    targetRadiusMeters,
    contextOuterRadiusMeters,
    contextBufferMeters
}) {
    if (isAreaSelection && distanceMeters > targetRadiusMeters && distanceMeters <= contextOuterRadiusMeters) {
        return true;
    }

    return isWithinSelectedBuildingContext(meta, contextBufferMeters, selectedUids);
}

function clearSelection() {
    state.center = null;
    state.selectedFeatureId = null;
    state.selectedFeatureIds.clear();
    state.areaSelectionArmed = false;
    state.selectionGeometryMode = 'buildings';
    state.lastSimulationJob = null;
    state.roleCounts = {
        target: 0,
        invalid: 0,
        context: 0
    };

    hideSimulationProgressOverlay();
    hideSimulationSummaryOverlay();

    if (radiusInput) {
        radiusInput.value = String(state.radiusMeters || DEFAULT_RADIUS_METERS);
    }

    if (contextRadiusInput) {
        contextRadiusInput.value = String(state.contextRadiusMeters || DEFAULT_CONTEXT_RADIUS_METERS);
    }

    drawAreaButton?.classList.remove('active');
    updateRadiusReadouts();

    if (state.geojson) {
        state.geojson.features.forEach(feature => {
            feature.properties.simulation_role = 'background';
        });
    }

    if (state.map?.getSource('simulation-buildings')) {
        state.map.getSource('simulation-buildings').setData(state.geojson);
    }

    if (state.map?.getSource('target-zone')) {
        state.map.getSource('target-zone').setData(emptyFeatureCollection());
    }

    if (state.map?.getSource('context-zone')) {
        state.map.getSource('context-zone').setData(emptyFeatureCollection());
    }

    if (targetCount) targetCount.textContent = '0';
    if (invalidCount) invalidCount.textContent = '0';
    if (contextCount) contextCount.textContent = '0';
    if (simulationResult) {
        simulationResult.classList.remove('show');
        simulationResult.textContent = '';
    }
}

function setConfirmButtonState(disabled = false) {
    if (!confirmSimulationButton) {
        return;
    }

    confirmSimulationButton.disabled = disabled;
}

function formatStageLabel(stage) {
    return String(stage || 'queued')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, match => match.toUpperCase());
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDisplayNumber(value, digits = 1, useGrouping = false) {
    if (value === null || value === undefined || value === '') {
        return '--';
    }

    const number = Number(value);
    if (!Number.isFinite(number)) {
        return '--';
    }

    return number.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping
    });
}

function setSimulationProgressState({ progress = 0, stage = 'queued', message = 'Preparing the simulation request.' } = {}) {
    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));

    if (simulationProgressBar) simulationProgressBar.style.width = `${safeProgress}%`;
    if (simulationProgressPercent) simulationProgressPercent.textContent = `${Math.round(safeProgress)}%`;
    if (simulationProgressStage) simulationProgressStage.textContent = formatStageLabel(stage);
    if (simulationProgressMessage) simulationProgressMessage.textContent = message;
}

function showSimulationProgressOverlay() {
    simulationSummaryOverlay?.classList.remove('show');
    simulationSummaryOverlay?.setAttribute('aria-hidden', 'true');
    simulationProgressOverlay?.classList.add('show');
    simulationProgressOverlay?.setAttribute('aria-hidden', 'false');
}

function hideSimulationProgressOverlay() {
    simulationProgressOverlay?.classList.remove('show');
    simulationProgressOverlay?.setAttribute('aria-hidden', 'true');
}

function showSimulationSummaryOverlay() {
    simulationSummaryOverlay?.classList.add('show');
    simulationSummaryOverlay?.setAttribute('aria-hidden', 'false');
}

function hideSimulationSummaryOverlay() {
    simulationSummaryOverlay?.classList.remove('show');
    simulationSummaryOverlay?.setAttribute('aria-hidden', 'true');
    state.focusedSummaryBuildingId = null;
}

function getSimulationModeLabel(mode) {
    if (mode === 'single_building') {
        return 'Single building';
    }

    if (mode === 'circular_cluster') {
        return 'Area cluster';
    }

    return state.mode === 'single' ? 'Single building' : 'Area cluster';
}

function getContextLabel(summary = {}) {
    return summary.mode === 'circular_cluster'
        ? `Context ring ${summary.target_radius_m ?? '--'}–${summary.context_radius_m ?? '--'} m`
        : `Context radius ${summary.context_radius_m ?? '--'} m`;
}

function renderSummaryCards(container, items) {
    if (!container) {
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="sim-summary-item">
            <span class="sim-summary-label">${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(item.value)}</strong>
        </div>
    `).join('');
}

function renderSummaryList(container, items) {
    if (!container) {
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="sim-average-row">
            <span class="sim-average-label">${escapeHtml(item.label)}</span>
            <strong class="sim-average-value">${escapeHtml(item.value)}</strong>
        </div>
    `).join('');
}

function getPerBuildingRows(job) {
    const runnerResults = job?.result?.artifacts?.runner_result?.results || [];
    const parsedRows = runnerResults.map(run => {
        const metrics = run?.parsed_results?.metrics || {};
        const metricValues = [
            metrics.total_eui_kwh_m2,
            metrics.cooling_eui_kwh_m2,
            metrics.heating_eui_kwh_m2,
            metrics.lighting_eui_kwh_m2,
            metrics.equipment_eui_kwh_m2,
            metrics.hot_water_eui_kwh_m2
        ];

        return {
            buildingId: String(run?.building_id ?? '--'),
            jobId: String(run?.job_id ?? ''),
            status: String(run?.status ?? 'unknown'),
            totalEui: metrics.total_eui_kwh_m2 ?? metrics.annual_site_eui_kwh_m2 ?? null,
            coolingEui: metrics.cooling_eui_kwh_m2 ?? null,
            heatingEui: metrics.heating_eui_kwh_m2 ?? null,
            lightingEui: metrics.lighting_eui_kwh_m2 ?? null,
            equipmentEui: metrics.equipment_eui_kwh_m2 ?? null,
            hotWaterEui: metrics.hot_water_eui_kwh_m2 ?? null,
            grossFloorAreaM2: metrics.gross_floor_area_m2 ?? run?.gross_floor_area_m2 ?? null,
            hasSql: Boolean(run?.artifacts?.sql),
            hasMetrics: metricValues.some(value => Number.isFinite(Number(value)))
        };
    });

    if (parsedRows.length) {
        return parsedRows;
    }

    const fallbackIds = job?.submitted_payload?.targets?.valid_building_ids || [];
    const metrics = job?.result?.metrics || {};

    if (!fallbackIds.length) {
        return [];
    }

    return fallbackIds.map(buildingId => ({
        buildingId: String(buildingId),
        jobId: String(job?.job_id ?? ''),
        status: String(job?.status || 'completed'),
        totalEui: fallbackIds.length === 1 ? (metrics.total_eui_kwh_m2 ?? metrics.annual_site_eui_kwh_m2 ?? null) : null,
        coolingEui: fallbackIds.length === 1 ? (metrics.cooling_eui_kwh_m2 ?? null) : null,
        heatingEui: fallbackIds.length === 1 ? (metrics.heating_eui_kwh_m2 ?? null) : null,
        lightingEui: fallbackIds.length === 1 ? (metrics.lighting_eui_kwh_m2 ?? null) : null,
        equipmentEui: fallbackIds.length === 1 ? (metrics.equipment_eui_kwh_m2 ?? null) : null,
        hotWaterEui: fallbackIds.length === 1 ? (metrics.hot_water_eui_kwh_m2 ?? null) : null,
        grossFloorAreaM2: fallbackIds.length === 1 ? (metrics.gross_floor_area_m2 ?? null) : null,
        hasSql: false,
        hasMetrics: fallbackIds.length === 1
    }));
}

function populateSimulationSummary(job) {
    const result = job?.result || {};
    const summary = result.summary || {};
    const metrics = result.metrics || {};
    const rows = getPerBuildingRows(job);
    const runnerResults = job?.result?.artifacts?.runner_result?.results || [];
    const failedRuns = Number(summary.runner_failed_runs ?? 0);
    const firstRunError = runnerResults.find(item => item?.error)?.error || '';
    const usingFallback = summary.eui_source !== 'energyplus_annual_outputs';
    const targetCountValue = Number(summary.target_buildings ?? rows.length ?? 0);
    const showTable = targetCountValue > 1 && rows.length > 1;
    const focusedBuildingId = getFocusedSummaryBuildingId(job);
    const availableRows = rows.filter(row => row.hasMetrics).length;
    const sourceLabel = summary.eui_source === 'energyplus_annual_outputs' ? 'Annual EnergyPlus output' : 'Preview / fallback output';

    if (simulationSummaryTitle) {
        simulationSummaryTitle.textContent = summary.eui_source === 'energyplus_annual_outputs'
            ? 'Annual Energy Simulation Summary'
            : 'Energy Simulation Preview Summary';
    }

    if (simulationSummaryMessage) {
        simulationSummaryMessage.textContent = usingFallback
            ? `Job ${job?.job_id || 'n/a'} is showing fallback preview values because the backend EnergyPlus run did not produce annual outputs yet.${firstRunError ? ` First backend error: ${firstRunError}` : ''}`
            : `Job ${job?.job_id || 'n/a'} finished in ${getSimulationModeLabel(summary.mode)} mode.`;
    }

    const isSingleMode = summary.mode === 'single_building';
    const archetypeKey = config.ml_archetype_property || 'building_archetype';
    const singleFeature = isSingleMode
        ? state.geojson?.features?.find(f => String(f?.properties?.simulation_uid ?? f.id ?? '') === String(focusedBuildingId || state.selectedFeatureId))
        : null;
    const rawArchetype = singleFeature?.properties?.[archetypeKey] || '';
    const normalizedArchetype = rawArchetype.replace(/_/g, ' ');
    const archetypeDisplay = normalizedArchetype
        ? normalizedArchetype.charAt(0).toUpperCase() + normalizedArchetype.slice(1)
        : '--';
    const firstOverviewCard = isSingleMode
        ? { label: 'Archetype', value: archetypeDisplay }
        : { label: 'Mode', value: getSimulationModeLabel(summary.mode) };

    renderSummaryCards(simulationOverviewGrid, [
        firstOverviewCard,
        { label: 'Result Source', value: sourceLabel },
        { label: 'Targets / Shading', value: `${summary.target_buildings ?? '--'} / ${summary.shading_buildings ?? '--'}` },
        { label: 'Context', value: getContextLabel(summary) },
    ]);

    renderSummaryList(simulationAverageGrid, [
        { label: 'Total EUI', value: `${formatDisplayNumber(metrics.total_eui_kwh_m2 ?? metrics.annual_site_eui_kwh_m2)} kWh/m²·yr` },
        { label: 'Cooling EUI', value: `${formatDisplayNumber(metrics.cooling_eui_kwh_m2)} kWh/m²·yr` },
        { label: 'Heating EUI', value: `${formatDisplayNumber(metrics.heating_eui_kwh_m2)} kWh/m²·yr` },
        { label: 'Lighting EUI', value: `${formatDisplayNumber(metrics.lighting_eui_kwh_m2)} kWh/m²·yr` },
        { label: 'Equipment EUI', value: `${formatDisplayNumber(metrics.equipment_eui_kwh_m2)} kWh/m²·yr` },
        { label: 'Hot Water EUI', value: `${formatDisplayNumber(metrics.hot_water_eui_kwh_m2)} kWh/m²·yr` },
    ]);

    if (simulationTableSection) {
        simulationTableSection.style.display = showTable ? 'flex' : 'none';
    }

    if (simulationTableNote) {
        simulationTableNote.textContent = showTable
            ? `Rows with parsed building-level outputs: ${availableRows}/${rows.length}. “--” means that metric is not available yet for that run.${failedRuns && firstRunError ? ` Backend runner error: ${firstRunError}` : ''}`
            : usingFallback && firstRunError
                ? `Single-building runs are summarized above. The current values are fallback preview metrics because the backend runner returned: ${firstRunError}`
                : 'Single-building runs are summarized above in the Average Results section.';
    }

    if (simulationDownloadSqlButton) {
        const focusedRow = rows.find(row => row.buildingId === focusedBuildingId);
        simulationDownloadSqlButton.style.display = isSingleMode ? 'inline-flex' : 'none';
        simulationDownloadSqlButton.disabled = !job?.job_id || !focusedBuildingId || !focusedRow?.hasSql;
        simulationDownloadSqlButton.title = focusedRow?.hasSql ? 'Download the EnergyPlus SQL for this building.' : 'SQL is not available for this building yet.';
    }

    if (simulationResultsTableBody) {
        if (!rows.length) {
            simulationResultsTableBody.innerHTML = '<tr><td colspan="9">No per-building simulation rows are available yet.</td></tr>';
            return;
        }

        simulationResultsTableBody.innerHTML = rows.map(row => {
            const normalizedStatus = String(row.status || 'unknown').toLowerCase();
            const statusClass = normalizedStatus === 'completed'
                ? 'is-completed'
                : normalizedStatus === 'failed'
                    ? 'is-failed'
                    : 'is-partial';

            return `
                <tr>
                    <td title="${escapeHtml(row.buildingId)}">${escapeHtml(row.buildingId)}</td>
                    <td>${formatDisplayNumber(row.totalEui, 2)}</td>
                    <td>${formatDisplayNumber(row.coolingEui, 2)}</td>
                    <td>${formatDisplayNumber(row.heatingEui, 2)}</td>
                    <td>${formatDisplayNumber(row.lightingEui, 2)}</td>
                    <td>${formatDisplayNumber(row.equipmentEui, 2)}</td>
                    <td>${formatDisplayNumber(row.hotWaterEui, 2)}</td>
                    <td><span class="sim-status-badge ${statusClass}">${escapeHtml(formatStageLabel(row.status))}</span></td>
                    <td>
                        <button
                            class="sim-table-sql-btn"
                            type="button"
                            data-sql-building-id="${escapeHtml(row.buildingId)}"
                            ${row.hasSql ? '' : 'disabled'}
                        >Save SQL</button>
                    </td>
                </tr>
            `;
        }).join('');

        simulationResultsTableBody.querySelectorAll('[data-sql-building-id]').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                const buildingId = button.getAttribute('data-sql-building-id');
                if (job?.job_id && buildingId) {
                    downloadBuildingSql(job.job_id, buildingId);
                }
            });
        });
    }

    if (isSingleMode && focusedBuildingId && job?.job_id) {
        void loadHourlyOutputsForSummary(job.job_id, focusedBuildingId);
    } else {
        hideHourlyOutputs();
    }
}

function getFocusedSummaryBuildingId(job) {
    if (state.focusedSummaryBuildingId) {
        return String(state.focusedSummaryBuildingId);
    }

    const rows = getPerBuildingRows(job);
    if (rows.length === 1) {
        return rows[0].buildingId;
    }

    const submittedIds = job?.submitted_payload?.targets?.valid_building_ids || [];
    return submittedIds.length === 1 ? String(submittedIds[0]) : '';
}

function downloadBuildingSql(jobId, buildingId) {
    const serviceUrl = config.simulation_service_url || 'http://localhost:8010';
    const link = document.createElement('a');
    link.href = getBuildingSqlDownloadUrl({ jobId, buildingId, serviceUrl });
    link.download = `${sanitizeFilename(buildingId)}_eplusout.sql`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function hideHourlyOutputs() {
    simulationHourlySection?.classList.remove('show');
    document.querySelector('.sim-summary-body')?.classList.remove('hide-scrollbar');
    state.hourlyChart.labels = [];
    state.hourlyChart.series = [];
    state.hourlyChart.selectedKeys = new Set();
    if (simulationDownloadHourlyChartButton) {
        simulationDownloadHourlyChartButton.disabled = true;
    }
    if (simulationHourlyMonth) {
        simulationHourlyMonth.innerHTML = '';
    }
    updateHourlyTimeControls();
}

async function loadHourlyOutputsForSummary(jobId, buildingId) {
    if (!simulationHourlySection || !simulationHourlyCanvas || !simulationHourlySeriesList) {
        return;
    }

    simulationHourlySection.classList.add('show');
    document.querySelector('.sim-summary-body')?.classList.add('hide-scrollbar');
    if (simulationHourlyNote) {
        simulationHourlyNote.textContent = 'Loading hourly SQL outputs...';
    }

    try {
        const payload = await getBuildingHourlyOutputs({
            jobId,
            buildingId,
            serviceUrl: config.simulation_service_url || 'http://localhost:8010'
        });

        state.hourlyChart.jobId = jobId;
        state.hourlyChart.buildingId = buildingId;
        state.hourlyChart.labels = payload.labels || [];
        state.hourlyChart.series = normalizeHourlySeries(payload.series || [], state.hourlyChart.labels);
        state.hourlyChart.selectedKeys = new Set(state.hourlyChart.series.map(item => item.key));
        state.hourlyChart.windowSize = 24 * 7;
        state.hourlyChart.windowStart = getDefaultHourlyWindowStart();
        state.hourlyChart.windowSize = Math.min(24 * 7, Math.max(24, state.hourlyChart.labels.length - state.hourlyChart.windowStart));
        if (simulationDownloadHourlyChartButton) {
            simulationDownloadHourlyChartButton.disabled = !state.hourlyChart.series.length;
        }

        renderHourlyMonthOptions();
        updateHourlyTimeControls();
        renderHourlySeriesList();
        renderHourlyChart();
    } catch (error) {
        state.hourlyChart.labels = [];
        state.hourlyChart.series = [];
        if (simulationHourlyNote) {
            simulationHourlyNote.textContent = error?.message || 'Hourly outputs could not be read from the SQL file.';
        }
        if (simulationHourlySeriesList) {
            simulationHourlySeriesList.innerHTML = '<div class="sim-results-empty">Hourly outputs are unavailable for this run.</div>';
        }
        if (simulationHourlyMonth) {
            simulationHourlyMonth.innerHTML = '';
        }
        if (simulationDownloadHourlyChartButton) {
            simulationDownloadHourlyChartButton.disabled = true;
        }
        updateHourlyTimeControls();
        renderHourlyChart();
    }
}

function getDefaultHourlyWindowStart() {
    const totalHours = state.hourlyChart.labels.length;
    if (totalHours <= state.hourlyChart.windowSize) {
        return 0;
    }
    return Math.round(((totalHours - state.hourlyChart.windowSize) / 2) / 24) * 24;
}

function getHourlyMaxWindowEnd() {
    return Math.max(0, state.hourlyChart.labels.length);
}

function normalizeHourlyStep(value) {
    return Math.round((Number(value) || 0) / 24) * 24;
}

function setHourlyWindowRange(startValue, endValue) {
    const maxEnd = getHourlyMaxWindowEnd();
    let start = Math.max(0, Math.min(maxEnd, normalizeHourlyStep(startValue)));
    let end = Math.max(0, Math.min(maxEnd, normalizeHourlyStep(endValue)));
    const minSpan = Math.min(24, maxEnd);

    if (end - start < minSpan) {
        if (simulationHourlyRangeStart && document.activeElement === simulationHourlyRangeStart) {
            start = Math.max(0, end - minSpan);
        } else {
            end = Math.min(maxEnd, start + minSpan);
        }
    }

    state.hourlyChart.windowStart = start;
    state.hourlyChart.windowSize = Math.max(minSpan, end - start);
    updateHourlyTimeControls();
    renderHourlyChart();
}

function updateHourlyTimeControls() {
    const maxEnd = getHourlyMaxWindowEnd();
    const start = state.hourlyChart.windowStart || 0;
    const end = Math.min(maxEnd, start + state.hourlyChart.windowSize);
    const disabled = maxEnd <= 24;

    [simulationHourlyRangeStart, simulationHourlyRangeEnd].forEach(input => {
        if (!input) return;
        input.min = '0';
        input.max = String(maxEnd);
        input.step = '24';
        input.disabled = disabled;
    });

    if (simulationHourlyRangeStart) {
        simulationHourlyRangeStart.value = String(start);
    }
    if (simulationHourlyRangeEnd) {
        simulationHourlyRangeEnd.value = String(end);
    }
    if (simulationHourlyRangeFill) {
        const startPct = maxEnd > 0 ? (start / maxEnd) * 100 : 0;
        const endPct = maxEnd > 0 ? (end / maxEnd) * 100 : 0;
        simulationHourlyRangeFill.style.left = `${startPct}%`;
        simulationHourlyRangeFill.style.width = `${Math.max(0, endPct - startPct)}%`;
    }
    if (simulationHourlyMonth && state.hourlyChart.labels.length) {
        const currentMonth = getMonthFromHourlyLabel(state.hourlyChart.labels[start]);
        const monthOption = Array.from(simulationHourlyMonth.options).find(option => Number(option.dataset.month) === currentMonth);
        if (monthOption) {
            simulationHourlyMonth.value = monthOption.value;
        }
    }
}

function renderHourlyMonthOptions() {
    if (!simulationHourlyMonth) {
        return;
    }

    const seen = new Set();
    const options = [];
    state.hourlyChart.labels.forEach((label, index) => {
        const month = getMonthFromHourlyLabel(label);
        if (!month || seen.has(month)) {
            return;
        }
        seen.add(month);
        options.push(`<option value="${index}" data-month="${month}">${getMonthName(month)}</option>`);
    });

    simulationHourlyMonth.innerHTML = options.join('');
}

function getMonthFromHourlyLabel(label) {
    const month = Number(String(label || '').split('/')[0]);
    return Number.isFinite(month) ? month : 0;
}

function getMonthName(month) {
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] || 'Month';
}

const HOURLY_SERIES_ORDER = ['total_electricity', 'cooling', 'heating', 'fans_pumps', 'lighting', 'equipment', 'hot_water'];

function normalizeHourlySeries(series = [], labels = []) {
    const labelCount = labels.length;
    const normalized = (Array.isArray(series) ? series : []).map(item => {
        const values = Array.isArray(item.values) ? item.values.slice(0, labelCount) : [];
        while (values.length < labelCount) {
            values.push(0);
        }
        return { ...item, values };
    });

    if (labelCount && !normalized.some(item => item.key === 'heating')) {
        normalized.push({
            key: 'heating',
            label: 'Heating',
            unit: 'kWh',
            values: Array.from({ length: labelCount }, () => 0)
        });
    }

    return normalized.sort((a, b) => {
        const aOrder = HOURLY_SERIES_ORDER.indexOf(a.key);
        const bOrder = HOURLY_SERIES_ORDER.indexOf(b.key);
        const normalizedAOrder = aOrder === -1 ? Number.MAX_SAFE_INTEGER : aOrder;
        const normalizedBOrder = bOrder === -1 ? Number.MAX_SAFE_INTEGER : bOrder;
        if (normalizedAOrder !== normalizedBOrder) {
            return normalizedAOrder - normalizedBOrder;
        }
        return String(a.label || a.key).localeCompare(String(b.label || b.key));
    });
}

const HOURLY_SERIES_COLORS = {
    total: '#55efc4',
    total_electricity: '#55efc4',
    cooling: '#A5F3FC',
    heating: '#ef441e',
    fans_pumps: '#788486',
    lighting: '#FFFF00',
    equipment: '#E0E0E0',
    hot_water: '#8a4b22'
};

function getHourlySeriesColor(key, index = 0) {
    const fallback = ['#55efc4', '#A5F3FC', '#ef441e', '#788486', '#FFFF00', '#E0E0E0', '#8a4b22'];
    return HOURLY_SERIES_COLORS[key] || fallback[index % fallback.length];
}

function renderHourlySeriesList() {
    if (!simulationHourlySeriesList) {
        return;
    }

    if (!state.hourlyChart.series.length) {
        simulationHourlySeriesList.innerHTML = '<div class="sim-results-empty">Hourly outputs are unavailable for this run.</div>';
        return;
    }

    simulationHourlySeriesList.innerHTML = state.hourlyChart.series.map((series, index) => {
        const selected = state.hourlyChart.selectedKeys.has(series.key);
        const color = getHourlySeriesColor(series.key, index);
        return `
            <button class="sim-hourly-series-row${selected ? ' selected' : ''}" type="button" data-series-key="${escapeHtml(series.key)}" style="color:${escapeHtml(color)}">
                <span class="sim-hourly-dot"></span>
                <span>${escapeHtml(series.label)}</span>
            </button>
        `;
    }).join('');

    simulationHourlySeriesList.querySelectorAll('[data-series-key]').forEach(button => {
        button.addEventListener('click', () => {
            const key = button.getAttribute('data-series-key');
            if (!key) return;
            if (state.hourlyChart.selectedKeys.has(key)) {
                state.hourlyChart.selectedKeys.delete(key);
            } else {
                state.hourlyChart.selectedKeys.add(key);
            }
            renderHourlySeriesList();
            renderHourlyChart();
        });
    });
}

function renderHourlyChart() {
    const canvas = simulationHourlyCanvas;
    if (!canvas) {
        return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 720));
    const height = Math.max(180, Math.round(rect.height || 230));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const labels = state.hourlyChart.labels;
    const selectedSeries = state.hourlyChart.series.filter(series => state.hourlyChart.selectedKeys.has(series.key));
    const windowStart = Math.max(0, Math.min(state.hourlyChart.windowStart, Math.max(0, labels.length - 1)));
    const windowEnd = Math.min(labels.length, windowStart + state.hourlyChart.windowSize);
    const visibleLabels = labels.slice(windowStart, windowEnd);

    if (simulationHourlyRangeLabel) {
        const firstLabel = visibleLabels[0]?.split(' ')[0] || '--';
        const lastLabel = visibleLabels[visibleLabels.length - 1]?.split(' ')[0] || '--';
        simulationHourlyRangeLabel.textContent = `${firstLabel} - ${lastLabel}`;
    }

    updateHourlyTimeControls();

    const plot = { left: 58, right: width - 16, top: 18, bottom: height - 34 };
    ctx.strokeStyle = '#e4e9ee';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = plot.top + (plot.bottom - plot.top) * (i / 4);
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
    }

    if (!visibleLabels.length || !selectedSeries.length) {
        ctx.fillStyle = '#7a8794';
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.fillText('Select one or more hourly outputs to display.', plot.left, plot.top + 22);
        return;
    }

    const allValues = selectedSeries.flatMap(series => series.values.slice(windowStart, windowEnd));
    const maxValue = Math.max(...allValues, 0.001);
    const yMax = maxValue * 1.08;
    const xStep = visibleLabels.length > 1 ? (plot.right - plot.left) / (visibleLabels.length - 1) : 0;

    ctx.fillStyle = '#687684';
    ctx.font = '12px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        const value = yMax * (1 - i / 4);
        const y = plot.top + (plot.bottom - plot.top) * (i / 4);
        ctx.fillText(formatDisplayNumber(value, value >= 10 ? 0 : 2), plot.left - 8, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
        const index = Math.min(visibleLabels.length - 1, Math.round((visibleLabels.length - 1) * frac));
        const x = plot.left + xStep * index;
        ctx.fillText((visibleLabels[index] || '').split(' ')[0], x, plot.bottom + 10);
    });

    selectedSeries.forEach((series, index) => {
        const values = series.values.slice(windowStart, windowEnd);
        const sourceIndex = state.hourlyChart.series.findIndex(item => item.key === series.key);
        ctx.strokeStyle = getHourlySeriesColor(series.key, sourceIndex >= 0 ? sourceIndex : index);
        ctx.lineWidth = 2;
        ctx.beginPath();
        values.forEach((value, pointIndex) => {
            const x = plot.left + xStep * pointIndex;
            const y = plot.bottom - (Number(value || 0) / yMax) * (plot.bottom - plot.top);
            if (pointIndex === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });
}

function downloadHourlyChartPng() {
    if (!simulationHourlyCanvas || !state.hourlyChart.labels.length) {
        return;
    }

    renderHourlyChart();

    const sourceCanvas = simulationHourlyCanvas;
    const selectedSeries = state.hourlyChart.series.filter(series => state.hourlyChart.selectedKeys.has(series.key));
    const dpr = window.devicePixelRatio || 1;
    const legendWidth = Math.round(230 * dpr);
    const padding = Math.round(18 * dpr);
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = sourceCanvas.width + legendWidth;
    exportCanvas.height = sourceCanvas.height;

    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);

    const legendLeft = sourceCanvas.width + padding;
    let y = padding + Math.round(10 * dpr);
    ctx.font = `${12 * dpr}px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    selectedSeries.forEach(series => {
        const sourceIndex = state.hourlyChart.series.findIndex(item => item.key === series.key);
        const color = getHourlySeriesColor(series.key, sourceIndex >= 0 ? sourceIndex : 0);
        const radius = 6 * dpr;
        ctx.beginPath();
        ctx.arc(legendLeft + radius, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.fillStyle = '#333333';
        ctx.fillText(series.label, legendLeft + radius * 2 + 9 * dpr, y);
        y += 26 * dpr;
    });

    const buildingSuffix = state.hourlyChart.buildingId ? `_${sanitizeFilename(state.hourlyChart.buildingId)}` : '';
    const link = document.createElement('a');
    link.href = exportCanvas.toDataURL('image/png');
    link.download = buildSimulationFilename(`hourly_outputs${buildingSuffix}`, 'png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

window.addEventListener('resize', () => {
    if (simulationHourlySection?.classList.contains('show')) {
        renderHourlyChart();
    }
});

function buildSimulationFilename(suffix, extension) {
    const configuredPath = String(config.buildings_source?.data || 'buildings.geojson');
    const rawName = configuredPath.split('/').filter(Boolean).pop() || 'buildings.geojson';
    const baseName = rawName.replace(/\.geojson$|\.json$/i, '');
    const timestamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
    return `${baseName}_${suffix}_${timestamp}.${extension}`;
}

function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function csvEscape(value) {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadSimulationSummaryCsv(job) {
    const result = job?.result || {};
    const summary = result.summary || {};
    const metrics = result.metrics || {};
    const rows = getPerBuildingRows(job);
    const lines = [
        ['job_id', job?.job_id || ''],
        ['mode', getSimulationModeLabel(summary.mode)],
        ['result_source', summary.eui_source || 'unknown'],
        ['target_buildings', summary.target_buildings ?? ''],
        ['shading_buildings', summary.shading_buildings ?? ''],
        ['context', getContextLabel(summary)],
        ['average_total_eui_kwh_m2', metrics.total_eui_kwh_m2 ?? metrics.annual_site_eui_kwh_m2 ?? ''],
        ['average_cooling_eui_kwh_m2', metrics.cooling_eui_kwh_m2 ?? ''],
        ['average_heating_eui_kwh_m2', metrics.heating_eui_kwh_m2 ?? ''],
        ['average_lighting_eui_kwh_m2', metrics.lighting_eui_kwh_m2 ?? ''],
        ['average_equipment_eui_kwh_m2', metrics.equipment_eui_kwh_m2 ?? ''],
        ['average_hot_water_eui_kwh_m2', metrics.hot_water_eui_kwh_m2 ?? ''],
        [],
        ['building_id', 'status', 'total_eui_kwh_m2', 'cooling_eui_kwh_m2', 'heating_eui_kwh_m2', 'lighting_eui_kwh_m2', 'equipment_eui_kwh_m2', 'hot_water_eui_kwh_m2']
    ];

    rows.forEach(row => {
        lines.push([
            row.buildingId,
            row.status,
            row.totalEui ?? '',
            row.coolingEui ?? '',
            row.heatingEui ?? '',
            row.lightingEui ?? '',
            row.equipmentEui ?? '',
            row.hotWaterEui ?? ''
        ]);
    });

    const csvContent = lines.map(line => line.map(csvEscape).join(',')).join('\n');
    triggerDownload(csvContent, buildSimulationFilename('summary', 'csv'), 'text/csv;charset=utf-8');
}

function normalizeMetricForExport(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(3)) : null;
}

function downloadSimulationGeoJSON(job) {
    const rows = getPerBuildingRows(job);
    if (!rows.length) {
        window.alert('No building-level simulation result is available for GeoJSON export yet.');
        return;
    }

    const rowMap = new Map(rows.map(row => [String(row.buildingId), row]));
    const exportedGeojson = JSON.parse(JSON.stringify(state.geojson || emptyFeatureCollection()));

    exportedGeojson.features = (exportedGeojson.features || []).map(feature => {
        const properties = feature?.properties || {};
        const featureId = String(properties.simulation_uid ?? properties.id ?? feature?.id ?? '');
        const row = rowMap.get(featureId);

        if (!row) {
            return feature;
        }

        return {
            ...feature,
            properties: {
                ...properties,
                simulation_total_eui_kwh_m2: normalizeMetricForExport(row.totalEui),
                simulation_cooling_eui_kwh_m2: normalizeMetricForExport(row.coolingEui),
                simulation_heating_eui_kwh_m2: normalizeMetricForExport(row.heatingEui),
                simulation_lighting_eui_kwh_m2: normalizeMetricForExport(row.lightingEui),
                simulation_equipment_eui_kwh_m2: normalizeMetricForExport(row.equipmentEui),
                simulation_hot_water_eui_kwh_m2: normalizeMetricForExport(row.hotWaterEui)
            }
        };
    });

    triggerDownload(
        JSON.stringify(exportedGeojson, null, 2),
        buildSimulationFilename('outputs', 'geojson'),
        'application/geo+json'
    );
}

function getCurrentModeHistory() {
    return state.simulationHistory[state.mode === 'single' ? 'single' : 'area'];
}

function addToSimulationHistory(job) {
    const rows = getPerBuildingRows(job);
    const modeKey = state.mode === 'single' ? 'single' : 'area';
    const history = state.simulationHistory[modeKey];
    const archetypeKey = config.ml_archetype_property || 'building_archetype';

    rows.forEach(row => {
        const feature = state.geojson?.features?.find(
            f => String(f?.properties?.simulation_uid ?? f.id ?? '') === String(row.buildingId)
        );
        const rawArchetype = feature?.properties?.[archetypeKey] || '';
        const normalizedArchetype = rawArchetype.replace(/_/g, ' ');
        const archetype = normalizedArchetype
            ? normalizedArchetype.charAt(0).toUpperCase() + normalizedArchetype.slice(1)
            : '--';

        const entry = {
            buildingId: String(row.buildingId),
            archetype,
            eui: row.totalEui,
            coolingEui: row.coolingEui,
            heatingEui: row.heatingEui,
            lightingEui: row.lightingEui,
            equipmentEui: row.equipmentEui,
            hotWaterEui: row.hotWaterEui,
            grossFloorAreaM2: row.grossFloorAreaM2,
            status: row.status,
            jobId: job?.job_id || '',
            hasSql: row.hasSql,
            sourceJob: job,
            selected: true
        };

        const existingIndex = history.findIndex(item => item.buildingId === entry.buildingId);
        if (existingIndex >= 0) {
            history[existingIndex] = { ...history[existingIndex], ...entry };
        } else {
            history.push(entry);
        }
    });
}

function renderSimulationHistoryPanel() {
    if (!simResultsPanel || !simResultsList) {
        return;
    }

    if (!state.mode) {
        simResultsPanel.classList.remove('show');
        return;
    }

    simResultsPanel.classList.add('show');

    const history = getCurrentModeHistory();

    if (!history.length) {
        simResultsList.innerHTML = '<div class="sim-results-empty">No simulations run yet.</div>';
        return;
    }

    simResultsList.innerHTML = history.map((item, index) => `
        <div class="sim-results-row${item.selected ? ' selected' : ''}" data-index="${index}" title="Double-click to open this building's detailed simulation panel.">
            <div class="sim-results-row-check"></div>
            <span class="sim-results-row-id" title="${escapeHtml(item.buildingId)}">${escapeHtml(item.buildingId)}</span>
            <span class="sim-results-row-archetype" title="${escapeHtml(item.archetype)}">${escapeHtml(item.archetype)}</span>
            <span class="sim-results-row-eui">${item.eui != null ? formatDisplayNumber(item.eui, 1) + ' kWh/m²' : '--'}</span>
        </div>
    `).join('');

    simResultsList.querySelectorAll('.sim-results-row').forEach(row => {
        row.addEventListener('click', event => {
            if (event.detail > 1) {
                return;
            }
            const idx = Number(row.dataset.index);
            const hist = getCurrentModeHistory();
            if (hist[idx]) {
                hist[idx].selected = !hist[idx].selected;
                renderSimulationHistoryPanel();
            }
        });

        row.addEventListener('dblclick', () => {
            const idx = Number(row.dataset.index);
            const hist = getCurrentModeHistory();
            if (hist[idx]) {
                openHistoryItemDetail(hist[idx]);
            }
        });
    });
}

function cloneSimulationJob(job) {
    if (!job) {
        return null;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(job);
    }

    return JSON.parse(JSON.stringify(job));
}

function buildHistoryDetailJob(item) {
    const sourceJob = cloneSimulationJob(item.sourceJob);
    const detailMetrics = {
        gross_floor_area_m2: item.grossFloorAreaM2 ?? null,
        total_eui_kwh_m2: item.eui ?? null,
        annual_site_eui_kwh_m2: item.eui ?? null,
        cooling_eui_kwh_m2: item.coolingEui ?? null,
        heating_eui_kwh_m2: item.heatingEui ?? null,
        lighting_eui_kwh_m2: item.lightingEui ?? null,
        equipment_eui_kwh_m2: item.equipmentEui ?? null,
        hot_water_eui_kwh_m2: item.hotWaterEui ?? null,
    };

    if (!sourceJob) {
        return {
            job_id: item.jobId || '',
            status: 'completed',
            submitted_payload: {
                targets: {
                    valid_building_ids: [item.buildingId],
                    invalid_building_ids: []
                }
            },
            result: {
                summary: {
                    mode: 'single_building',
                    target_buildings: 1,
                    shading_buildings: '--',
                    context_radius_m: '--',
                    eui_source: 'energyplus_annual_outputs'
                },
                metrics: detailMetrics,
                artifacts: {
                    runner_result: {
                        results: []
                    }
                }
            }
        };
    }

    const runnerResults = sourceJob?.result?.artifacts?.runner_result?.results || [];
    const focusedRuns = runnerResults.filter(run => String(run?.building_id) === String(item.buildingId));
    const targetSummary = sourceJob.result?.summary || {};

    sourceJob.result = {
        ...(sourceJob.result || {}),
        summary: {
            ...targetSummary,
            mode: 'single_building',
            target_buildings: 1
        },
        metrics: detailMetrics,
        artifacts: {
            ...((sourceJob.result || {}).artifacts || {}),
            runner_result: {
                ...(((sourceJob.result || {}).artifacts || {}).runner_result || {}),
                results: focusedRuns
            }
        }
    };

    sourceJob.submitted_payload = {
        ...(sourceJob.submitted_payload || {}),
        targets: {
            ...((sourceJob.submitted_payload || {}).targets || {}),
            valid_building_ids: [item.buildingId],
            invalid_building_ids: []
        }
    };

    return sourceJob;
}

function openHistoryItemDetail(item) {
    const detailJob = buildHistoryDetailJob(item);
    state.focusedSummaryBuildingId = String(item.buildingId);
    state.lastSimulationJob = detailJob;
    populateSimulationSummary(detailJob);
    showSimulationSummaryOverlay();
}

function downloadHistoryCsv(selectedItems) {
    const lines = [
        ['building_id', 'archetype', 'total_eui_kwh_m2', 'cooling_eui_kwh_m2', 'heating_eui_kwh_m2',
            'lighting_eui_kwh_m2', 'equipment_eui_kwh_m2', 'hot_water_eui_kwh_m2', 'gross_floor_area_m2', 'status']
    ];
    selectedItems.forEach(item => {
        lines.push([
            item.buildingId,
            item.archetype === '--' ? '' : item.archetype,
            item.eui ?? '',
            item.coolingEui ?? '',
            item.heatingEui ?? '',
            item.lightingEui ?? '',
            item.equipmentEui ?? '',
            item.hotWaterEui ?? '',
            item.grossFloorAreaM2 ?? '',
            item.status ?? ''
        ]);
    });
    const csvContent = lines.map(line => line.map(csvEscape).join(',')).join('\n');
    triggerDownload(csvContent, buildSimulationFilename('history', 'csv'), 'text/csv;charset=utf-8');
}

function downloadHistoryGeoJSON(selectedItems) {
    const selectedIds = new Set(selectedItems.map(item => item.buildingId));
    const itemMap = new Map(selectedItems.map(item => [item.buildingId, item]));

    const exportedGeojson = JSON.parse(JSON.stringify(state.geojson || emptyFeatureCollection()));
    exportedGeojson.features = (exportedGeojson.features || [])
        .filter(feature => {
            const props = feature?.properties || {};
            const fid = String(props.simulation_uid ?? props.id ?? feature?.id ?? '');
            return selectedIds.has(fid);
        })
        .map(feature => {
            const props = feature?.properties || {};
            const fid = String(props.simulation_uid ?? props.id ?? feature?.id ?? '');
            const item = itemMap.get(fid);
            if (!item) {
                return feature;
            }
            return {
                ...feature,
                properties: {
                    ...props,
                    simulation_total_eui_kwh_m2: normalizeMetricForExport(item.eui),
                    simulation_cooling_eui_kwh_m2: normalizeMetricForExport(item.coolingEui),
                    simulation_heating_eui_kwh_m2: normalizeMetricForExport(item.heatingEui),
                    simulation_lighting_eui_kwh_m2: normalizeMetricForExport(item.lightingEui),
                    simulation_equipment_eui_kwh_m2: normalizeMetricForExport(item.equipmentEui),
                    simulation_hot_water_eui_kwh_m2: normalizeMetricForExport(item.hotWaterEui),
                    simulation_gross_floor_area_m2: normalizeMetricForExport(item.grossFloorAreaM2)
                }
            };
        });

    triggerDownload(
        JSON.stringify(exportedGeojson, null, 2),
        buildSimulationFilename('history', 'geojson'),
        'application/geo+json'
    );
}

function applySimulationHistoryItemsToGeojson(items) {
    const itemMap = new Map(items.map(item => [String(item.buildingId), item]));

    (state.geojson?.features || []).forEach(feature => {
        const props = feature?.properties || {};
        const featureId = String(props.simulation_uid ?? props.id ?? feature?.id ?? '');
        const item = itemMap.get(featureId);

        if (!item) {
            return;
        }

        feature.properties = {
            ...props,
            simulation_total_eui_kwh_m2: normalizeMetricForExport(item.eui),
            simulation_cooling_eui_kwh_m2: normalizeMetricForExport(item.coolingEui),
            simulation_heating_eui_kwh_m2: normalizeMetricForExport(item.heatingEui),
            simulation_lighting_eui_kwh_m2: normalizeMetricForExport(item.lightingEui),
            simulation_equipment_eui_kwh_m2: normalizeMetricForExport(item.equipmentEui),
            simulation_hot_water_eui_kwh_m2: normalizeMetricForExport(item.hotWaterEui),
            simulation_gross_floor_area_m2: normalizeMetricForExport(item.grossFloorAreaM2),
            simulation_status: item.status ?? '',
            simulation_job_id: item.jobId ?? ''
        };

        upsertSourceFeatureFromPrepared(feature);
        state.hasPendingGeojsonEdits = true;
    });

    state.map?.getSource('simulation-buildings')?.setData(state.geojson);
}

async function handleSyncGeojsonDataset() {
    const selected = getCurrentModeHistory().filter(item => item.selected);

    if (!selected.length && !state.hasPendingGeojsonEdits) {
        window.alert('Please select at least one simulation result row or save building parameter edits before syncing the active GeoJSON dataset.');
        return;
    }

    if (!syncGeojsonButton) {
        return;
    }

    syncGeojsonButton.disabled = true;
    syncGeojsonButton.textContent = 'Syncing...';

    try {
        if (selected.length) {
            applySimulationHistoryItemsToGeojson(selected);
        }

        const message = selected.length
            ? 'GeoJSON dataset synced with selected simulation results and cached building edits.'
            : 'GeoJSON dataset synced with cached building edits.';
        await persistGeojsonDataset(null, message);
        window.alert(message);
    } catch (error) {
        console.error(error);
        window.alert(error?.message || 'Unable to sync the GeoJSON dataset.');
    } finally {
        syncGeojsonButton.disabled = false;
        syncGeojsonButton.textContent = 'Sync GeoJSON dataset';
    }
}

function normalizeTemplateLibrary(rawTemplates) {
    if (Array.isArray(rawTemplates)) {
        return Object.fromEntries(rawTemplates
            .filter(item => item?.archetype && item?.simulation_parameters)
            .map(item => [String(item.archetype), {
                ...item.simulation_parameters,
                schedules: normalizeSchedules(item.simulation_parameters.schedules)
            }]));
    }

    if (rawTemplates && typeof rawTemplates === 'object') {
        return Object.fromEntries(Object.entries(rawTemplates)
            .filter(([, params]) => params && typeof params === 'object')
            .map(([archetype, params]) => [String(archetype), {
                ...params,
                schedules: normalizeSchedules(params.schedules)
            }]));
    }

    return {};
}

function loadArchetypeTemplates() {
    return normalizeTemplateLibrary(idfTemplateLibrary);
}

function saveArchetypeTemplates() {}

function getFeatureUid(feature) {
    return String(feature?.properties?.simulation_uid ?? feature?.id ?? '');
}

function findFeatureByUid(uid) {
    return state.geojson?.features?.find(feature => getFeatureUid(feature) === String(uid)) || null;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function getDatasetFeatureId(feature) {
    const properties = feature?.properties || {};
    return String(properties.simulation_uid ?? properties.id ?? properties.building_id ?? properties.osm_id ?? properties['@id'] ?? feature?.id ?? '');
}

function cleanFeatureForDataset(feature) {
    const cloned = cloneJson(feature);
    if (cloned?.properties) {
        delete cloned.properties.simulation_role;
        const stableId = cloned.properties.id ?? cloned.properties.simulation_uid ?? cloned.properties.building_id;
        if (stableId !== undefined && stableId !== null && stableId !== '') {
            cloned.id = stableId;
            cloned.properties.simulation_uid = String(stableId);
        }
    }
    return cloned;
}

function upsertSourceFeatureFromPrepared(feature) {
    const cleaned = cleanFeatureForDataset(feature);
    const featureId = getDatasetFeatureId(cleaned);

    if (!state.sourceGeojson) {
        state.sourceGeojson = emptyFeatureCollection();
    }

    if (!Array.isArray(state.sourceGeojson.features)) {
        state.sourceGeojson.features = [];
    }

    const index = state.sourceGeojson.features.findIndex(item => getDatasetFeatureId(item) === featureId);
    if (index >= 0) {
        state.sourceGeojson.features[index] = {
            ...state.sourceGeojson.features[index],
            ...cleaned,
            properties: {
                ...(state.sourceGeojson.features[index].properties || {}),
                ...(cleaned.properties || {})
            }
        };
    } else {
        state.sourceGeojson.features.push(cleaned);
    }
}

function dedupeFeaturesByDatasetId(features = []) {
    const featuresById = new Map();

    features.forEach(feature => {
        const featureId = getDatasetFeatureId(feature);
        if (!featureId) {
            return;
        }

        const cleaned = cleanFeatureForDataset(feature);
        const previous = featuresById.get(featureId);
        featuresById.set(featureId, previous
            ? {
                ...previous,
                ...cleaned,
                properties: {
                    ...(previous.properties || {}),
                    ...(cleaned.properties || {})
                }
            }
            : cleaned
        );
    });

    return Array.from(featuresById.values());
}

function buildSyncedGeojsonDataset() {
    const base = cloneJson(state.sourceGeojson || state.geojson || emptyFeatureCollection());
    const preparedById = new Map((state.geojson?.features || []).map(feature => [getDatasetFeatureId(feature), cleanFeatureForDataset(feature)]));

    base.features = (base.features || []).map(feature => {
        const prepared = preparedById.get(getDatasetFeatureId(feature));
        if (!prepared) {
            return feature;
        }

        return {
            ...feature,
            ...prepared,
            properties: {
                ...(feature.properties || {}),
                ...(prepared.properties || {})
            }
        };
    });

    const existingIds = new Set((base.features || []).map(feature => getDatasetFeatureId(feature)));
    preparedById.forEach((feature, id) => {
        if (!existingIds.has(id)) {
            base.features.push(feature);
        }
    });

    base.features = dedupeFeaturesByDatasetId(base.features);

    return base;
}

async function persistGeojsonDataset(statusElement = null, successMessage = 'GeoJSON dataset synced.') {
    const syncedGeojson = buildSyncedGeojsonDataset();
    const result = await syncGeoJSONDataset({
        geojson: syncedGeojson,
        dataPath: config.buildings_source?.data || ''
    });

    state.sourceGeojson = syncedGeojson;
    state.hasPendingGeojsonEdits = false;
    await reloadSimulationBuildingLibrary(config.simulation_service_url);

    if (statusElement) {
        statusElement.textContent = successMessage;
    }

    updateHint(`${successMessage} ${result?.feature_count ?? syncedGeojson.features?.length ?? 0} features written to ${config.buildings_source?.data}.`);
    return result;
}

function getRawArchetype(properties = {}) {
    const archetypeKey = config.ml_archetype_property || 'building_archetype';
    return String(properties[archetypeKey] ?? 'unknown');
}

function getArchetypeTemplate(archetype) {
    return state.archetypeTemplates[String(archetype ?? 'unknown')] || state.archetypeTemplates.unknown || null;
}

function getArchetypeOptions(geojson) {
    const archetypeKey = config.ml_archetype_property || 'building_archetype';
    const options = new Set();

    (geojson?.features || []).forEach(feature => {
        const value = String(feature?.properties?.[archetypeKey] ?? '').trim();
        if (value) {
            options.add(value);
        }
    });

    return [...options].sort((a, b) => formatArchetypeLabel(a).localeCompare(formatArchetypeLabel(b)));
}

function formatArchetypeLabel(value) {
    const normalized = String(value || '').replace(/_/g, ' ').trim();
    return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : '--';
}

function formatBuildingAddress(properties = {}) {
    const houseNumber = String(properties.addr_housenumber ?? properties['addr:housenumber'] ?? '').trim();
    const street = String(properties.addr_street ?? properties['addr:street'] ?? '').trim();
    const houseName = String(properties.addr_housename ?? properties['addr:housename'] ?? '').trim();
    const postcode = String(properties.addr_postcode ?? properties['addr:postcode'] ?? '').trim();
    const rawCity = String(properties.addr_city ?? properties['addr:city'] ?? '').trim();
    const configuredCity = String(config.city_name || config.country || '').trim();
    const city = rawCity && !['none', 'null', 'undefined'].includes(rawCity.toLowerCase())
        ? rawCity
        : configuredCity;
    const addressParts = [];

    if (houseName && !['none', 'null', 'undefined'].includes(houseName.toLowerCase())) {
        addressParts.push(houseName);
    }

    const streetLine = [houseNumber, street]
        .filter(part => part && !['none', 'null', 'undefined'].includes(part.toLowerCase()))
        .join(' ');

    if (streetLine) {
        addressParts.push(streetLine);
    }

    if (city && !['none', 'null', 'undefined'].includes(city.toLowerCase())) {
        addressParts.push(city);
    }

    if (postcode && !['none', 'null', 'undefined'].includes(postcode.toLowerCase())) {
        addressParts.push(postcode);
    }

    return addressParts.length ? addressParts.join(', ') : 'Address not available';
}

function getSimulationParametersForFeature(feature) {
    const properties = feature?.properties || {};
    const archetype = getRawArchetype(properties);
    const template = getArchetypeTemplate(archetype);

    if (!template) {
        throw new Error('Missing `unknown` template in user-data/simulation/templates.json.');
    }

    const params = {
        ...template,
        ...(properties.simulation_parameters || {})
    };
    params.schedules = normalizeSchedules(params.schedules);
    return params;
}

function getBuildingEditorFeature() {
    return findFeatureByUid(state.buildingEditor.featureUid);
}

function openBuildingEditor(renderedFeature) {
    const uid = getFeatureUid(renderedFeature);
    const feature = findFeatureByUid(uid);

    if (!feature || !buildingEditorOverlay) {
        return;
    }

    state.buildingEditor.featureUid = uid;
    state.buildingEditor.rotation = 0;
    modePrompt?.classList.remove('show');
    renderBuildingEditor(feature);
    buildingEditorOverlay.classList.add('show');
    buildingEditorOverlay.setAttribute('aria-hidden', 'false');
    window.requestAnimationFrame(() => {
        renderScheduleCharts();
    });
    startBuildingPreviewAnimation();
    updateHint('Editing building simulation parameters. Save to the building or its archetype template.');
}

function closeBuildingEditor() {
    buildingEditorOverlay?.classList.remove('show');
    buildingEditorOverlay?.setAttribute('aria-hidden', 'true');

    if (state.buildingEditor.animationFrame) {
        window.cancelAnimationFrame(state.buildingEditor.animationFrame);
        state.buildingEditor.animationFrame = null;
    }

    if (buildingEditorSaveStatus) {
        buildingEditorSaveStatus.textContent = '';
    }
}

function renderBuildingEditor(feature) {
    const properties = feature.properties || {};
    const uid = getFeatureUid(feature);
    const archetype = getRawArchetype(properties);
    const height = getHeightMeters(properties);
    const footprintArea = Number(properties.building_footprint ?? properties['building:footprint']) || turf.area(feature);
    const levels = properties.building_levels ?? properties['building:levels'] ?? properties.levels ?? Math.max(1, Math.round(height / 3.2));
    const params = getSimulationParametersForFeature(feature);
    const templateSource = properties.simulation_parameters ? 'Building override' : state.archetypeTemplates[archetype] ? 'Archetype template' : 'IDF default';
    const template = getArchetypeTemplate(archetype);
    state.buildingEditor.scheduleResetValues = cloneSchedules(template?.schedules || DEFAULT_SCHEDULES);
    state.buildingEditor.scheduleValues = cloneSchedules(params.schedules);

    if (buildingPreviewTitle) {
        buildingPreviewTitle.textContent = `Building ${uid || '--'}`;
    }

    if (buildingPreviewSubtitle) {
        buildingPreviewSubtitle.textContent = formatBuildingAddress(properties);
    }

    if (buildingInfoGrid) {
        if (archetype && !state.archetypeOptions.includes(archetype)) {
            state.archetypeOptions = [...state.archetypeOptions, archetype]
                .sort((a, b) => formatArchetypeLabel(a).localeCompare(formatArchetypeLabel(b)));
        }

        const basicValues = {
            building_id: uid || '--',
            building_archetype: archetype,
            height: Number(height.toFixed(2)),
            building_levels: levels || '',
            building_footprint: Number(footprintArea.toFixed(0)),
            template_source: templateSource
        };
        buildingInfoGrid.innerHTML = BASIC_INFO_FIELDS.map(field => renderBuildingField({
            ...field,
            options: field.key === 'building_archetype' ? state.archetypeOptions : field.options,
            value: basicValues[field.key],
            dataAttribute: 'data-basic-key'
        })).join('');
    }

    if (buildingParameterGrid) {
        buildingParameterGrid.innerHTML = renderParameterSections(params);
    }

    renderScheduleCharts();

    if (buildingEditorSaveStatus) {
        buildingEditorSaveStatus.textContent = '';
    }
}

function renderParameterSections(params) {
    const groups = [...new Set(PARAMETER_FIELDS.map(field => field.group || 'IDF Defaults'))];
    return groups.map(group => {
        const fields = PARAMETER_FIELDS.filter(field => (field.group || 'IDF Defaults') === group);
        return `
            <div class="building-field-section">
                <div class="building-field-section-title">${escapeHtml(group)}</div>
                <div class="building-field-section-grid">
                    ${fields.map(field => renderParameterField(field, params[field.key])).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderBuildingField(field) {
    const value = field.value ?? '';
    const attr = field.dataAttribute || 'data-parameter-key';
    const disabled = field.disabled ? ' disabled' : '';

    if (field.type === 'select') {
        const optionValues = field.options || [];
        const options = optionValues.map(optionValue => `
            <option value="${escapeHtml(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${escapeHtml(formatArchetypeLabel(optionValue))}</option>
        `).join('');

        return `
            <div class="building-field">
                <label for="field-${escapeHtml(field.key)}">${escapeHtml(field.label)}</label>
                <select id="field-${escapeHtml(field.key)}" ${attr}="${escapeHtml(field.key)}"${disabled}>${options}</select>
            </div>
        `;
    }

    return `
        <div class="building-field">
            <label for="field-${escapeHtml(field.key)}">${escapeHtml(field.label)}</label>
            <input id="field-${escapeHtml(field.key)}" ${attr}="${escapeHtml(field.key)}" type="${escapeHtml(field.type || 'text')}" value="${escapeHtml(value)}"${field.min != null ? ` min="${field.min}"` : ''}${field.max != null ? ` max="${field.max}"` : ''}${field.step != null ? ` step="${field.step}"` : ''}${disabled} />
        </div>
    `;
}

function formatFieldLabel(field) {
    if (!field.unit) {
        return field.label;
    }

    return `${field.label} (${field.unit})`;
}

function renderParameterField(field, value) {
    if (field.type === 'select') {
        const options = (field.options || []).map(([optionValue, label]) => `
            <option value="${escapeHtml(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${escapeHtml(label)}</option>
        `).join('');

        return `
            <div class="building-field">
                <label for="parameter-${escapeHtml(field.key)}">${escapeHtml(formatFieldLabel(field))}</label>
                <select id="parameter-${escapeHtml(field.key)}" data-parameter-key="${escapeHtml(field.key)}">${options}</select>
            </div>
        `;
    }

    return `
        <div class="building-field">
            <label for="parameter-${escapeHtml(field.key)}">${escapeHtml(formatFieldLabel(field))}</label>
            <input id="parameter-${escapeHtml(field.key)}" data-parameter-key="${escapeHtml(field.key)}" type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${escapeHtml(value)}" />
        </div>
    `;
}

function readBasicInfoFormValues() {
    const values = {};

    BASIC_INFO_FIELDS.forEach(field => {
        if (field.disabled) {
            return;
        }

        const input = buildingInfoGrid?.querySelector(`[data-basic-key="${field.key}"]`);
        if (!input) {
            return;
        }

        values[field.key] = field.type === 'number' ? Number(input.value) : input.value;
    });

    return values;
}

function readParameterFormValues() {
    const values = {};

    PARAMETER_FIELDS.forEach(field => {
        const input = buildingParameterGrid?.querySelector(`[data-parameter-key="${field.key}"]`);
        if (!input) {
            return;
        }

        values[field.key] = field.type === 'select' ? input.value : Number(input.value);
    });

    values.schedules = cloneSchedules(state.buildingEditor.scheduleValues);
    return values;
}

function getCurrentBuildingEditorPayload() {
    const feature = getBuildingEditorFeature();
    if (!feature) {
        return null;
    }

    const properties = feature.properties || {};
    const basicValues = readBasicInfoFormValues();
    const params = readParameterFormValues();
    const archetypeField = config.ml_archetype_property || 'building_archetype';
    const archetype = String(basicValues.building_archetype ?? properties[archetypeField] ?? 'unknown');
    const height = Number.isFinite(basicValues.height) ? basicValues.height : getHeightMeters(properties);
    const levels = Number.isFinite(basicValues.building_levels)
        ? basicValues.building_levels
        : properties.building_levels ?? properties['building:levels'] ?? null;
    const footprint = Number.isFinite(basicValues.building_footprint)
        ? basicValues.building_footprint
        : Number(properties.building_footprint ?? properties['building:footprint']) || Number(turf.area(feature).toFixed(2));
    const uid = getFeatureUid(feature);

    return {
        feature,
        buildingId: uid,
        archetype,
        buildingInfo: {
            building_id: uid,
            address: formatBuildingAddress(properties),
            postcode: String(properties.addr_postcode ?? properties['addr:postcode'] ?? ''),
            archetype,
            height_m: height,
            building_levels: levels,
            building_footprint_m2: footprint,
            properties: {
                ...properties,
                [archetypeField]: archetype,
                height,
                building_levels: levels,
                building_footprint: footprint
            }
        },
        parameters: params
    };
}

function downloadBuildingEditorJson() {
    const payload = getCurrentBuildingEditorPayload();
    if (!payload) {
        return;
    }

    triggerDownload(
        JSON.stringify({
            building_id: payload.buildingId,
            building_info: payload.buildingInfo,
            simulation_parameters: payload.parameters
        }, null, 2),
        `building_${sanitizeFilename(payload.buildingId || 'selected')}_parameters.json`,
        'application/json'
    );
}

async function syncBuildingTemplateIdf() {
    const payload = getCurrentBuildingEditorPayload();
    if (!payload) {
        return;
    }

    if (!buildingEditorDownloadTemplate) {
        return;
    }

    buildingEditorDownloadTemplate.disabled = true;
    buildingEditorDownloadTemplate.textContent = 'Syncing...';
    if (buildingEditorSaveStatus) {
        buildingEditorSaveStatus.textContent = 'Syncing template IDF...';
    }

    try {
        state.archetypeTemplates[payload.archetype] = payload.parameters;
        const result = await syncIdfTemplate({
            serviceUrl: config.simulation_service_url || 'http://localhost:8010',
            payload: {
                archetype: payload.archetype,
                simulation_parameters: payload.parameters
            }
        });
        if (buildingEditorSaveStatus) {
            const count = result?.idf_generation?.generated_count;
            buildingEditorSaveStatus.textContent = count
                ? `Template synced. ${count} IDFs regenerated.`
                : 'Template synced.';
        }
    } catch (error) {
        console.error(error);
        if (buildingEditorSaveStatus) {
            buildingEditorSaveStatus.textContent = error?.message || 'Template sync failed.';
        }
        window.alert(error?.message || 'Unable to sync template IDF.');
    } finally {
        buildingEditorDownloadTemplate.disabled = false;
        buildingEditorDownloadTemplate.textContent = 'Sync template IDF';
    }
}

function downloadBuildingTemplateJson() {
    const payload = getCurrentBuildingEditorPayload();
    if (!payload) {
        return;
    }

    triggerDownload(
        JSON.stringify({
            archetype: payload.archetype,
            simulation_parameters: payload.parameters
        }, null, 2),
        `template_${sanitizeFilename(payload.archetype || 'unknown')}_parameters.json`,
        'application/json'
    );
}

function sanitizeFilename(value) {
    return String(value || 'export')
        .replace(/[^a-z0-9_-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'export';
}

function cloneSchedules(schedules) {
    return Object.fromEntries(
        SCHEDULE_CHARTS.map(chart => [chart.key, normalizeScheduleArray(schedules?.[chart.key], chart.key)])
    );
}

function normalizeSchedules(schedules) {
    return cloneSchedules(schedules || DEFAULT_SCHEDULES);
}

function normalizeScheduleArray(values, key = 'occupancy_weekday') {
    const fallback = DEFAULT_SCHEDULES[key] || DEFAULT_SCHEDULES.occupancy_weekday;
    const source = Array.isArray(values) && values.length ? values : fallback;
    return Array.from({ length: 24 }, (_, index) => {
        const raw = Number(source[index] ?? source[source.length - 1] ?? 0);
        return clamp01(Number.isFinite(raw) ? raw : 0);
    });
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function getBuildingEditorArchetypeValue() {
    const input = buildingInfoGrid?.querySelector('[data-basic-key="building_archetype"]');
    if (input?.value) {
        return String(input.value);
    }

    const feature = getBuildingEditorFeature();
    return feature ? getRawArchetype(feature.properties || {}) : 'unknown';
}

function getBuildingEditorScheduleResetValues() {
    const template = getArchetypeTemplate(getBuildingEditorArchetypeValue());
    if (template?.schedules) {
        return cloneSchedules(template.schedules);
    }

    return cloneSchedules(state.buildingEditor.scheduleResetValues || DEFAULT_SCHEDULES);
}

function renderScheduleCharts() {
    if (!scheduleChartGrid) {
        return;
    }

    if (scheduleHeightInput) {
        scheduleHeightInput.value = String(state.buildingEditor.scheduleHeight);
    }

    if (scheduleHeightValue) {
        scheduleHeightValue.textContent = `${state.buildingEditor.scheduleHeight}px`;
    }

    scheduleChartGrid.innerHTML = SCHEDULE_CHARTS.map(chart => `
        <div class="schedule-chart-row" data-schedule-key="${escapeHtml(chart.key)}">
            <div class="schedule-chart-header">
                <span>${escapeHtml(chart.title)}</span>
                <button type="button" data-schedule-reset="${escapeHtml(chart.key)}">Reset</button>
            </div>
            <canvas class="schedule-chart-canvas" data-schedule-canvas="${escapeHtml(chart.key)}" style="height:${state.buildingEditor.scheduleHeight}px"></canvas>
        </div>
    `).join('');

    scheduleChartGrid.querySelectorAll('[data-schedule-reset]').forEach(button => {
        button.addEventListener('click', () => {
            const key = button.getAttribute('data-schedule-reset');
            const resetValues = getBuildingEditorScheduleResetValues();
            if (key && resetValues[key]) {
                state.buildingEditor.scheduleValues[key] = [...resetValues[key]];
                renderScheduleCharts();
            }
        });
    });

    scheduleChartGrid.querySelectorAll('[data-schedule-canvas]').forEach(canvas => {
        const key = canvas.getAttribute('data-schedule-canvas');
        canvas.addEventListener('pointerdown', event => {
            const hour = getScheduleHourFromEvent(canvas, event);
            state.buildingEditor.activeScheduleDrag = { key, hour };
            updateSchedulePointFromEvent(canvas, key, hour, event);
            canvas.setPointerCapture?.(event.pointerId);
        });
        drawScheduleCanvas(canvas, key);
    });
}

function getSchedulePlotRect(canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
        left: 36,
        top: 14,
        right: rect.width - 14,
        bottom: rect.height - 24,
        width: Math.max(1, rect.width - 50),
        height: Math.max(1, rect.height - 38)
    };
}

function getScheduleHourFromEvent(canvas, event) {
    const bounds = canvas.getBoundingClientRect();
    const plot = getSchedulePlotRect(canvas);
    const localX = Math.max(plot.left, Math.min(plot.right, event.clientX - bounds.left));
    return Math.max(0, Math.min(23, Math.round(((localX - plot.left) / plot.width) * 23)));
}

function updateSchedulePointFromEvent(canvas, key, hour, event) {
    if (!key || !state.buildingEditor.scheduleValues[key]) {
        return;
    }

    const bounds = canvas.getBoundingClientRect();
    const plot = getSchedulePlotRect(canvas);
    const localY = Math.max(plot.top, Math.min(plot.bottom, event.clientY - bounds.top));
    const value = clamp01(1 - ((localY - plot.top) / plot.height));
    state.buildingEditor.scheduleValues[key][hour] = Number(value.toFixed(2));
    drawScheduleCanvas(canvas, key, hour);
}

function handleSchedulePointerMove(event) {
    const drag = state.buildingEditor.activeScheduleDrag;
    if (!drag) {
        return;
    }

    const canvas = scheduleChartGrid?.querySelector(`[data-schedule-canvas="${drag.key}"]`);
    if (!canvas) {
        return;
    }

    const hour = getScheduleHourFromEvent(canvas, event);
    drag.hour = hour;
    updateSchedulePointFromEvent(canvas, drag.key, hour, event);
}

function drawScheduleCanvas(canvas, key, activeHour = null) {
    const values = state.buildingEditor.scheduleValues[key] || DEFAULT_SCHEDULES[key] || DEFAULT_SCHEDULES.occupancy_weekday;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width || canvas.parentElement?.clientWidth || 320));
    const height = Math.max(1, Math.floor(state.buildingEditor.scheduleHeight));

    if (canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio)) {
        canvas.width = Math.floor(width * pixelRatio);
        canvas.height = Math.floor(height * pixelRatio);
    }

    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const plot = {
        left: 36,
        top: 14,
        right: width - 14,
        bottom: height - 24,
        width: Math.max(1, width - 50),
        height: Math.max(1, height - 38)
    };

    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = 1;
    [0, 0.25, 0.5, 0.75, 1].forEach(value => {
        const y = plot.bottom - value * plot.height;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
    });

    ctx.fillStyle = '#777777';
    ctx.font = '10px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 0.5, 1].forEach(value => {
        ctx.fillText(value.toFixed(1), plot.left - 7, plot.bottom - value * plot.height);
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [0, 6, 12, 18, 23].forEach(hour => {
        const x = plot.left + (hour / 23) * plot.width;
        ctx.fillText(String(hour), x, plot.bottom + 8);
    });

    const points = values.map((value, hour) => [
        plot.left + (hour / 23) * plot.width,
        plot.bottom - clamp01(value) * plot.height
    ]);

    ctx.beginPath();
    points.forEach(([x, y], index) => {
        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 2;
    ctx.stroke();

    points.forEach(([x, y], hour) => {
        ctx.beginPath();
        ctx.arc(x, y, activeHour === hour ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fillStyle = activeHour === hour ? '#111111' : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 1.4;
        ctx.stroke();
    });

    if (activeHour !== null && points[activeHour]) {
        const [x, y] = points[activeHour];
        const label = values[activeHour].toFixed(2);
        ctx.font = '16px "Segoe UI", Tahoma, Geneva, Verdana, sans-serif';
        const labelWidth = ctx.measureText(label).width + 16;
        const labelX = Math.max(plot.left, Math.min(plot.right - labelWidth, x - labelWidth / 2));
        const labelY = Math.max(4, y - 34);
        drawRoundedRect(ctx, labelX, labelY, labelWidth, 24, 8);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#d8d8d8';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#111111';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, labelX + labelWidth / 2, labelY + 12);
    }
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + width - safeRadius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    ctx.lineTo(x + width, y + height - safeRadius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    ctx.lineTo(x + safeRadius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    ctx.lineTo(x, y + safeRadius);
    ctx.quadraticCurveTo(x, y, x + safeRadius, y);
    ctx.closePath();
}

async function saveBuildingEditorParameters(scope = 'building') {
    const feature = getBuildingEditorFeature();
    if (!feature) {
        return;
    }

    const params = readParameterFormValues();
    const basicValues = readBasicInfoFormValues();
    const archetypeField = config.ml_archetype_property || 'building_archetype';
    const nextProperties = {
        ...(feature.properties || {}),
        [archetypeField]: basicValues.building_archetype ?? feature.properties?.[archetypeField],
        height: Number.isFinite(basicValues.height) ? basicValues.height : feature.properties?.height,
        building_levels: Number.isFinite(basicValues.building_levels) ? basicValues.building_levels : feature.properties?.building_levels,
        building_footprint: Number.isFinite(basicValues.building_footprint) ? basicValues.building_footprint : feature.properties?.building_footprint
    };
    feature.properties = nextProperties;
    state.archetypeOptions = getArchetypeOptions(state.geojson);
    const archetype = getRawArchetype(feature.properties || {});

    if (scope === 'archetype') {
        state.archetypeTemplates[archetype] = params;
        saveArchetypeTemplates();
        state.buildingMeta = state.geojson.features.map(item => buildFeatureMeta(item));
        state.map?.getSource('simulation-buildings')?.setData(state.geojson);
        upsertSourceFeatureFromPrepared(feature);
        state.hasPendingGeojsonEdits = true;
        renderBuildingEditor(feature);
    } else {
        feature.properties = {
            ...(feature.properties || {}),
            simulation_parameters: params
        };

        state.buildingMeta = state.geojson.features.map(item => buildFeatureMeta(item));
        state.map?.getSource('simulation-buildings')?.setData(state.geojson);
        upsertSourceFeatureFromPrepared(feature);
        state.hasPendingGeojsonEdits = true;
        renderBuildingEditor(feature);
    }

    closeBuildingEditor();
}

function startBuildingPreviewAnimation() {
    if (!buildingPreviewCanvas) {
        return;
    }

    const drawFrame = () => {
        const feature = getBuildingEditorFeature();
        if (!feature || !buildingEditorOverlay?.classList.contains('show')) {
            return;
        }

        state.buildingEditor.rotation += 0.008;
        drawBuildingPreview(feature, state.buildingEditor.rotation);
        state.buildingEditor.animationFrame = window.requestAnimationFrame(drawFrame);
    };

    if (state.buildingEditor.animationFrame) {
        window.cancelAnimationFrame(state.buildingEditor.animationFrame);
    }

    drawFrame();
}

function getLargestPolygonCoordinates(feature) {
    const geometry = feature?.geometry;
    if (geometry?.type === 'Polygon') {
        return stripClosingCoordinate(geometry.coordinates?.[0] || []);
    }

    if (geometry?.type === 'MultiPolygon') {
        return (geometry.coordinates || [])
            .map(polygon => stripClosingCoordinate(polygon?.[0] || []))
            .sort((a, b) => b.length - a.length)[0] || [];
    }

    return [];
}

function stripClosingCoordinate(ring) {
    if (ring.length > 1) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first?.[0] === last?.[0] && first?.[1] === last?.[1]) {
            return ring.slice(0, -1);
        }
    }

    return ring;
}

function drawBuildingPreview(feature, rotation) {
    const canvas = buildingPreviewCanvas;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) {
        return;
    }

    const rect = parent.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    if (canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio)) {
        canvas.width = Math.floor(width * pixelRatio);
        canvas.height = Math.floor(height * pixelRatio);
    }

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, width, height);

    const ring = getLargestPolygonCoordinates(feature);
    if (ring.length < 3) {
        return;
    }

    const bbox = turf.bbox(feature);
    const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    const projected = ring.map(([lng, lat]) => {
        const x = (Number(lng) - center[0]) * Math.cos(center[1] * Math.PI / 180) * 111320;
        const y = (Number(lat) - center[1]) * 110540;
        return [x, y];
    });

    const xs = projected.map(point => point[0]);
    const ys = projected.map(point => point[1]);
    const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs));
    const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const levels = Number(feature?.properties?.building_levels ?? feature?.properties?.['building:levels'] ?? feature?.properties?.levels);
    const fallbackHeight = (Number.isFinite(levels) && levels > 0 ? levels : 4) * 3.2;
    const buildingHeight = Math.max(getHeightMeters(feature.properties || {}), fallbackHeight, 6);
    const baseSpan = Math.max(spanX, spanY, buildingHeight * 0.65);
    const scale = Math.min((width - 82) / (baseSpan * 1.35), (height - 82) / (baseSpan * 0.95 + buildingHeight * 0.95));
    const cx = width / 2;
    const cy = height / 2 + buildingHeight * scale * 0.18;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const projectPoint = ([x, y], z = 0) => {
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        return [
            cx + (rx - ry) * 0.58 * scale,
            cy + (rx + ry) * 0.32 * scale - z * 0.9 * scale
        ];
    };

    const base = projected.map(point => projectPoint(point, 0));
    const top = projected.map(point => projectPoint(point, buildingHeight));
    const allProjectedPoints = [...base, ...top];
    const minPx = Math.min(...allProjectedPoints.map(point => point[0]));
    const maxPx = Math.max(...allProjectedPoints.map(point => point[0]));
    const minPy = Math.min(...allProjectedPoints.map(point => point[1]));
    const maxPy = Math.max(...allProjectedPoints.map(point => point[1]));
    const offsetX = width / 2 - (minPx + maxPx) / 2;
    const offsetY = height / 2 - (minPy + maxPy) / 2;
    const recenterPoint = ([px, py]) => [px + offsetX, py + offsetY];
    const centeredBase = base.map(recenterPoint);
    const centeredTop = top.map(recenterPoint);
    const wallFaces = projected.map((point, index) => {
        const nextIndex = (index + 1) % projected.length;
        const nextPoint = projected[nextIndex];
        const depth = (point[0] + nextPoint[0]) * sin + (point[1] + nextPoint[1]) * cos;
        return {
            depth,
            points: [centeredBase[index], centeredBase[nextIndex], centeredTop[nextIndex], centeredTop[index]]
        };
    }).sort((a, b) => a.depth - b.depth);

    ctx.save();
    wallFaces.forEach((face, index) => {
        ctx.beginPath();
        face.points.forEach(([px, py], pointIndex) => {
            if (pointIndex === 0) {
                ctx.moveTo(px, py);
            } else {
                ctx.lineTo(px, py);
            }
        });
        ctx.closePath();
        ctx.fillStyle = index % 2 === 0 ? '#5fb8d6' : '#7fd0eb';
        ctx.globalAlpha = 0.92;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    });

    ctx.beginPath();
    centeredTop.forEach(([px, py], index) => {
        if (index === 0) {
            ctx.moveTo(px, py);
        } else {
            ctx.lineTo(px, py);
        }
    });
    ctx.closePath();
    ctx.fillStyle = '#b9e6ff';
    ctx.shadowColor = 'rgba(185, 230, 255, 0.35)';
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
}

function drawPreviewGrid(ctx, width, height) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;

    for (let x = -width; x < width * 2; x += 28) {
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x + width, 0);
        ctx.stroke();
    }

    for (let x = -width; x < width * 2; x += 28) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + width, height);
        ctx.stroke();
    }

    ctx.restore();
}

function normalizeBuildingForPayload(feature) {
    const properties = feature?.properties || {};
    const centroid = turf.centroid(feature).geometry.coordinates;
    const archetypeField = config.ml_archetype_property || 'building_archetype';
    const simulationParameters = getSimulationParametersForFeature(feature);

    return {
        building_id: String(properties.simulation_uid ?? feature?.id ?? ''),
        role: properties.simulation_role || 'background',
        archetype: String(properties[archetypeField] ?? 'unknown'),
        height_m: Number(getHeightMeters(properties).toFixed(2)),
        footprint_area_m2: Number(turf.area(feature).toFixed(2)),
        simulation_parameters: simulationParameters,
        centroid: {
            lng: Number(centroid[0].toFixed(6)),
            lat: Number(centroid[1].toFixed(6))
        }
    };
}

function buildSimulationPayload() {
    const features = state.geojson?.features || [];
    const targetFeatures = features.filter(feature => feature?.properties?.simulation_role === 'target');
    const invalidFeatures = features.filter(feature => feature?.properties?.simulation_role === 'invalid');
    const contextFeatures = features.filter(feature => feature?.properties?.simulation_role === 'context');
    const payloadMode = targetFeatures.length === 1 && state.selectionGeometryMode !== 'area'
        ? 'single_building'
        : 'circular_cluster';
    const targetRadiusMeters = state.selectionGeometryMode === 'area' ? state.radiusMeters : 0;
    const contextRadiusMeters = state.selectionGeometryMode === 'area'
        ? targetRadiusMeters + state.contextRadiusMeters
        : state.contextRadiusMeters;
    const primaryTargetSettings = targetFeatures.length
        ? getSimulationParametersForFeature(targetFeatures[0])
        : state.archetypeTemplates.unknown;

    return {
        selection: {
            mode: payloadMode,
            center: {
                lng: Number((state.center?.[0] || 0).toFixed(6)),
                lat: Number((state.center?.[1] || 0).toFixed(6))
            },
            target_radius_m: targetRadiusMeters,
            context_radius_m: contextRadiusMeters
        },
        targets: {
            valid_building_ids: targetFeatures.map(feature => String(feature?.properties?.simulation_uid ?? feature?.id ?? '')),
            invalid_building_ids: invalidFeatures.map(feature => String(feature?.properties?.simulation_uid ?? feature?.id ?? ''))
        },
        context: {
            shading_building_ids: contextFeatures.map(feature => String(feature?.properties?.simulation_uid ?? feature?.id ?? '')),
            excluded_building_ids: []
        },
        simulation_settings: {
            floor_height_m: 3.0,
            geometry_mode: 'minimum_rotated_rectangle',
            zoning_mode: 'core_perimeter',
            template_strategy: 'archetype_idf_replace_geometry',
            hvac_system: primaryTargetSettings.hvac_system,
            default_idf_parameters: primaryTargetSettings
        },
        building_details: [...targetFeatures, ...invalidFeatures, ...contextFeatures].map(normalizeBuildingForPayload)
    };
}

const SIMULATION_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const SIMULATION_JOB_POLL_INTERVAL_MS = 500;

async function pollSimulationJob(jobId, serviceUrl) {
    const deadline = Date.now() + SIMULATION_JOB_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const job = await getSimulationJob({ jobId, serviceUrl });

        setSimulationProgressState({
            progress: job.progress ?? 0,
            stage: job.stage,
            message: job.message || 'Running simulation job'
        });
        updateHint(`${job.message || 'Running simulation job'} (${job.progress ?? 0}%)`);

        if (job.status === 'completed' || job.status === 'failed') {
            return job;
        }

        await new Promise(resolve => window.setTimeout(resolve, SIMULATION_JOB_POLL_INTERVAL_MS));
    }

    throw new Error('Simulation job timed out. Please try again.');
}

function renderSimulationResult(job) {
    if (!simulationResult) {
        return;
    }

    const result = job?.result || {};
    const summary = result.summary || {};
    const metrics = result.metrics || {};

    simulationResult.innerHTML = [
        `<strong>${summary.eui_source === 'energyplus_annual_outputs' ? 'Annual EnergyPlus summary ready' : 'Simulation preview summary ready'}</strong>`,
        `Total EUI ${formatDisplayNumber(metrics.total_eui_kwh_m2 ?? metrics.annual_site_eui_kwh_m2, 2)} kWh/m²·yr · Annual energy ${formatDisplayNumber(metrics.annual_energy_kwh ?? metrics.total_energy_kwh, 0, true)} kWh`,
        'The detailed summary panel has opened, including overview cards, building-level results, and download options.'
    ].join('<br />');

    simulationResult.classList.add('show');
}

async function handleConfirmSimulation() {
    if (!state.roleCounts.target) {
        const message = 'No target buildings selected yet. Please choose a valid target before confirming the simulation.';
        updateHint(message);
        window.alert(message);
        return;
    }

    const payload = buildSimulationPayload();
    const serviceUrl = config.simulation_service_url || 'http://localhost:8010';

    setConfirmButtonState(true);
    updateHint('Submitting the standardized simulation payload to the backend...');
    hideSimulationSummaryOverlay();
    setSimulationProgressState({
        progress: 6,
        stage: 'queued',
        message: 'Preparing the simulation request.'
    });
    showSimulationProgressOverlay();

    if (simulationResult) {
        simulationResult.classList.remove('show');
        simulationResult.textContent = '';
    }

    try {
        const queuedJob = await createSimulationJob({ payload, serviceUrl });
        state.activeSimulationJobId = queuedJob.job_id || null;
        state.lastSimulationJob = null;
        setConfirmButtonState(true);
        setSimulationProgressState({
            progress: queuedJob.progress ?? 8,
            stage: queuedJob.stage,
            message: queuedJob.message || 'Simulation job queued'
        });

        const completedJob = await pollSimulationJob(queuedJob.job_id, serviceUrl);
        if (completedJob.status !== 'completed') {
            throw new Error(completedJob.error || completedJob.message || 'Simulation job failed.');
        }

        state.lastSimulationJob = completedJob;
        hideSimulationProgressOverlay();
        renderSimulationResult(completedJob);
        populateSimulationSummary(completedJob);
        showSimulationSummaryOverlay();
        updateHint('Simulation completed. Review the detailed summary panel or download the outputs.');
        setConfirmButtonState(false);
    } catch (error) {
        console.error(error);
        hideSimulationProgressOverlay();
        const message = error?.message || 'Unable to complete the simulation job.';
        updateHint(message);
        window.alert(message);
        setConfirmButtonState(false);
    }
}

function updateModeText() {
    if (!modeDescription) {
        return;
    }

    modeDescription.textContent = `Click buildings to add or remove targets, up to ${MAX_TARGET_BUILDINGS}. Use the circle button for a one-time area selection.`;
    if (controlStrip) controlStrip.style.display = 'flex';
}

function updateRadiusReadouts() {
    if (radiusValue) {
        radiusValue.textContent = `${Math.round(getActiveRadiusMeters())} m`;
    }

    if (contextRadiusValue) {
        contextRadiusValue.textContent = `${Math.round(getActiveContextRadiusMeters())} m`;
    }
}

function updateHint(message) {
    if (selectionHint) {
        selectionHint.textContent = message;
    }
}

function isInvalidBuilding(properties) {
    const height = getHeightMeters(properties);
    const archetype = `${properties?.building_archetype ?? ''}`.trim().toLowerCase();
    const missingArchetype = !archetype || ['unknown', 'none', 'null', 'undefined', 'n/a'].includes(archetype);

    return height < 3 || missingArchetype;
}

function getHeightMeters(properties = {}) {
    const configuredHeight = Number(properties[config.height_field || 'height']);
    if (Number.isFinite(configuredHeight) && configuredHeight > 0) {
        return configuredHeight;
    }

    const levels = Number(properties.building_levels ?? properties['building:levels'] ?? properties.levels);
    if (Number.isFinite(levels) && levels > 0) {
        return levels * 3.2;
    }

    return 0;
}

function fitMapToBuildings() {
    if (!state.geojson?.features?.length) {
        return;
    }

    const [minX, minY, maxX, maxY] = turf.bbox(state.geojson);
    const bounds = [[minX, minY], [maxX, maxY]];
    const widthKm = turf.distance([minX, minY], [maxX, minY], { units: 'kilometers' });
    const heightKm = turf.distance([minX, minY], [minX, maxY], { units: 'kilometers' });

    if (Math.max(widthKm, heightKm) <= 1.2) {
        state.map.fitBounds(bounds, {
            padding: { top: 170, right: 40, bottom: 40, left: 40 },
            duration: 0,
            maxZoom: 18.5
        });
        return;
    }

    const center = [(minX + maxX) / 2, (minY + maxY) / 2];
    state.map.jumpTo({
        center,
        zoom: 15
    });
}

function emptyFeatureCollection() {
    return {
        type: 'FeatureCollection',
        features: []
    };
}
