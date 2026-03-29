import './style.css';
import { UBEMViewer } from './mapbox.js';
import config from './config.json';
import * as Charts from './charts.js';
import { formatArchetypeName, processArchetypeData, processArchetypeGeoJSON } from './data-processor.js';
import { createPredictionJob, fetchGeoJSON, getPredictionJob } from './ml-api.js';
import * as XLSX from 'xlsx';
import * as echarts from 'echarts';
import './popup.js';

// 模块级viewer实例，供 initArchetypeData 访问
let viewer = null;
let currentGeoJSONPath = '';
let pendingMlPrediction = null;
let currentGeoJSONName = '';
const DESCRIPTIONS = config.archetype_descriptions || {};

function getConfiguredGeoJSONPath() {
    const geojsonPath = config.buildings_source?.data;

    if (!geojsonPath) {
        throw new Error('Missing config.buildings_source.data. Set it to the GeoJSON file you want the app and ML workflow to use.');
    }

    return geojsonPath;
}

// --- 1. 页面初始化设置 ---
document.addEventListener('DOMContentLoaded', async () => {
    // 动态注入城市名称
    const cityElements = document.querySelectorAll('#dynamic-city-name, .dynamic-city-name');
    cityElements.forEach(el => el.innerText = config.city_name || "Singapore");
    
    // 修改网页标题
    document.title = `Buildings.city | ${config.city_name || "UBEM Platform"}`;

    // --- 2. 初始化地图核心类 ---
    viewer = new UBEMViewer(config);
    await viewer.init();

    // --- 3. 加载进度控制 ---
    // 模拟进度条，Mapbox 的 'load' 事件触发后完成
    let progress = 0;
    const progressInterval = setInterval(() => {
        if (progress < 90) {
            progress += 5;
            updateProgress(progress);
        }
    }, 200);

    viewer.map.on('load', () => {
        clearInterval(progressInterval);
        updateProgress(100);
        
        // 延迟隐藏加载遮罩
        setTimeout(() => {
            const overlay = document.getElementById("loadingOverlay");
            if (overlay) {
                overlay.style.opacity = '0';
                overlay.style.transition = 'opacity 0.8s ease';
                setTimeout(() => overlay.style.display = "none", 800);
            }
        }, 1000);

        // 初始化archetype数据
        initArchetypeData();
    });

    function updateProgress(percent) {
        const bar = document.getElementById("progressBarInner");
        if (bar) bar.style.width = percent + "%";
    }

    // --- 4. 导航栏图层切换 (Archetype / Carbon / Energy) ---
    const navLinks = {
        'type-link': 'type',
        'carbon-link': 'carbon',
        'energy-link': 'energy'
    };

    Object.keys(navLinks).forEach(id => {
        const link = document.getElementById(id);
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                
                // 1. 更新导航样式
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                link.classList.add('active');

                // 2. 调用地图图层切换逻辑
                const layerType = navLinks[id];
                viewer._toggleLayer(layerType);

                // 3. 更新 UI 面板显示 (根据图层显示/隐藏侧边栏容器)
                updatePanelUI(layerType);

                // 4. 如果是type类型，生成动态sunburst图表
                if (layerType === 'type' && window.archetypeStats && Object.keys(window.archetypeStats).length > 0) {
                    renderDynamicArchetypeSuncharts();
                }
            });
        }
    });

    // --- 5. archetype下拉菜单过滤地图
    const archetypeSelect = document.getElementById('archetype');
    if (archetypeSelect) {
        archetypeSelect.addEventListener('change', (e) => {
            viewer.filterByArchetype(e.target.value);
            Charts.updateArchetypeBarHighlight(e.target.value);
            updateArchetypeDescription(e.target.value);
        });
    }

    // 清除按钮重置过滤
    document.querySelector('.clear-btn')?.addEventListener('click', () => {
        if (archetypeSelect) archetypeSelect.value = '';
        viewer.filterByArchetype('');
        Charts.updateArchetypeBarHighlight('');
        updateArchetypeDescription('');
    });

    // --- 6. 初始化UI控件 (不依赖颜色) ---
    Charts.initSunburstUI();
    setupMlPredictionUI();

    // --- 7. 其它 UI 控制 (2D, 关闭面板等) ---
    
    // 2D/3D 切换
    document.getElementById('toggle2D')?.addEventListener('click', () => {
        viewer.map.easeTo({ pitch: 0, duration: 1000 });
    });

    // 关闭结果面板
    document.getElementById('close-panel')?.addEventListener('click', () => {
        const panel = document.querySelector('.result-panel');
        if (panel) panel.style.display = 'none';
    });

    // 测量工具关闭按钮
    document.getElementById('close-calc')?.addEventListener('click', () => {
        const box = document.querySelector('.calculation-box');
        if (box) box.style.display = 'none';
        viewer.draw.deleteAll(); // 清除地图上的绘制
    });
});

/**
 * 初始化archetype数据：加载GeoJSON，统计数据，填充下拉菜单
 */
async function initArchetypeData() {
    try {
        const geojsonPath = getConfiguredGeoJSONPath();
        currentGeoJSONPath = geojsonPath;
        currentGeoJSONName = geojsonPath.split('/').pop() || 'buildings.geojson';
        const result = await processArchetypeData(geojsonPath);
        applyArchetypeResult(result);

        console.log("Archetype data initialized:", result.stats);
    } catch (e) {
        console.error("Failed to initialize archetype data:", e);
    }
}

function applyArchetypeResult(result) {
    window.archetypeStats = result.stats;
    window.archetypeColorMap = result.colorMap;
    window.archetypeRawColorMap = result.rawColorMap;

    if (result.geojson) {
        window.currentBuildingGeoJSON = result.geojson;
        viewer?.updateBuildingData(result.geojson);
    }

    viewer.updateArchetypeColors(result.rawColorMap);

    const legendGrid = document.getElementById('archetype-legend-grid');
    if (legendGrid) {
        legendGrid.innerHTML = '';
        Object.entries(result.colorMap).forEach(([name, color]) => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `<div class="legend-box" style="background-color:${color};flex-shrink:0;"></div><span>${name}</span>`;
            legendGrid.appendChild(item);
        });
    }

    const archetypeSelect = document.getElementById('archetype');
    if (archetypeSelect) {
        archetypeSelect.innerHTML = '<option value="">All archetypes</option>';
        result.archetypes.forEach(archetype => {
            const option = document.createElement('option');
            option.value = archetype;
            option.textContent = archetype;
            archetypeSelect.appendChild(option);
        });
    }

    Charts.initCarbonBarChart(config);
    Charts.initEnergyBarChart(config);
    Charts.updateArchetypeBarHighlight(document.getElementById('archetype')?.value || '');
    updateArchetypeDescription(document.getElementById('archetype')?.value || '');
    renderDynamicArchetypeSuncharts();
}

function updateArchetypeDescription(selectedArchetype) {
    const descriptionEl = document.getElementById('archetype-description');
    if (!descriptionEl) {
        return;
    }

    descriptionEl.textContent = DESCRIPTIONS[selectedArchetype] || 'Select a type or an archetype to view the description.';
}

async function runMlArchetypePrediction() {
    const serviceUrl = config.ml_service_url;
    if (!serviceUrl) {
        throw new Error('Missing ml_service_url in config');
    }

    window.dispatchEvent(new CustomEvent('ml-job-progress', {
        detail: {
            progress: 14,
            stage: 'loading_data',
            message: 'Loading the active GeoJSON from the configured data source.'
        }
    }));
    const activeGeoJSON = await getActiveGeoJSON();

    window.dispatchEvent(new CustomEvent('ml-job-progress', {
        detail: {
            progress: 24,
            stage: 'submitting',
            message: 'Submitting GeoJSON to the backend service.'
        }
    }));
    const job = await createPredictionJob({
        geojson: activeGeoJSON,
        serviceUrl,
        archetypeProperty: config.ml_archetype_property || 'building_archetype',
        heightProperty: config.height_field || 'height'
    });

    window.dispatchEvent(new CustomEvent('ml-job-progress', {
        detail: {
            progress: 30,
            stage: job.stage || 'queued',
            message: job.message || 'Prediction job queued on the backend.'
        }
    }));

    return pollMlPredictionJob(job.job_id, serviceUrl);
}

async function pollMlPredictionJob(jobId, serviceUrl) {
    while (true) {
        const job = await getPredictionJob({ jobId, serviceUrl });
        window.dispatchEvent(new CustomEvent('ml-job-progress', { detail: job }));

        if (job.status === 'completed') {
            return job.result;
        }

        if (job.status === 'failed') {
            throw new Error(job.error || job.message || 'Prediction job failed');
        }

        await new Promise(resolve => window.setTimeout(resolve, 700));
    }
}

function setupMlPredictionUI() {
    const triggerBtn = document.getElementById('run-ml-prediction');
    const progressOverlay = document.getElementById('mlProgressOverlay');
    const summaryOverlay = document.getElementById('mlSummaryOverlay');
    const progressBar = document.getElementById('mlProgressBarInner');
    const progressPercent = document.getElementById('mlProgressPercent');
    const progressStage = document.getElementById('mlProgressStage');
    const progressMessage = document.getElementById('mlProgressMessage');
    const confirmBtn = document.getElementById('mlConfirmApply');
    const cancelBtn = document.getElementById('mlCancelApply');
    const downloadBtn = document.getElementById('mlDownloadPrediction');

    if (!triggerBtn || !progressOverlay || !summaryOverlay) {
        return;
    }

    const setProgressState = ({ progress = 0, stage = 'Queued', message = 'Preparing request' } = {}) => {
        if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        if (progressPercent) progressPercent.textContent = `${Math.round(progress)}%`;
        if (progressStage) progressStage.textContent = formatMlStage(stage);
        if (progressMessage) progressMessage.textContent = message;
    };

    const showProgressOverlay = () => {
        summaryOverlay.classList.remove('show');
        progressOverlay.classList.add('show');
        progressOverlay.setAttribute('aria-hidden', 'false');
    };

    const hideProgressOverlay = () => {
        progressOverlay.classList.remove('show');
        progressOverlay.setAttribute('aria-hidden', 'true');
    };

    const showSummaryOverlay = () => {
        summaryOverlay.classList.add('show');
        summaryOverlay.setAttribute('aria-hidden', 'false');
    };

    const hideSummaryOverlay = () => {
        summaryOverlay.classList.remove('show');
        summaryOverlay.setAttribute('aria-hidden', 'true');
    };

    window.addEventListener('ml-job-progress', event => {
        const detail = event.detail || {};
        setProgressState({
            progress: detail.progress,
            stage: detail.stage,
            message: detail.message
        });
    });

    triggerBtn.addEventListener('click', async () => {
        triggerBtn.disabled = true;
        triggerBtn.textContent = 'Predicting...';
        pendingMlPrediction = null;

        try {
            setProgressState({ progress: 6, stage: 'preparing', message: 'Preparing the prediction request.' });
            showProgressOverlay();

            const result = await runMlArchetypePrediction();
            pendingMlPrediction = result;
            hideProgressOverlay();
            populateMlSummary(result);
            showSummaryOverlay();
        } catch (error) {
            hideProgressOverlay();
            window.alert(error.message || 'Prediction failed');
        } finally {
            triggerBtn.disabled = false;
            triggerBtn.textContent = 'Predict Unknown Archetypes';
        }
    });

    confirmBtn?.addEventListener('click', () => {
        if (!pendingMlPrediction?.geojson) {
            hideSummaryOverlay();
            return;
        }

        const processed = processArchetypeGeoJSON(pendingMlPrediction.geojson);
        applyArchetypeResult(processed);
        window.lastMlPrediction = pendingMlPrediction;
        pendingMlPrediction = null;
        hideSummaryOverlay();
    });

    cancelBtn?.addEventListener('click', () => {
        pendingMlPrediction = null;
        hideSummaryOverlay();
    });

    downloadBtn?.addEventListener('click', () => {
        if (!pendingMlPrediction?.geojson) {
            return;
        }

        downloadGeoJSON(pendingMlPrediction.geojson, buildPredictionFilename());
    });
}

async function getActiveGeoJSON() {
    if (window.currentBuildingGeoJSON) {
        return JSON.parse(JSON.stringify(window.currentBuildingGeoJSON));
    }

    const geojsonPath = currentGeoJSONPath || getConfiguredGeoJSONPath();
    const geojson = await fetchGeoJSON(geojsonPath);
    return JSON.parse(JSON.stringify(geojson));
}

function buildPredictionFilename() {
    const baseName = (currentGeoJSONName || 'buildings.geojson').replace(/\.geojson$|\.json$/i, '');
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

function formatMlStage(stage) {
    return String(stage || 'queued')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, match => match.toUpperCase());
}

function populateMlSummary(result) {
    const metrics = result?.metrics || {};
    const featureImportances = result?.feature_importance || [];
    const classMetrics = Object.entries(metrics.classification_report || {}).filter(([label, value]) => (
        typeof value === 'object' &&
        label !== 'macro avg' &&
        label !== 'weighted avg'
    ));

    const accuracyEl = document.getElementById('mlSummaryAccuracy');
    const knownEl = document.getElementById('mlSummaryKnown');
    const unknownEl = document.getElementById('mlSummaryUnknown');
    const splitEl = document.getElementById('mlSummarySplit');
    const messageEl = document.getElementById('mlSummaryMessage');
    const featuresEl = document.getElementById('mlSummaryFeatures');
    const classesEl = document.getElementById('mlSummaryClasses');

    if (accuracyEl) accuracyEl.textContent = typeof metrics.accuracy === 'number' ? `${(metrics.accuracy * 100).toFixed(1)}%` : '-';
    if (knownEl) knownEl.textContent = `${metrics.labeled_count ?? 0}`;
    if (unknownEl) unknownEl.textContent = `${metrics.predicted_count ?? metrics.unknown_count ?? 0}`;
    if (splitEl) splitEl.textContent = `${metrics.train_count ?? 0} / ${metrics.test_count ?? 0}`;
    if (messageEl) {
        const appliedCount = metrics.predicted_count ?? metrics.unknown_count ?? 0;
        const retainedCount = metrics.retained_unknown_count ?? 0;
        const thresholdPercent = typeof metrics.confidence_threshold === 'number' ? `${Math.round(metrics.confidence_threshold * 100)}%` : '20%';
        messageEl.textContent = `The backend trained a random forest on the known archetypes, evaluated it on an 80/20 split, applied ${appliedCount} predictions for unknown buildings, and kept ${retainedCount} buildings as unknown when confidence stayed below ${thresholdPercent}. Apply the updated GeoJSON if the summary looks acceptable.`;
    }

    if (featuresEl) {
        featuresEl.innerHTML = '';
        featureImportances.forEach(feature => {
            const row = document.createElement('div');
            row.className = 'ml-feature-row';
            row.innerHTML = `<span class="ml-feature-name">${feature.feature}</span><span class="ml-feature-value">${feature.importance.toFixed(3)}</span>`;
            featuresEl.appendChild(row);
        });

        if (!featureImportances.length) {
            featuresEl.innerHTML = '<div class="ml-feature-name">No feature importance available.</div>';
        }
    }

    if (classesEl) {
        classesEl.innerHTML = '';

        if (classMetrics.length) {
            const header = document.createElement('div');
            header.className = 'ml-class-row ml-class-header';
            header.innerHTML = '<span class="ml-class-name">Class</span><span class="ml-class-metric">Precision</span><span class="ml-class-metric">Recall</span><span class="ml-class-metric">F1</span>';
            classesEl.appendChild(header);

            classMetrics.slice(0, 8).forEach(([label, values]) => {
                const row = document.createElement('div');
                row.className = 'ml-class-row';
                row.innerHTML = `
                    <span class="ml-class-name">${formatArchetypeName(label)}</span>
                    <span class="ml-class-metric">${(values.precision ?? 0).toFixed(2)}</span>
                    <span class="ml-class-metric">${(values.recall ?? 0).toFixed(2)}</span>
                    <span class="ml-class-metric">${(values['f1-score'] ?? 0).toFixed(2)}</span>
                `;
                classesEl.appendChild(row);
            });
        } else {
            classesEl.innerHTML = '<div class="ml-feature-name">No class metrics available.</div>';
        }
    }
}

window.runMlArchetypePrediction = runMlArchetypePrediction;

/**
 * 生成动态Archetype Sunburst图表
 */
function renderDynamicArchetypeSuncharts() {
    const stats = window.archetypeStats;
    if (!stats || Object.keys(stats).length === 0) {
        console.warn('No archetype statistics available');
        return;
    }

    // 获取DOM元素
    const sunChartsNumberDom = document.getElementById('sunchartsnumber');
    const sunChartsFootprintDom = document.getElementById('sunchartsfootprint');

    if (sunChartsNumberDom) {
        const chart = echarts.getInstanceByDom(sunChartsNumberDom) || echarts.init(sunChartsNumberDom, null, { renderer: 'canvas' });
        const option = Charts.getDynamicArchetypeSunburstOption(stats);
        chart.setOption(option);
        chart.resize();
    }

    if (sunChartsFootprintDom) {
        const chart = echarts.getInstanceByDom(sunChartsFootprintDom) || echarts.init(sunChartsFootprintDom, null, { renderer: 'canvas' });
        const option = Charts.getDynamicArchetypeFootprintSunburstOption(stats);
        chart.setOption(option);
        chart.resize();
    }
}

/**
 * 根据当前激活的图层更新侧边栏和图例的显示状态
 * @param {string} activeLayer 'type' | 'carbon' | 'energy'
 */
function updatePanelUI(activeLayer) {
    // 1. 更新图例 (Legend)
    document.querySelectorAll('.legend-container').forEach(el => {
        el.classList.remove('active');
        if (el.classList.contains(activeLayer)) {
            el.classList.add('active');
        }
    });

    // 2. 更新侧边栏内容显示
    const carbonContainer = document.getElementById('carbon-container');
    const energyContainer = document.getElementById('energy-container');
    const archetypeCharts = document.getElementById('archetype-charts');

    if (activeLayer === 'type') {
        if (archetypeCharts) archetypeCharts.style.display = 'block';
        if (carbonContainer) carbonContainer.style.display = 'none';
        if (energyContainer) energyContainer.style.display = 'none';
    } else if (activeLayer === 'carbon') {
        if (archetypeCharts) archetypeCharts.style.display = 'none';
        if (carbonContainer) carbonContainer.style.display = 'block';
        if (energyContainer) energyContainer.style.display = 'none';
        // 面板从隐藏变为可见，需要触发图表重绘以获得正确尺寸
        const carbonChart = echarts.getInstanceByDom(document.getElementById('carbonChartContainer'));
        if (carbonChart) carbonChart.resize();
    } else if (activeLayer === 'energy') {
        if (archetypeCharts) archetypeCharts.style.display = 'none';
        if (carbonContainer) carbonContainer.style.display = 'none';
        if (energyContainer) energyContainer.style.display = 'block';
        const energyChart = echarts.getInstanceByDom(document.getElementById('energyChartContainer'));
        if (energyChart) energyChart.resize();
    }

    // 3. 更新面板标题
    ['type', 'carbon', 'energy'].forEach(k => {
        const el = document.getElementById(`title-${k}`);
        if (el) el.style.display = k === activeLayer ? 'block' : 'none';
    });

    // 4. 显示面板
    const resultPanel = document.querySelector('.result-panel');
    if (resultPanel) resultPanel.classList.add('show');
}
