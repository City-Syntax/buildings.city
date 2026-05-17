import * as turf from '@turf/turf';
import config from '../user-data/config.json';
import { createPredictionJob, fetchGeoJSON, getPredictionJob } from './ml-api.js';
import { syncGeoJSONDataset } from './data-sync-api.js';
import { formatArchetypeName } from './data-processor.js';

const UNKNOWN_VALUES = new Set(['', 'unknown', 'none', 'null', 'undefined', 'n/a', 'na']);
const POLYGON_TYPES = new Set(['Polygon', 'MultiPolygon']);
const JOB_POLL_INTERVAL_MS = 700;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.2;
const DEFAULT_SMOTE_MULTIPLIER = 10;
const DEFAULT_FEATURE_NAMES = [
    'perimeter',
    'aspect_ratio',
    'compactness_ratio',
    'convexity_ratio',
    'building_footprint',
    'rectangularity',
    'vertex_count',
    'hole_count',
    'perimeter_area_ratio',
    'height'
];
const FEATURE_OPTIONS = [
    ['perimeter', 'Perimeter'],
    ['aspect_ratio', 'Aspect ratio'],
    ['compactness_ratio', 'Compactness ratio'],
    ['convexity_ratio', 'Convexity ratio'],
    ['building_footprint', 'Building footprint'],
    ['rectangularity', 'Rectangularity'],
    ['vertex_count', 'Vertex count'],
    ['hole_count', 'Hole count'],
    ['perimeter_area_ratio', 'Perimeter area ratio'],
    ['height', 'Height'],
    ['built_year', 'Built year'],
    ['gross_floor_area', 'Gross floor area'],
    ['building_levels', 'Building levels'],
    ['floor_height', 'Floor height']
];

const state = {
    sourceGeojson: null,
    activeGeojson: null,
    pendingPrediction: null,
    hasPredictionApplied: false,
    datasetName: 'buildings.geojson',
    diagnostics: null,
    modelSettings: {
        confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
        smoteMaxMultiplier: DEFAULT_SMOTE_MULTIPLIER,
        featureNames: new Set(DEFAULT_FEATURE_NAMES)
    },
    backendCapabilities: null
};

const elements = {
    datasetMetrics: document.getElementById('datasetMetrics'),
    archetypeCounts: document.getElementById('archetypeCounts'),
    inputCompleteness: document.getElementById('inputCompleteness'),
    recommendation: document.getElementById('recommendation'),
    smoteMultiplierInput: document.getElementById('smoteMultiplierInput'),
    smoteMultiplierValue: document.getElementById('smoteMultiplierValue'),
    resetSmoteMultiplier: document.getElementById('resetSmoteMultiplier'),
    confidenceThresholdInput: document.getElementById('confidenceThresholdInput'),
    confidenceThresholdValue: document.getElementById('confidenceThresholdValue'),
    resetConfidenceThreshold: document.getElementById('resetConfidenceThreshold'),
    featureSelectList: document.getElementById('featureSelectList'),
    runPrediction: document.getElementById('runPrediction'),
    syncGeojsonDataset: document.getElementById('syncGeojsonDataset'),
    downloadPrediction: document.getElementById('downloadPrediction'),
    keepCurrentData: document.getElementById('keepCurrentData'),
    summaryMessage: document.getElementById('summaryMessage'),
    summaryAccuracy: document.getElementById('summaryAccuracy'),
    summaryKnown: document.getElementById('summaryKnown'),
    summaryUnknown: document.getElementById('summaryUnknown'),
    summarySplit: document.getElementById('summarySplit'),
    summaryFeatures: document.getElementById('summaryFeatures'),
    summaryClasses: document.getElementById('summaryClasses'),
    progressOverlay: document.getElementById('predictionProgressOverlay'),
    progressBar: document.getElementById('progressBarInner'),
    progressPercent: document.getElementById('progressPercent'),
    progressStage: document.getElementById('progressStage'),
    progressMessage: document.getElementById('progressMessage')
};

void init();

async function init() {
    setSummaryActionsEnabled(false);
    bindUI();
    renderTrainingControls();

    try {
        const geojsonPath = getConfiguredGeoJSONPath();
        state.datasetName = geojsonPath.split('/').pop() || 'buildings.geojson';
        state.sourceGeojson = await fetchGeoJSON(geojsonPath);
        state.activeGeojson = cloneGeojson(state.sourceGeojson);
        state.diagnostics = analyzeGeoJSON(state.activeGeojson);
        renderDiagnostics(state.diagnostics);
    } catch (error) {
        renderLoadError(error);
    }
}

function bindUI() {
    elements.runPrediction?.addEventListener('click', () => {
        void handleRunPrediction();
    });

    elements.keepCurrentData?.addEventListener('click', () => {
        state.pendingPrediction = null;
        state.hasPredictionApplied = false;
        setSummaryActionsEnabled(false);
        setSummaryEmpty('Prediction result cleared. The active GeoJSON remains unchanged.');
    });

    elements.downloadPrediction?.addEventListener('click', () => {
        const geojson = state.pendingPrediction?.geojson || (state.hasPredictionApplied ? state.activeGeojson : null);
        if (geojson) {
            downloadGeoJSON(geojson, buildPredictionFilename());
        }
    });

    elements.syncGeojsonDataset?.addEventListener('click', () => {
        void handleSyncGeojsonDataset();
    });

    elements.smoteMultiplierInput?.addEventListener('input', () => {
        state.modelSettings.smoteMaxMultiplier = Number(elements.smoteMultiplierInput.value) || DEFAULT_SMOTE_MULTIPLIER;
        updateTrainingReadouts();
    });

    elements.resetSmoteMultiplier?.addEventListener('click', () => {
        state.modelSettings.smoteMaxMultiplier = DEFAULT_SMOTE_MULTIPLIER;
        if (elements.smoteMultiplierInput) elements.smoteMultiplierInput.value = String(DEFAULT_SMOTE_MULTIPLIER);
        updateTrainingReadouts();
    });

    elements.confidenceThresholdInput?.addEventListener('input', () => {
        state.modelSettings.confidenceThreshold = (Number(elements.confidenceThresholdInput.value) || 0) / 100;
        updateTrainingReadouts();
    });

    elements.resetConfidenceThreshold?.addEventListener('click', () => {
        state.modelSettings.confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
        if (elements.confidenceThresholdInput) elements.confidenceThresholdInput.value = String(DEFAULT_CONFIDENCE_THRESHOLD * 100);
        updateTrainingReadouts();
    });

    window.addEventListener('prediction-job-progress', event => {
        setProgressState(event.detail || {});
    });
}

function getConfiguredGeoJSONPath() {
    const geojsonPath = config.buildings_source?.data;

    if (!geojsonPath) {
        throw new Error('Missing config.buildings_source.data. Set it to the GeoJSON file used by the app.');
    }

    return geojsonPath;
}

function analyzeGeoJSON(geojson) {
    const archetypeKey = config.ml_archetype_property || 'building_archetype';
    const heightKey = config.height_field || 'height';
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    const byArchetype = new Map();
    const completeness = {
        height: 0,
        levels: 0,
        footprintProperty: 0,
        geometryArea: 0,
        usableFeature: 0
    };
    const missing = {
        archetype: 0,
        height: 0,
        footprint: 0,
        invalidGeometry: 0,
        highlyIncomplete: 0
    };
    let totalFootprintArea = 0;

    features.forEach(feature => {
        const properties = feature?.properties || {};
        const rawArchetype = String(properties[archetypeKey] ?? '').trim();
        const normalizedArchetype = rawArchetype.toLowerCase();
        const isUnknown = UNKNOWN_VALUES.has(normalizedArchetype);
        const label = isUnknown ? 'Unknown' : formatArchetypeName(rawArchetype);
        const current = byArchetype.get(label) || 0;
        byArchetype.set(label, current + 1);

        const hasHeight = hasPositiveNumber(properties[heightKey]);
        const hasLevels = hasPositiveNumber(properties.building_levels ?? properties['building:levels'] ?? properties.levels);
        const hasFootprintProperty = hasPositiveNumber(properties.building_footprint ?? properties.footprint_area ?? properties.area);
        const hasValidGeometry = POLYGON_TYPES.has(feature?.geometry?.type);
        let geometryArea = 0;

        if (hasValidGeometry) {
            try {
                geometryArea = turf.area(feature);
            } catch {
                geometryArea = 0;
            }
        }

        const hasGeometryArea = geometryArea > 0;
        const hasFootprint = hasFootprintProperty || hasGeometryArea;

        if (hasHeight) completeness.height += 1;
        if (hasLevels) completeness.levels += 1;
        if (hasFootprintProperty) completeness.footprintProperty += 1;
        if (hasGeometryArea) {
            completeness.geometryArea += 1;
            totalFootprintArea += geometryArea;
        }

        if (!hasValidGeometry || !hasGeometryArea) missing.invalidGeometry += 1;
        if (isUnknown) missing.archetype += 1;
        if (!hasHeight) missing.height += 1;
        if (!hasFootprint) missing.footprint += 1;

        const missingInputCount = Number(isUnknown) + Number(!hasHeight) + Number(!hasFootprint);
        if (missingInputCount >= 2) {
            missing.highlyIncomplete += 1;
        }

        if (!isUnknown && hasHeight && hasFootprint && hasGeometryArea) {
            completeness.usableFeature += 1;
        }
    });

    const known = Math.max(0, features.length - missing.archetype);
    const unknownRatio = features.length ? missing.archetype / features.length : 0;
    const highIncompleteRatio = features.length ? missing.highlyIncomplete / features.length : 0;
    const heightMissingRatio = features.length ? missing.height / features.length : 0;
    const shouldPredict = features.length > 0 && known >= 20 && missing.archetype > 0 && highIncompleteRatio < 0.45;
    const needsCompletion = features.length === 0 || known < 20 || highIncompleteRatio >= 0.45 || heightMissingRatio >= 0.55;

    return {
        total: features.length,
        known,
        unknown: missing.archetype,
        unknownRatio,
        highIncompleteRatio,
        totalFootprintArea,
        byArchetype: Array.from(byArchetype.entries()).sort((a, b) => b[1] - a[1]),
        completeness,
        missing,
        shouldPredict,
        needsCompletion
    };
}

function renderDiagnostics(diagnostics) {
    renderMetrics(elements.datasetMetrics, [
        ['Total buildings', formatInteger(diagnostics.total)],
        ['Known archetypes', formatInteger(diagnostics.known)],
        ['Unknown ratio', formatPercent(diagnostics.unknownRatio)],
        ['High incomplete', formatPercent(diagnostics.highIncompleteRatio)]
    ]);

    renderArchetypeCounts(diagnostics);
    renderDetailRows(elements.inputCompleteness, [
        ['Height available', `${formatInteger(diagnostics.completeness.height)} / ${formatInteger(diagnostics.total)}`],
        ['Levels available', `${formatInteger(diagnostics.completeness.levels)} / ${formatInteger(diagnostics.total)}`],
        ['Footprint property', `${formatInteger(diagnostics.completeness.footprintProperty)} / ${formatInteger(diagnostics.total)}`],
        ['Geometry area usable', `${formatInteger(diagnostics.completeness.geometryArea)} / ${formatInteger(diagnostics.total)}`],
        ['Highly incomplete records', formatInteger(diagnostics.missing.highlyIncomplete)]
    ]);
    if (!elements.recommendation) {
        return;
    }

    if (diagnostics.shouldPredict) {
        elements.recommendation.textContent = `Prediction is recommended. The dataset has ${formatInteger(diagnostics.known)} known archetypes and ${formatInteger(diagnostics.unknown)} unknown records to infer.`;
    } else if (diagnostics.needsCompletion) {
        elements.recommendation.textContent = 'Complete more input data before prediction. The current dataset has too few known archetypes or too many highly incomplete records for a useful model run.';
    } else {
        elements.recommendation.textContent = 'Prediction is optional. Unknown archetypes are limited, so review whether manual completion is faster.';
    }
}

function renderMetrics(container, rows) {
    if (!container) return;
    container.innerHTML = rows.map(([label, value]) => `
        <div class="metric">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `).join('');
}

function renderArchetypeCounts(diagnostics) {
    const container = elements.archetypeCounts;
    if (!container) return;

    if (!diagnostics.byArchetype.length) {
        container.innerHTML = '<div class="detail-row"><span>No archetypes found.</span><strong>-</strong></div>';
        return;
    }

    const maxCount = Math.max(...diagnostics.byArchetype.map(([, count]) => count), 1);
    container.innerHTML = diagnostics.byArchetype.slice(0, 12).map(([label, count]) => {
        const width = Math.max(2, (count / maxCount) * 100);
        return `
            <div class="type-row">
                <span>${escapeHtml(label)}</span>
                <strong>${formatInteger(count)}</strong>
                <div class="type-bar"><span style="width:${width.toFixed(1)}%"></span></div>
            </div>
        `;
    }).join('');
}

function renderDetailRows(container, rows) {
    if (!container) return;
    container.innerHTML = rows.map(([label, value]) => `
        <div class="detail-row">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `).join('');
}

function renderTrainingControls() {
    if (elements.smoteMultiplierInput) {
        elements.smoteMultiplierInput.value = String(state.modelSettings.smoteMaxMultiplier);
    }
    if (elements.confidenceThresholdInput) {
        elements.confidenceThresholdInput.value = String(Math.round(state.modelSettings.confidenceThreshold * 100));
    }
    renderFeatureOptions();
    updateTrainingReadouts();
}

function renderFeatureOptions() {
    if (!elements.featureSelectList) return;

    elements.featureSelectList.innerHTML = FEATURE_OPTIONS.map(([value, label]) => `
        <label class="feature-option">
            <input type="checkbox" value="${escapeHtml(value)}" ${state.modelSettings.featureNames.has(value) ? 'checked' : ''} />
            <span>${escapeHtml(label)}</span>
        </label>
    `).join('');

    elements.featureSelectList.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', () => {
            const nextFeatures = new Set(
                Array.from(elements.featureSelectList.querySelectorAll('input[type="checkbox"]:checked'))
                    .map(item => item.value)
            );

            if (!nextFeatures.size) {
                input.checked = true;
                nextFeatures.add(input.value);
            }

            state.modelSettings.featureNames = nextFeatures;
        });
    });
}

function updateTrainingReadouts() {
    if (elements.smoteMultiplierValue) {
        elements.smoteMultiplierValue.textContent = `${Math.round(state.modelSettings.smoteMaxMultiplier)}x`;
    }
    if (elements.confidenceThresholdValue) {
        elements.confidenceThresholdValue.textContent = `${Math.round(state.modelSettings.confidenceThreshold * 100)}%`;
    }
}

async function handleRunPrediction() {
    if (!state.activeGeojson) {
        window.alert('No GeoJSON dataset is loaded yet.');
        return;
    }

    const serviceUrl = config.ml_service_url;
    if (!serviceUrl) {
        window.alert('Missing ml_service_url in config.');
        return;
    }

    const capabilities = await getBackendCapabilities(serviceUrl);
    if (!capabilities.supportsTrainingControls) {
        window.alert('The running ML backend does not expose feature_names / SMOTE controls yet. Restart the ML service with npm run ml:start, then run prediction again.');
        return;
    }

    state.pendingPrediction = null;
    setSummaryActionsEnabled(false);
    setRunButtonState(true);
    setProgressState({ progress: 6, stage: 'preparing', message: 'Preparing the prediction request.' });
    showProgressOverlay();

    try {
        window.dispatchEvent(new CustomEvent('prediction-job-progress', {
            detail: {
                progress: 18,
                stage: 'loading_data',
                message: 'Loading the active GeoJSON from the prediction mode dataset.'
            }
        }));

        const job = await createPredictionJob({
            geojson: cloneGeojson(state.activeGeojson),
            serviceUrl,
            archetypeProperty: config.ml_archetype_property || 'building_archetype',
            heightProperty: config.height_field || 'height',
            confidenceThreshold: state.modelSettings.confidenceThreshold,
            smoteMaxMultiplier: state.modelSettings.smoteMaxMultiplier,
            featureNames: Array.from(state.modelSettings.featureNames)
        });

        window.dispatchEvent(new CustomEvent('prediction-job-progress', {
            detail: {
                progress: 30,
                stage: job.stage || 'queued',
                message: job.message || 'Prediction job queued on the backend.'
            }
        }));

        const result = await pollPredictionJob(job.job_id, serviceUrl);
        state.pendingPrediction = result;
        populateSummary(result);
        setSummaryActionsEnabled(true);
    } catch (error) {
        window.alert(error.message || 'Prediction failed.');
    } finally {
        hideProgressOverlay();
        setRunButtonState(false);
    }
}

async function getBackendCapabilities(serviceUrl) {
    const defaultCapabilities = {
        supportsTrainingControls: false,
        fields: new Set()
    };

    try {
        const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/openapi.json`, {
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) {
            state.backendCapabilities = defaultCapabilities;
            return state.backendCapabilities;
        }

        const openApi = await response.json();
        const fields = new Set(Object.keys(openApi?.components?.schemas?.PredictArchetypesRequest?.properties || {}));
        state.backendCapabilities = {
            fields,
            supportsTrainingControls: fields.has('feature_names') && fields.has('smote_max_multiplier') && fields.has('confidence_threshold')
        };
        return state.backendCapabilities;
    } catch {
        state.backendCapabilities = defaultCapabilities;
        return state.backendCapabilities;
    }
}

async function pollPredictionJob(jobId, serviceUrl) {
    while (true) {
        const job = await getPredictionJob({ jobId, serviceUrl });
        window.dispatchEvent(new CustomEvent('prediction-job-progress', { detail: job }));

        if (job.status === 'completed') {
            return job.result;
        }

        if (job.status === 'failed') {
            throw new Error(job.error || job.message || 'Prediction job failed.');
        }

        await new Promise(resolve => window.setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    }
}

function applyPendingPrediction({ silent = false } = {}) {
    if (!state.pendingPrediction?.geojson) {
        return;
    }

    state.activeGeojson = cloneGeojson(state.pendingPrediction.geojson);
    state.hasPredictionApplied = true;
    state.diagnostics = analyzeGeoJSON(state.activeGeojson);
    renderDiagnostics(state.diagnostics);
    setSummaryActionsEnabled(true);
    if (!silent) {
        elements.summaryMessage.textContent = 'Predicted GeoJSON is now active in this mode. Use Sync GeoJSON dataset to write it back to the configured public data file.';
    }
}

async function handleSyncGeojsonDataset() {
    if (!state.activeGeojson) {
        window.alert('No GeoJSON dataset is loaded yet.');
        return;
    }

    if (state.pendingPrediction?.geojson) {
        applyPendingPrediction({ silent: true });
    } else if (!state.hasPredictionApplied) {
        const proceed = window.confirm('No predicted GeoJSON has been applied in this mode yet. Sync the currently loaded dataset anyway?');
        if (!proceed) {
            return;
        }
    }

    elements.syncGeojsonDataset.disabled = true;
    elements.syncGeojsonDataset.textContent = 'Syncing...';

    try {
        const result = await syncGeoJSONDataset({
            geojson: state.activeGeojson,
            dataPath: config.buildings_source?.data || ''
        });
        state.sourceGeojson = cloneGeojson(state.activeGeojson);
        state.hasPredictionApplied = false;
        state.pendingPrediction = null;
        window.alert(`GeoJSON dataset synced. ${result?.feature_count ?? state.activeGeojson.features?.length ?? 0} features written to ${config.buildings_source?.data}.`);
    } catch (error) {
        window.alert(error.message || 'Unable to sync GeoJSON dataset.');
    } finally {
        elements.syncGeojsonDataset.disabled = false;
        elements.syncGeojsonDataset.textContent = 'Sync GeoJSON dataset';
    }
}

function populateSummary(result) {
    const metrics = result?.metrics || {};
    const featureImportances = result?.feature_importance || [];
    const classMetrics = Object.entries(metrics.classification_report || {}).filter(([label, value]) => (
        typeof value === 'object' &&
        label !== 'macro avg' &&
        label !== 'weighted avg'
    ));
    const appliedCount = metrics.predicted_count ?? metrics.unknown_count ?? 0;
    const retainedCount = metrics.retained_unknown_count ?? 0;
    const thresholdPercent = typeof metrics.confidence_threshold === 'number'
        ? `${Math.round(metrics.confidence_threshold * 100)}%`
        : '20%';

    elements.summaryAccuracy.textContent = typeof metrics.accuracy === 'number' ? `${(metrics.accuracy * 100).toFixed(1)}%` : '-';
    elements.summaryKnown.textContent = `${metrics.labeled_count ?? 0}`;
    elements.summaryUnknown.textContent = `${appliedCount}`;
    elements.summarySplit.textContent = `${metrics.train_count ?? 0} / ${metrics.test_count ?? 0}`;
    elements.summaryMessage.textContent = `The backend trained a random forest on known archetypes, evaluated it on an 80/20 split, applied ${appliedCount} predictions, and kept ${retainedCount} buildings as unknown below ${thresholdPercent} confidence.`;

    renderFeatureImportances(featureImportances);
    renderClassMetrics(classMetrics);
}

function renderFeatureImportances(featureImportances) {
    if (!elements.summaryFeatures) return;

    if (!featureImportances.length) {
        elements.summaryFeatures.innerHTML = '<div class="feature-row"><span class="feature-name">No feature importance available.</span><span class="feature-value">-</span><div class="feature-bar"><span style="width:0%"></span></div></div>';
        return;
    }

    const firstImportance = Number(featureImportances[0]?.importance) || 0;
    const maxImportance = firstImportance > 0
        ? firstImportance
        : Math.max(...featureImportances.map(feature => Number(feature.importance) || 0), 0.000001);
    elements.summaryFeatures.innerHTML = featureImportances.map(feature => `
        <div class="feature-row">
            <span class="feature-name">${escapeHtml(feature.feature)}</span>
            <span class="feature-value">${Number(feature.importance ?? 0).toFixed(3)}</span>
            <div class="feature-bar"><span style="width:${Math.max(2, ((Number(feature.importance) || 0) / maxImportance) * 100).toFixed(1)}%"></span></div>
        </div>
    `).join('');
}

function renderClassMetrics(classMetrics) {
    if (!elements.summaryClasses) return;

    if (!classMetrics.length) {
        elements.summaryClasses.innerHTML = '<table class="class-metrics-table class-metrics-table-empty"><tbody><tr><td>No class metrics available.</td><td>-</td></tr></tbody></table>';
        return;
    }

    elements.summaryClasses.innerHTML = `
        <table class="class-metrics-table">
            <thead>
                <tr>
                    <th>Class</th>
                    <th>Precision</th>
                    <th>Recall</th>
                    <th>F1</th>
                </tr>
            </thead>
            <tbody>
                ${classMetrics.slice(0, 12).map(([label, values]) => `
                    <tr>
                        <td>${escapeHtml(formatArchetypeName(label))}</td>
                        <td>${Number(values.precision ?? 0).toFixed(3)}</td>
                        <td>${Number(values.recall ?? 0).toFixed(3)}</td>
                        <td>${Number(values['f1-score'] ?? 0).toFixed(3)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function setSummaryEmpty(message) {
    elements.summaryMessage.textContent = message;
    elements.summaryAccuracy.textContent = '-';
    elements.summaryKnown.textContent = '-';
    elements.summaryUnknown.textContent = '-';
    elements.summarySplit.textContent = '-';
    elements.summaryFeatures.innerHTML = '';
    elements.summaryClasses.innerHTML = '';
}

function setSummaryActionsEnabled(enabled) {
    [elements.downloadPrediction, elements.keepCurrentData].forEach(button => {
        if (button) button.disabled = !enabled;
    });
}

function setRunButtonState(isRunning) {
    if (!elements.runPrediction) return;
    elements.runPrediction.disabled = isRunning;
    elements.runPrediction.textContent = isRunning ? 'Predicting...' : 'Predict Unknown Archetypes';
}

function setProgressState({ progress = 0, stage = 'Queued', message = 'Preparing request' } = {}) {
    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    elements.progressBar.style.width = `${safeProgress}%`;
    elements.progressPercent.textContent = `${Math.round(safeProgress)}%`;
    elements.progressStage.textContent = formatStage(stage);
    elements.progressMessage.textContent = message;
}

function showProgressOverlay() {
    elements.progressOverlay.classList.add('show');
    elements.progressOverlay.setAttribute('aria-hidden', 'false');
}

function hideProgressOverlay() {
    elements.progressOverlay.classList.remove('show');
    elements.progressOverlay.setAttribute('aria-hidden', 'true');
}

function renderLoadError(error) {
    const message = error?.message || 'Unable to load GeoJSON diagnostics.';
    elements.recommendation.textContent = message;
    setSummaryEmpty(message);
    elements.runPrediction.disabled = true;
}

function hasPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
}

function cloneGeojson(geojson) {
    return JSON.parse(JSON.stringify(geojson));
}

function buildPredictionFilename() {
    const baseName = state.datasetName.replace(/\.geojson$|\.json$/i, '');
    return `${baseName}_predicted.geojson`;
}

function downloadGeoJSON(geojson, filename) {
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function formatStage(stage) {
    return String(stage || 'queued')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, match => match.toUpperCase());
}

function formatInteger(value) {
    return Math.round(Number(value) || 0).toLocaleString();
}

function formatPercent(value) {
    return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
