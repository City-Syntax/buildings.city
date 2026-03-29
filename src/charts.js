import * as echarts from 'echarts';
import { formatArchetypeName } from './data-processor';

const MUTED_BAR_COLOR = '#d9d9d9';
const ENERGY_BAR_MAX_WIDTH = 14;
const DEFAULT_ENERGY_COLUMNS = ['total', 'heating', 'cooling', 'lighting', 'equipment', 'hot_water'];
const ENERGY_SERIES_STYLE_MAP = {
    heating: { name: 'Heating', color: '#ef441e' },
    cooling: { name: 'Cooling', color: '#A5F3FC' },
    lighting: { name: 'Lighting', color: '#FFFF00' },
    equipment: { name: 'Equipment', color: '#E0E0E0' },
    hot_water: { name: 'Hot Water', color: '#5a2e14' }
};

function formatEnergyColumnLabel(column) {
    const preset = ENERGY_SERIES_STYLE_MAP[column]?.name;
    if (preset) return preset;

    return column
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function getEnergySeriesMeta(columns) {
    return columns
        .filter(column => column !== 'total')
        .map((column, index) => {
            const preset = ENERGY_SERIES_STYLE_MAP[column] || {};
            return {
                column,
                index,
                valueIndex: index + 1,
                name: formatEnergyColumnLabel(column),
                color: preset.color || '#bdbdbd'
            };
        });
}


/**
 * 1. 动态Archetype Sunburst图表 (按建筑数量)
 */
export function getDynamicArchetypeSunburstOption(stats) {
    const colorMap = window.archetypeColorMap || {};
    const total = Object.values(stats).reduce((sum, s) => sum + s.count, 0);

    let othersValue = 0;
    const data = [];
    Object.entries(stats).forEach(([name, stat]) => {
        if ((stat.count / total) * 100 < 3) {
            othersValue += stat.count;
        } else {
            data.push({ name, value: stat.count, itemStyle: { color: colorMap[name] || '#cccccc' } });
        }
    });
    data.sort((a, b) => b.value - a.value);
    if (othersValue > 0) {
        data.push({ name: 'Others', value: othersValue, itemStyle: { color: '#cccccc' } });
    }

    return {
        tooltip: {
            show: true,
            trigger: 'item',
            textStyle: { fontSize: 12, color: '#333' },
            borderRadius: 10,
            formatter: function (params) {
                const percentage = ((params.data.value / total) * 100).toFixed(2);
                return `${params.name}: ${params.data.value} (${percentage}%)`;
            }
        },
        series: {
            type: 'sunburst',
            sort: null,
            radius: ['20%', '90%'],
            data: data,
            label: { rotate: 'radial', color: '#fff', fontSize: 10 },
            itemStyle: { borderRadius: 10, borderWidth: 2, borderColor: '#fff' }
        }
    };
}

/**
 * 2. 动态Archetype Sunburst图表 (按占地面积)
 */
export function getDynamicArchetypeFootprintSunburstOption(stats) {
    const colorMap = window.archetypeColorMap || {};
    const total = Object.values(stats).reduce((sum, s) => sum + s.footprintArea, 0);

    let othersValue = 0;
    const data = [];
    Object.entries(stats).forEach(([name, stat]) => {
        const rounded = Math.round(stat.footprintArea);
        if ((stat.footprintArea / total) * 100 < 3) {
            othersValue += rounded;
        } else {
            data.push({ name, value: rounded, itemStyle: { color: colorMap[name] || '#cccccc' } });
        }
    });
    data.sort((a, b) => b.value - a.value);
    if (othersValue > 0) {
        data.push({ name: 'Others', value: othersValue, itemStyle: { color: '#cccccc' } });
    }

    return {
        tooltip: {
            show: true,
            trigger: 'item',
            textStyle: { fontSize: 12, color: '#333' },
            borderRadius: 10,
            formatter: function (params) {
                const percentage = ((params.data.value / Math.round(total)) * 100).toFixed(2);
                return `${params.name}: ${(params.data.value / 1e6).toFixed(2)} km² (${percentage}%)`;
            }
        },
        series: {
            type: 'sunburst',
            sort: null,
            radius: ['20%', '90%'],
            data: data,
            label: { rotate: 'radial', color: '#fff', fontSize: 10 },
            itemStyle: { borderRadius: 10, borderWidth: 2, borderColor: '#fff' }
        }
    };
}

/**
 * 3. 初始化 Embodied Carbon 水平条形图 (从 config.json 读取)
 */
export function initCarbonBarChart(config) {
    const dom = document.getElementById('carbonChartContainer');
    if (!dom) return;

    const rawData = config.embodied_carbon_values?.data || {};
    const keys = Object.keys(rawData);
    const labels = keys.map(formatArchetypeName);
    const values = keys.map(k => rawData[k]);

    // 反转使最上方显示第一条
    const labelsRev = [...labels].reverse();
    const valuesRev = [...values].reverse();
    const keysRev   = [...keys].reverse();

    const option = {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, textStyle: { fontSize: 12, color: '#333' }, borderRadius: 10 },
        grid: { left: '130px', right: '15px', top: '10px', bottom: '20px' },
        xAxis: { type: 'value', name: 'kgCO₂e/m²', nameTextStyle: { fontSize: 10, color: '#333' }, axisLabel: { fontSize: 10, color: '#333' } },
        yAxis: { type: 'category', data: labelsRev, axisLabel: { fontSize: 10, color: '#333' } },
        series: [{
            type: 'bar',
            barMaxWidth: 14,
            data: valuesRev.map((v, i) => ({
                value: v,
                itemStyle: { color: (window.archetypeColorMap || {})[formatArchetypeName(keysRev[i])] || '#cccccc', borderRadius: [0, 10, 10, 0] }
            })),
            label: { show: true, position: 'right', formatter: '{c}', fontSize: 10, color: '#333' }
        }]
    };

    const chart = echarts.getInstanceByDom(dom) || echarts.init(dom, null, { renderer: 'canvas' });
    chart.setOption(option);
    chart.__ubemCarbon = { keysRev, valuesRev };
    window.addEventListener('resize', () => chart.resize());

    const downloadBtn = document.getElementById('downloadCarbonBar');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', function () {
            chart.resize();
            const link = document.createElement('a');
            link.href = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
            link.download = 'embodied_carbon_intensity_all.png';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }
}

/**
 * 4. 初始化 Energy Use Intensity 水平堆叠条形图 (从 config.json 读取)
 */
export function initEnergyBarChart(config) {
    const dom = document.getElementById('energyChartContainer');
    if (!dom) return;

    const rawData = config.operational_energy_data?.data || {};
    const columns = config.operational_energy_data?.columns?.length ? config.operational_energy_data.columns : DEFAULT_ENERGY_COLUMNS;
    const keys = Object.keys(rawData);
    const labels = keys.map(formatArchetypeName).reverse();
    const valuesRev = keys.map(k => rawData[k]).reverse();
    const seriesMeta = getEnergySeriesMeta(columns);

    const seriesData = seriesMeta.map(({ name, color, valueIndex }) => ({
        name,
        type: 'bar',
        stack: 'total',
        barMaxWidth: ENERGY_BAR_MAX_WIDTH,
        itemStyle: { color },
        data: valuesRev.map(row => row[valueIndex] ?? 0)
    }));

    const option = {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, textStyle: { fontSize: 12, color: '#333' }, borderRadius: 10 },
        legend: {
            top: 0,
            icon: 'circle',
            itemWidth: 12,
            itemHeight: 12,
            itemGap: 10,
            textStyle: { fontSize: 10 }
        },
        grid: { left: '130px', right: '15px', top: '30px', bottom: '20px' },
        xAxis: { type: 'value', name: 'kWh/m²', nameTextStyle: { fontSize: 10, color: '#333' }, axisLabel: { fontSize: 10, color: '#333' } },
        yAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, color: '#333' } },
        series: seriesData
    };

    const chart = echarts.getInstanceByDom(dom) || echarts.init(dom, null, { renderer: 'canvas' });
    chart.setOption(option);
    chart.__ubemEnergy = { labels, valuesRev, seriesMeta };
    window.addEventListener('resize', () => chart.resize());

    const downloadBtn = document.getElementById('downloadEnergyBar');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', function () {
            chart.resize();
            const link = document.createElement('a');
            link.href = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
            link.download = 'operational_energy_intensity_all.png';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }
}

/**
 * 初始化Sunburst图表的切换和下载功能
 */
export function initSunburstUI() {
    let isNumber = true;

    // Toggle切换函数
    window.toggleSwitch = function() {
        isNumber = !isNumber;
        const slider = document.querySelector('.toggle-slider');
        const numberLabel = document.getElementById('numberLabel');
        const footprintLabel = document.getElementById('footprintLabel');
        const sunChartNumber = document.getElementById('sunchartsnumber');
        const sunChartFootprint = document.getElementById('sunchartsfootprint');

        if (slider) slider.style.transform = isNumber ? 'translateX(0)' : 'translateX(calc(100% - 6.5px))';
        if (numberLabel) numberLabel.classList.toggle('active', isNumber);
        if (footprintLabel) footprintLabel.classList.toggle('active', !isNumber);
        if (sunChartNumber) sunChartNumber.style.display = isNumber ? 'block' : 'none';
        if (sunChartFootprint) sunChartFootprint.style.display = isNumber ? 'none' : 'block';
    };

    // Download按钮事件 — 只下载当前可见的那张图
    const downloadBtn = document.getElementById("downloadSunChart");
    if (downloadBtn) {
        downloadBtn.addEventListener("click", function () {
            this.classList.add("active");
            const dom1 = document.getElementById("sunchartsnumber");
            const dom2 = document.getElementById("sunchartsfootprint");
            const isChart1Visible = dom1 && dom1.style.display !== 'none';
            const targetDom = isChart1Visible ? dom1 : dom2;
            const fileName = isChart1Visible ? 'archetype_by_number.png' : 'archetype_by_footprint.png';

            const chart = echarts.getInstanceByDom(targetDom);
            if (chart) {
                chart.resize();
                const link = document.createElement('a');
                link.href = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }

            setTimeout(() => this.classList.remove("active"), 500);
        });
    }
}

/**
 * 根据下拉框选中的 archetype 高亮柱状图：未选中时恢复原颜色
 */
export function updateArchetypeBarHighlight(selectedArchetype) {
    const selected = selectedArchetype || '';

    // Embodied Carbon Bar
    const carbonDom = document.getElementById('carbonChartContainer');
    const carbonChart = carbonDom ? echarts.getInstanceByDom(carbonDom) : null;
    if (carbonChart && carbonChart.__ubemCarbon) {
        const { keysRev, valuesRev } = carbonChart.__ubemCarbon;
        const data = valuesRev.map((v, i) => {
            const archetypeName = formatArchetypeName(keysRev[i]);
            const originalColor = (window.archetypeColorMap || {})[archetypeName] || '#cccccc';
            const keepColor = !selected || archetypeName === selected;
            return {
                value: v,
                itemStyle: {
                    color: keepColor ? originalColor : MUTED_BAR_COLOR,
                    borderRadius: [0, 10, 10, 0]
                }
            };
        });
        carbonChart.setOption({ series: [{ data }] });
    }

    // Operational Carbon (stacked) Bar
    const energyDom = document.getElementById('energyChartContainer');
    const energyChart = energyDom ? echarts.getInstanceByDom(energyDom) : null;
    if (energyChart && energyChart.__ubemEnergy) {
        const { labels, valuesRev, seriesMeta } = energyChart.__ubemEnergy;

        const updatedSeries = seriesMeta.map(({ valueIndex, color }) => ({
            data: valuesRev.map((row, rowIdx) => {
                const keepColor = !selected || labels[rowIdx] === selected;
                return {
                    value: row[valueIndex] ?? 0,
                    itemStyle: {
                        color: keepColor ? color : MUTED_BAR_COLOR
                    }
                };
            })
        }));

        energyChart.setOption({ series: updatedSeries });
    }
}


