import * as echarts from 'echarts';
import { processArchetypeData } from './data-processor';
import { getDynamicArchetypeSunburstOption, getDynamicArchetypeFootprintSunburstOption } from './charts';

// 全局变量，存储统计数据供charts.js使用
window.archetypeStats = {};

export async function initControlPanel(map, jsonPath = './config.json') {
    // 1. 获取动态数据
    let userData = null;
    try {
        const res = await fetch(jsonPath);
        userData = await res.json();
    } catch (e) { console.error("Data load failed", e); return; }

    // 2. 从GeoJSON加载archetype list和统计数据
    let archetypeList = [];
    try {
        const geojsonPath = userData.buildings_source?.data;
        if (!geojsonPath) {
            throw new Error('Missing buildings_source.data in config.');
        }
        const result = await processArchetypeData(geojsonPath);
        archetypeList = result.archetypes;
        window.archetypeStats = result.stats;
        window.archetypeColorMap = result.colorMap; // 全项目统一颜色映射
        console.log("Loaded archetypes from GeoJSON:", archetypeList);
        console.log("Archetype statistics:", result.stats);
        populateLegend(result.colorMap);
    } catch (e) {
        console.error("Failed to load archetypes from GeoJSON", e);
    }

    // 2b. 动态生成图例
    function populateLegend(colorMap) {
        const grid = document.getElementById('archetype-legend-grid');
        if (!grid || !colorMap) return;
        grid.innerHTML = '';
        Object.entries(colorMap).forEach(([name, color]) => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `<div class="legend-box" style="background-color:${color};"></div><span>${name}</span>`;
            grid.appendChild(item);
        });
    }

    // 3. 恢复所有原始变量定义 (删除subtype)
    let resultPanel = document.querySelector(".result-panel");
    let carbonLink = document.getElementById("carbon-link");
    let energyLink = document.getElementById("energy-link");
    let typeLink = document.getElementById("type-link");
    let archetypeSelect = document.getElementById("archetype");
    let clearButton = document.querySelector(".clear-btn");
    let closeButton = document.querySelector('.panel-close-btn');
    let carbonContainer = document.getElementById("carbon-container");
    let energyContainer = document.getElementById("energy-container");
    let archetypeCharts = document.getElementById("archetype-charts");
    let toggleML = document.getElementById('buildingTypeToggle');

    const mllayers = ['buildings-layer', 'buildings-label'];
    const imageCache = {};

    // 4. 动态填充archetype下拉菜单
    if (archetypeSelect && archetypeList.length > 0) {
        archetypeList.forEach(archetype => {
            const option = document.createElement('option');
            option.value = archetype;
            option.textContent = archetype;
            archetypeSelect.appendChild(option);
        });
    }

    // 5. 完整保留原有的图片预加载逻辑
    function preloadImages(archetypeListToCache) {
        archetypeListToCache.forEach(archetype => {
            if (!imageCache[archetype]) {
                const img = new Image();
                img.src = `img/${archetype}.png`; // 假设图片目录结构不变
                imageCache[archetype] = img;
            }
        });
    }
    preloadImages(archetypeList.length > 0 ? archetypeList : Object.keys(userData.operational_energy_data ? userData.operational_energy_data.data : {}));

    // 6. 恢复原本的平滑滚动
    resultPanel.addEventListener('wheel', (e) => {
        e.preventDefault();
        resultPanel.scrollBy({ top: e.deltaY, behavior: 'smooth' });
    });

    // 7. 核心：恢复原有的 ECharts 配置样式（完全对齐你原本的视觉效果）
    function updateEnergyArcheChart(archetype) {
        const chartDom = document.getElementById('energy-eui');
        const data = userData.operational_energy_data && userData.operational_energy_data.data ? userData.operational_energy_data.data[archetype] : undefined;
        if (!chartDom || !data) return;

        const euiBar = echarts.init(chartDom, null, { renderer: 'svg' });
        const option = {
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            grid: { top: '10px', bottom: '30px', left: '50px', right: '40px' },
            xAxis: {
                type: 'category',
                data: ['Total', 'Cooling', 'Lighting', 'Equip', 'Water'],
                axisLabel: { interval: 0, fontSize: 10 }
            },
            yAxis: { type: 'value', name: 'kWh/m²', nameTextStyle: { fontSize: 10 } },
            series: [{
                name: 'EUI',
                type: 'bar',
                barWidth: '60%',
                data: data,
                itemStyle: {
                    color: (params) => ['#34495e', '#A5F3FC', '#FFFF00', '#E0E0E0', '#5a2e14'][params.dataIndex]
                }
            }]
        };
        euiBar.setOption(option);
        window.addEventListener('resize', () => euiBar.resize());
    }

    // 8. Tab 切换 + sunburst 渲染逻辑
    let currentSimulation = 'type';

    function setActiveLink(activeLink) {
        [carbonLink, energyLink, typeLink].forEach(link => {
            if (link) link.classList.remove("active");
        });
        if (activeLink) activeLink.classList.add("active");
    }

    function showContent(key) {
        currentSimulation = key;
        archetypeCharts.style.display = key === 'type' ? 'block' : 'none';
        carbonContainer.style.display = key === 'carbon' ? 'block' : 'none';
        energyContainer.style.display = key === 'energy' ? 'block' : 'none';
        ['type', 'carbon', 'energy'].forEach(k => {
            const el = document.getElementById(`title-${k}`);
            if (el) el.style.display = k === key ? 'block' : 'none';
        });
        if (key === 'type') renderSuncharts();
        if (key === 'energy') updateEnergyArcheChart(archetypeSelect.value);
    }

    function toggleSimulationType(simulationType) {
        const currentLink = document.getElementById(`${simulationType}-link`);
        const isActive = currentLink && currentLink.classList.contains('active');

        if (isActive) {
            resultPanel.classList.remove('show');
            currentLink.classList.remove('active');
        } else {
            resultPanel.classList.add('show');
            setActiveLink(currentLink);
            showContent(simulationType);
        }
    }

    function panelClose() {
        resultPanel.classList.remove('show');
        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
    }

    if (typeLink) typeLink.addEventListener('click', () => {
        if (Object.keys(window.archetypeStats).length > 0) renderSuncharts();
    });
    if (energyLink) energyLink.addEventListener('click', () => {
        updateEnergyArcheChart(archetypeSelect.value);
    });

    function renderSuncharts() {
        const stats = window.archetypeStats;
        if (!stats || Object.keys(stats).length === 0) return;

        const domNumber = document.getElementById('sunchartsnumber');
        const domFootprint = document.getElementById('sunchartsfootprint');

        if (domNumber) {
            const chart = echarts.getInstanceByDom(domNumber) || echarts.init(domNumber, null, { renderer: 'svg' });
            chart.setOption(getDynamicArchetypeSunburstOption(stats));
            chart.resize();
        }
        if (domFootprint) {
            const chart = echarts.getInstanceByDom(domFootprint) || echarts.init(domFootprint, null, { renderer: 'svg' });
            chart.setOption(getDynamicArchetypeFootprintSunburstOption(stats));
            chart.resize();
        }
    }

    // 绑定原有监听器
    if (toggleML) toggleML.addEventListener('change', () => {});
    archetypeSelect.addEventListener('change', (e) => {
        updateEnergyArcheChart(e.target.value);
        // 更新 Embodied Carbon 文字显示
        const carbVal = userData.embodied_carbon_values && userData.embodied_carbon_values.data ? userData.embodied_carbon_values.data[e.target.value] || 0 : 0;
        const carbDisp = document.querySelector(".carbon-intensity-value");
        if (carbDisp) carbDisp.innerText = carbVal.toFixed(2);
    });

    clearButton.addEventListener('click', () => {
        archetypeSelect.value = "";
    });

    closeButton.addEventListener('click', panelClose);

    // 10. 初始化默认显示状态：type tab 为默认激活
    showContent('type');
    // 等archetypeStats加载完后渲染初始sunburst
    if (Object.keys(window.archetypeStats).length > 0) renderSuncharts();

    // 9. 恢复地图点击联动与样式显示 (删除building_subtype)
    map.on('click', 'buildings-layer', (e) => {
        const props = e.features[0].properties;
        resultPanel.classList.add('show');
        showContent(currentSimulation);
        
        // 自动切换下拉框 (只处理archetype)
        if (props.building_archetype) {
            archetypeSelect.value = props.building_archetype;
            updateEnergyArcheChart(props.building_archetype);
        }

        // 更新面板中的图片（原本的样式细节）
        const imgDisplay = document.querySelector(".archetype-image");
        if(imgDisplay && props.building_archetype) {
            imgDisplay.src = `img/${props.building_archetype}.png`;
        }
    });

    console.log("Panel logic updated: Single-layer archetype mode enabled with dynamic GeoJSON loading.");
}