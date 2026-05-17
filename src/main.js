import './style.css';
import { UBEMViewer } from './mapbox.js';
import config from '../user-data/config.json';
import * as Charts from './charts.js';
import { formatArchetypeName, processArchetypeData } from './data-processor.js';
import * as XLSX from 'xlsx';
import * as echarts from 'echarts';
import './popup.js';
import idfTemplateLibrary from '../user-data/simulation/templates.json';

// 模块级viewer实例，供 initArchetypeData 访问
let viewer = null;
const DESCRIPTIONS = config.archetype_descriptions || {};
const idfTemplateMap = Object.fromEntries(
    idfTemplateLibrary
        .filter(item => item?.archetype && item?.simulation_parameters)
        .map(item => [item.archetype, item.simulation_parameters])
);
const PARAMETER_SECTIONS = [
    {
        title: 'Envelope',
        fields: [
            { key: 'wwr', label: 'Window to wall ratio' },
            { key: 'u_roof', label: 'Roof U-value', unit: 'W/m²K' },
            { key: 'u_wall', label: 'Wall U-value', unit: 'W/m²K' },
            { key: 'u_floor', label: 'Floor U-value', unit: 'W/m²K' },
            { key: 'u_win', label: 'Window U-value', unit: 'W/m²K' },
            { key: 'shgc', label: 'Solar Heat Gain Coefficient' },
            { key: 'ach', label: 'Air Changes per Hour', unit: '1/hr' }
        ]
    },
    {
        title: 'Internal Loads',
        fields: [
            { key: 'occ', label: 'Occupancy density', unit: 'person/m²' },
            { key: 'epd', label: 'Equipment power density', unit: 'W/m²' },
            { key: 'lpd', label: 'Lighting power density', unit: 'W/m²' },
            { key: 'hw_lppd', label: 'Hot Water per person', unit: 'L/person/day' }
        ]
    },
    {
        title: 'HVAC',
        fields: [
            { key: 'hvac_system', label: 'HVAC System' },
            { key: 'cop_cool', label: 'Cooling COP' },
            { key: 't_cool', label: 'Cooling Setpoint', unit: 'C' }
        ]
    }
];
const SCHEDULE_PAIR_CHARTS = [
    { key: 'occupancy', title: 'Occupancy' },
    { key: 'lighting', title: 'Lighting' },
    { key: 'equipment', title: 'Equipment' },
    { key: 'hotwater', title: 'Hot Water' }
];
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
            renderOperationalCarbonPanel(e.target.value);
            updateArchetypeDescription(e.target.value);
        });
    }

    // 清除按钮重置过滤
    document.querySelector('.clear-btn')?.addEventListener('click', () => {
        if (archetypeSelect) archetypeSelect.value = '';
        viewer.filterByArchetype('');
        Charts.updateArchetypeBarHighlight('');
        renderOperationalCarbonPanel('');
        updateArchetypeDescription('');
    });

    // --- 6. 初始化UI控件 (不依赖颜色) ---
    Charts.initSunburstUI();
    updateModuleActionButtons('type');

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
    Charts.updateArchetypeBarHighlight(document.getElementById('archetype')?.value || '');
    renderOperationalCarbonPanel(document.getElementById('archetype')?.value || '');
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

function renderOperationalCarbonPanel(selectedArchetype) {
    const container = document.getElementById('energy-underselect');
    if (!container) {
        return;
    }

    const selected = selectedArchetype || '';
    if (!selected) {
        container.classList.remove('operational-carbon-panel');
        container.innerHTML = `
            <h4>Energy Use Intensity (kWh/m²)</h4>
            <div id="downloadEnergyBar" class="downloadBar">Download</div>
            <div id="energyChartContainer" class="ChartContainer"></div>
        `;
        Charts.initEnergyBarChart(config);
        Charts.updateArchetypeBarHighlight('');
        return;
    }

    const templateKey = findMatchingKey(Object.keys(idfTemplateMap), selected);
    const template = idfTemplateMap[templateKey] || idfTemplateMap.unknown;
    const displayName = selected || 'All archetypes';
    const stats = window.archetypeStats?.[selected];
    const energyData = getOperationalEnergyData(selected);

    container.classList.add('operational-carbon-panel');
    container.innerHTML = `
        <section class="operational-carbon-module">
            <div class="operational-carbon-module-header">
                <h4>Archetype Template</h4>
                <span>${escapeHtml(formatArchetypeName(templateKey || selected || 'unknown'))}</span>
            </div>
            ${selected ? renderTemplateSections(template) : '<p class="operational-carbon-empty">Select an archetype to view its template parameters.</p>'}
            ${selected ? renderScheduleSection(template?.schedules || DEFAULT_SCHEDULES, selected) : ''}
        </section>
        <section class="operational-carbon-module">
            <div class="operational-carbon-module-header">
                <h4>Feature Results</h4>
                <span>${escapeHtml(displayName)}</span>
            </div>
            ${renderFeatureResults(stats, energyData)}
        </section>
        ${selected ? renderTemplateDownloadActions() : ''}
    `;

    if (selected) {
        window.requestAnimationFrame(() => {
            container.querySelectorAll('[data-schedule-pair-canvas]').forEach(canvas => {
                const key = canvas.getAttribute('data-schedule-pair-canvas');
                drawSchedulePairCanvas(canvas, template?.schedules || DEFAULT_SCHEDULES, key);
            });

            const downloadJsonButton = container.querySelector('[data-template-download="json"]');
            downloadJsonButton?.addEventListener('click', () => {
                triggerDownload(
                    JSON.stringify({
                        archetype: selected,
                        simulation_parameters: template
                    }, null, 2),
                    `template_${sanitizeFilename(selected)}_parameters.json`,
                    'application/json'
                );
            });

            const downloadIdfButton = container.querySelector('[data-template-download="idf"]');
            downloadIdfButton?.addEventListener('click', () => {
                void downloadGeneratedTemplateIdf(templateKey || selected);
            });
        });
    }
}

async function downloadGeneratedTemplateIdf(archetype) {
    const slug = slugifyArchetype(archetype || 'unknown');
    const candidates = [
        `${(config.simulation_service_url || 'http://localhost:8010').replace(/\/$/, '')}/idf-templates/file/${encodeURIComponent(archetype || 'unknown')}`
    ];

    let lastError = null;
    for (const url of candidates) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const text = await response.text();
            if (!text.trim()) {
                throw new Error('IDF file is empty.');
            }
            triggerDownload(text, `template_${slug}.idf`, 'text/plain');
            return;
        } catch (error) {
            lastError = error;
        }
    }

    window.alert(lastError?.message || `Unable to download generated IDF for ${archetype}.`);
}

function slugifyArchetype(value) {
    return String(value || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

function renderTemplateDownloadActions() {
    return `
        <div class="operational-template-actions">
            <button type="button" data-template-download="json">Download template json</button>
            <button type="button" data-template-download="idf">Download template idf</button>
        </div>
    `;
}

function renderTemplateSections(template) {
    return PARAMETER_SECTIONS.map(section => `
        <div class="operational-template-section">
            <div class="operational-template-title">${escapeHtml(section.title)}</div>
            <div class="operational-template-rows">
                ${section.fields.map(field => renderMetricRow(field.label, formatParameterValue(field, template?.[field.key]))).join('')}
            </div>
        </div>
    `).join('');
}

function renderScheduleSection(schedules, selectedArchetype) {
    return `
        <div class="operational-template-section">
            <div class="operational-template-title">Schedule</div>
            <div class="operational-schedule-grid">
                ${SCHEDULE_PAIR_CHARTS.map(chart => `
                    <div class="operational-schedule-card">
                        <div class="operational-schedule-header">
                            <span>${escapeHtml(chart.title)}</span>
                            <div class="operational-schedule-legend">
                                <span><i class="weekday-line"></i>Workday</span>
                                <span><i class="weekend-line"></i>Weekend</span>
                            </div>
                        </div>
                        <canvas class="operational-schedule-canvas" data-schedule-pair-canvas="${escapeHtml(chart.key)}" aria-label="${escapeHtml(`${selectedArchetype} ${chart.title} schedule`)}"></canvas>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderFeatureResults(stats, energyData) {
    const columns = config.operational_energy_data?.columns || [];
    const energyRows = energyData
        ? columns.map((column, index) => renderMetricRow(formatColumnLabel(column), formatMetricValue(energyData[index], 'kWh/m²/yr'))).join('')
        : renderMetricRow('Operational energy data', 'No matching value');

    return `
        <div class="operational-template-section">
            <div class="operational-template-title">GeoJSON Features</div>
            <div class="operational-template-rows">
                ${renderMetricRow('Building count', stats ? formatInteger(stats.count) : '0')}
                ${renderMetricRow('Total footprint', stats ? formatMetricValue(stats.footprintArea, 'm²') : '0 m²')}
            </div>
        </div>
        <div class="operational-template-section">
            <div class="operational-template-title">Energy Use Intensity</div>
            <div class="operational-template-rows">${energyRows}</div>
        </div>
    `;
}

function renderMetricRow(label, value) {
    return `
        <div class="operational-metric-row">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function getOperationalEnergyData(selectedArchetype) {
    const data = config.operational_energy_data?.data || {};
    const key = findMatchingKey(Object.keys(data), selectedArchetype);
    return key ? data[key] : null;
}

function findMatchingKey(keys, selectedArchetype) {
    if (!selectedArchetype) {
        return keys.includes('unknown') ? 'unknown' : '';
    }

    const selectedNorm = normalizeMatchKey(selectedArchetype);
    return keys.find(key => normalizeMatchKey(key) === selectedNorm)
        || keys.find(key => normalizeMatchKey(formatArchetypeName(key)) === selectedNorm)
        || keys.find(key => selectedNorm.includes(normalizeMatchKey(key)) || normalizeMatchKey(key).includes(selectedNorm))
        || '';
}

function drawSchedulePairCanvas(canvas, schedules, groupKey) {
    const weekday = normalizeScheduleArray(schedules?.[`${groupKey}_weekday`] || DEFAULT_SCHEDULES[`${groupKey}_weekday`]);
    const weekend = normalizeScheduleArray(schedules?.[`${groupKey}_weekend`] || DEFAULT_SCHEDULES[`${groupKey}_weekend`]);
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width || canvas.parentElement?.clientWidth || 320));
    const height = Math.max(1, Math.floor(rect.height || 140));

    if (canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio)) {
        canvas.width = Math.floor(width * pixelRatio);
        canvas.height = Math.floor(height * pixelRatio);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const plot = { left: 20, top: 12, right: width - 10, bottom: height - 22 };
    plot.width = Math.max(1, plot.right - plot.left);
    plot.height = Math.max(1, plot.bottom - plot.top);

    ctx.strokeStyle = '#e8edf2';
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

    drawScheduleLine(ctx, plot, weekend, '#b8bec6', true);
    drawScheduleLine(ctx, plot, weekday, '#333333', false);
}

function drawScheduleLine(ctx, plot, values, color, solidPoints) {
    const points = values.map((value, hour) => [
        plot.left + (hour / 23) * plot.width,
        plot.bottom - clamp01(value) * plot.height
    ]);

    ctx.beginPath();
    points.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = solidPoints ? 1.7 : 2.2;
    ctx.stroke();

    points.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, solidPoints ? 2.9 : 3.1, 0, Math.PI * 2);
        ctx.fillStyle = solidPoints ? color : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
    });
}

function normalizeScheduleArray(values) {
    const source = Array.isArray(values) && values.length ? values : [];
    return Array.from({ length: 24 }, (_, index) => {
        const raw = Number(source[index] ?? source[source.length - 1] ?? 0);
        return clamp01(Number.isFinite(raw) ? raw : 0);
    });
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
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

function formatMetricValue(value, unit = '') {
    if (value === undefined || value === null || value === '') {
        return unit ? `-- ${unit}` : '--';
    }

    if (typeof value === 'number') {
        const formatted = Math.abs(value) >= 1000 ? formatInteger(value) : Number(value.toFixed(3)).toString();
        return unit ? `${formatted} ${unit}` : formatted;
    }

    return unit ? `${value} ${unit}` : String(value);
}

function formatParameterValue(field, value) {
    if (field.key === 'hvac_system' && typeof value === 'string') {
        return value
            .split('_')
            .filter(Boolean)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    return formatMetricValue(value, field.unit);
}

function formatInteger(value) {
    return Math.round(Number(value) || 0).toLocaleString();
}

function formatColumnLabel(column) {
    return String(column || '')
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function normalizeMatchKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sanitizeFilename(value) {
    return String(value || 'export')
        .replace(/[^a-z0-9_-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'export';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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

    const energyBreakdownLegend = document.querySelector('.energy-breakdown-container');
    if (energyBreakdownLegend) {
        energyBreakdownLegend.classList.toggle('active', activeLayer === 'energy');
    }

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
        renderOperationalCarbonPanel(document.getElementById('archetype')?.value || '');
    }

    // 3. 更新面板标题
    ['type', 'carbon', 'energy'].forEach(k => {
        const el = document.getElementById(`title-${k}`);
        if (el) el.style.display = k === activeLayer ? 'block' : 'none';
    });

    updateModuleActionButtons(activeLayer);

    // 4. 显示面板
    const resultPanel = document.querySelector('.result-panel');
    if (resultPanel) {
        resultPanel.style.display = '';
        resultPanel.classList.add('show');
    }
}

function updateModuleActionButtons(activeLayer) {
    const predictBtn = document.getElementById('open-archetype-prediction-floating');
    const openModeBtn = document.getElementById('open-energy-simulation-floating');

    if (!predictBtn || !openModeBtn) {
        return;
    }

    if (activeLayer === 'energy') {
        predictBtn.style.display = 'none';
        openModeBtn.style.display = 'inline-flex';
        return;
    }

    predictBtn.style.display = activeLayer === 'type' ? 'inline-flex' : 'none';
    openModeBtn.style.display = 'none';
}
