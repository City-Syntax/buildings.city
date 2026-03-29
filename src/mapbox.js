import mapboxgl from 'mapbox-gl';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

// 暴露 turf 到 window 供全局函数使用
window.turf = turf;

export class UBEMViewer {
    constructor(config) {
        this.config = config;
        this.map = null;
        this.draw = null;
        this.activeLayer = 'type';
        this.currentPopup = null;
        this.baseBuildingLayerId = config.layers?.base_building_layer || 'sg-buildings-3d';
        this.carbonLayerId = config.layers?.carbon_layer || 'buildings-embodied-carbon';
        this.energyLayerId = config.layers?.energy_layer || 'buildings-operational-carbon';

        // 映射表 (可保留在代码中，或从 config 读)
        this.subtypesMapping = config.subtype_mapping || {};

        this.layerVisibilityMap = {
            carbon: this.carbonLayerId,
            energy: this.energyLayerId,
            type: this.baseBuildingLayerId
        };

        this.metricRampConfig = {
            carbon: {
                layerId: this.carbonLayerId,
                fields: ['eb_carbon'],
                colors: ['#2bf3a9', '#0fb89f', '#275fa0', '#df80e0', '#f0004c'],
                legendBarSelector: '.legend-container.carbon .legend-bar-carbon',
                legendLabelsId: 'carbon-legend-labels'
            },
            energy: {
                layerId: this.energyLayerId,
                fields: ['op_carbon'],
                colors: ['#0d9c6c', '#57f46c', '#f5ed0f', '#f59a0f', '#f56b0f'],
                legendBarSelector: '.legend-container.energy .legend-bar-energy',
                legendLabelsId: 'energy-legend-labels'
            }
        };
    }

    async init() {
        mapboxgl.accessToken = this.config.mapbox_token;
        const coords = await this._getCityCoords(this.config.city_name);
        window.__ubemBaseBuildingLayerId = this.baseBuildingLayerId;

        this.map = new mapboxgl.Map({
            container: 'map',
            style: this.config.map_style,
            center: coords,
            zoom: 13.4,
            pitch: 50,
            bearing: 20,
            antialias: true
        });

        // 暴露到 window 供全局函数使用
        window.map = this.map;
        window.draw = null;  // 先初始化

        this._setupControls();
        this._bindEvents();
    }

    async _getCityCoords(city) {
        try {
            const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(city)}.json?access_token=${mapboxgl.accessToken}&limit=1`);
            const data = await res.json();
            return data.features.length ? data.features[0].center : [103.825, 1.282];
        } catch (e) { return [103.825, 1.282]; }
    }

    _setupControls() {
        this.map.doubleClickZoom.disable();
        const geocoder = new MapboxGeocoder({
            accessToken: mapboxgl.accessToken,
            mapboxgl: mapboxgl,
            marker: { color: '#333', scale: 0.8 },
            placeholder: 'Search for buildings...'
        });
        this.map.addControl(geocoder, 'bottom-right');
        this.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
        this.draw = new MapboxDraw({
            displayControlsDefault: false,
            controls: { polygon: true, trash: true }
        });
        this.map.addControl(this.draw, 'top-right');
        // 调整控件位置和圆角样式
        const topRightCtrl = document.querySelector('.mapboxgl-ctrl-top-right');
        if (topRightCtrl) { topRightCtrl.style.top = "46px"; }
        const ctrlGroups = document.querySelectorAll('.mapboxgl-ctrl-group');
        ctrlGroups.forEach(group => {
            group.style.borderRadius = "10px";
            group.style.overflow = "hidden";
        });
        const ctrlButtons = document.querySelectorAll('.mapboxgl-ctrl-group > button');
        ctrlButtons.forEach(btn => {
            btn.style.width = "28px";
            btn.style.height = "28px";
        });
        // geocoder控件及其输入框、下拉菜单圆角
        const geocoderCtrl = document.querySelector('.mapboxgl-ctrl-geocoder');
        if (geocoderCtrl) {
            geocoderCtrl.style.borderRadius = "10px";
            geocoderCtrl.style.margin = "8px";
            // 输入框
            const input = geocoderCtrl.querySelector('input');
            if (input) input.style.borderRadius = "10px";
            // 下拉菜单
            const dropdown = geocoderCtrl.querySelector('.suggestions');
            if (dropdown) dropdown.style.borderRadius = "10px";
        }
        // 暴露 draw 实例到 window
        window.draw = this.draw;
    }

    _bindEvents() {
        this.map.on('load', () => {
            this._setupSourcesAndLayers();
            this._setupClickAndHover();
        });
    }

    _setupSourcesAndLayers() {
        // --- 核心修改：改为 GeoJSON 加载 ---
        const { type, data } = this.config.buildings_source;
        const hField = this.config.height_field || 'height';
        const heightExpr = this._getFlexibleHeightExpression(hField);

        this.map.addSource('buildings_all', {
            type: type, // 'geojson'
            data: data, // '/data/sg_buildings_v5.geojson'
            generateId: true
        });

        // 1. Archetype Layer
        this.map.addLayer({
            "id": this.baseBuildingLayerId,
            "type": "fill-extrusion",
            "source": "buildings_all",
            "paint": {
                "fill-extrusion-height": heightExpr,
                "fill-extrusion-color": "#cccccc",
                "fill-extrusion-opacity": 0.8
            }
        });

        // 2. Embodied Carbon Layer (同样的 Source)
        this.map.addLayer({
            "id": this.carbonLayerId,
            "type": "fill-extrusion",
            "source": "buildings_all",
            "layout": { "visibility": "none" },
            "paint": {
                "fill-extrusion-height": heightExpr,
                "fill-extrusion-color": "#333333",
                "fill-extrusion-opacity": 0.8
            }
        });

        // 3. Operational Energy Layer
        this.map.addLayer({
            "id": this.energyLayerId,
            "type": "fill-extrusion",
            "source": "buildings_all",
            "layout": { "visibility": "none" },
            "paint": {
                "fill-extrusion-height": heightExpr,
                "fill-extrusion-color": "#333333",
                "fill-extrusion-opacity": 0.8
            }
        });
    }

    updateBuildingData(geojson) {
        const source = this.map?.getSource('buildings_all');
        if (source) {
            source.setData(geojson);
        }

        if (geojson) {
            this._updateMetricRampsFromGeoJSON(geojson);
        }
    }

    _getFlexibleHeightExpression(hField) {
        return [
            "max",
            3.2,
            [
                "coalesce",
                ["to-number", ["get", hField]],
                ["*", ["coalesce", ["to-number", ["get", "building_levels"]], ["to-number", ["get", "building:levels"]], 0], 3.2],
                0
            ]
        ];
    }

    _updateMetricRampsFromGeoJSON(geojson) {
        Object.values(this.metricRampConfig).forEach(metricConfig => {
            this._applyMetricRamp(metricConfig, geojson);
        });
    }

    _applyMetricRamp(metricConfig, geojson) {
        const values = this._collectMetricValues(geojson, metricConfig.fields);
        const { rawStops, renderStops } = this._computeQuantileStops(values, metricConfig.colors.length);
        const valueExpr = ["to-number", ...metricConfig.fields.map(field => ["get", field]), -1];
        const colorExpr = [
            "case",
            [">=", valueExpr, 10],
            ["interpolate", ["linear"], valueExpr, ...this._flattenStops(renderStops, metricConfig.colors)],
            "#333333"
        ];
        const opacityExpr = ["case", [">=", valueExpr, 10], 0.8, 0.35];

        this.map.setPaintProperty(metricConfig.layerId, "fill-extrusion-color", colorExpr);
        this.map.setPaintProperty(metricConfig.layerId, "fill-extrusion-opacity", opacityExpr);
        this._updateMetricLegend(metricConfig, rawStops);
    }

    _collectMetricValues(geojson, fields) {
        const features = geojson?.features || [];
        return features
            .map(feature => {
                const properties = feature?.properties || {};
                for (const field of fields) {
                    const value = Number(properties[field]);
                    if (Number.isFinite(value) && value >= 10) {
                        return value;
                    }
                }
                return null;
            })
            .filter(value => value !== null)
            .sort((a, b) => a - b);
    }

    _computeQuantileStops(values, stopCount) {
        if (!values.length) {
            const defaults = Array.from({ length: stopCount }, (_, index) => index);
            return { rawStops: defaults, renderStops: defaults };
        }

        const rawStops = Array.from({ length: stopCount }, (_, index) => {
            const position = stopCount === 1 ? 0 : index / (stopCount - 1);
            return this._getQuantileValue(values, position);
        });

        const span = Math.max(rawStops[rawStops.length - 1] - rawStops[0], 1);
        const epsilon = span / 1000;
        const renderStops = [];
        rawStops.forEach((stop, index) => {
            if (index === 0) {
                renderStops.push(stop);
                return;
            }

            renderStops.push(Math.max(stop, renderStops[index - 1] + epsilon));
        });

        return { rawStops, renderStops };
    }

    _getQuantileValue(sortedValues, quantile) {
        if (sortedValues.length === 1) return sortedValues[0];
        const index = (sortedValues.length - 1) * quantile;
        const lowerIndex = Math.floor(index);
        const upperIndex = Math.ceil(index);
        if (lowerIndex === upperIndex) {
            return sortedValues[lowerIndex];
        }

        const weight = index - lowerIndex;
        return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
    }

    _flattenStops(stops, colors) {
        return stops.flatMap((stop, index) => [stop, colors[index]]);
    }

    _updateMetricLegend(metricConfig, stops) {
        const legendBar = document.querySelector(metricConfig.legendBarSelector);
        if (legendBar) {
            const gradientStops = metricConfig.colors.map((color, index) => {
                const percent = metricConfig.colors.length === 1 ? 0 : (index / (metricConfig.colors.length - 1)) * 100;
                return `${color} ${percent}%`;
            }).join(', ');
            legendBar.style.background = `linear-gradient(to right, ${gradientStops})`;
        }

        const labelsContainer = document.getElementById(metricConfig.legendLabelsId);
        if (labelsContainer) {
            labelsContainer.innerHTML = stops
                .map((value, index) => `<span>${this._formatLegendValue(value, index)}</span>`)
                .join('');
        }
    }

    _formatLegendValue(value, index = 0) {
        if (!Number.isFinite(value)) return '-';

        const steps = [10, 100, 1000, 10000, 100000];
        const step = steps[Math.min(index, steps.length - 1)];
        const rounded = Math.round(value / step) * step;
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(rounded);
    }

    /**
     * 用动态颜色映射更新Archetype图层的颜色
     * @param {Object} rawColorMap - { raw_archetype_key: '#hexcolor', ... }
     */
    updateArchetypeColors(rawColorMap) {
        if (!rawColorMap || !this.map) return;
        // 构建 Mapbox match 表达式: ["match", ["get", key], v1, c1, v2, c2, ..., default]
        const matchExpr = ["match", ["get", "building_archetype"]];
        Object.entries(rawColorMap).forEach(([rawKey, color]) => {
            matchExpr.push(rawKey, color);
        });
        matchExpr.push("#cccccc"); // fallback
        this.map.setPaintProperty(this.baseBuildingLayerId, "fill-extrusion-color", matchExpr);
    }

    // 提供给 main.js 调用的过滤接口
    _applySubtypeFilter(subtypeValue) {
        const layerId = this.layerVisibilityMap[this.activeLayer];
        if (!subtypeValue) {
            this.map.setFilter(layerId, null);
            return;
        }
        const archetypes = this.subtypesMapping[subtypeValue] || [];
        this.map.setFilter(layerId, ["in", ["get", "building_archetype"], ["literal", archetypes]]);
    }

    filterByArchetype(formattedValue) {
        const allLayerIds = Object.values(this.layerVisibilityMap);

        if (!formattedValue) {
            allLayerIds.forEach(layerId => this.map.setFilter(layerId, null));
            return;
        }

        // rawColorMap 的 key 是原始值，通过它找到对应的原始 building_archetype
        const rawColorMap = window.archetypeRawColorMap || {};
        const rawValue = Object.keys(rawColorMap).find(raw => {
            // formatArchetypeName 的规则：下划线换空格，首词首字母大写
            const words = raw.split('_');
            const formatted = words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(' ');
            return formatted === formattedValue;
        }) || formattedValue;

        allLayerIds.forEach(layerId => {
            this.map.setFilter(layerId, ["==", ["get", "building_archetype"], rawValue]);
        });
    }

    _toggleLayer(newLayer) {
        Object.entries(this.layerVisibilityMap).forEach(([key, id]) => {
            this.map.setLayoutProperty(id, 'visibility', (key === newLayer) ? 'visible' : 'none');
        });
        this.activeLayer = newLayer;
    }

    _setupClickAndHover() {
        const layers = Object.values(this.layerVisibilityMap);
        const map = this.map;
        // 悬浮变手型
        map.on('mousemove', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers });
            map.getCanvas().style.cursor = features.length ? 'pointer' : '';
        });

        // 绑定点击事件（只绑定一次）
        map.on('click', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers });
            if (!this.currentPopup) this.currentPopup = null;
            if (features.length === 0) {
                if (this.currentPopup) {
                    this.currentPopup.remove();
                    this.currentPopup = null;
                }
                return;
            }
            const feature = features[0];
            const featureId = feature.id;
            const properties = feature.properties;
            // 清除之前的点击状态
            if (map.clickedFeatureId !== undefined) {
                map.setFeatureState(
                    { source: 'buildings_all', id: map.clickedFeatureId },
                    { clicked: false }
                );
            }
            // 设置当前建筑为点击状态
            map.setFeatureState(
                { source: 'buildings_all', id: featureId },
                { clicked: true }
            );
            map.clickedFeatureId = featureId;
            // 过滤有效信息
            let validEntries;
            if (this.config.city_name === 'Singapore') {
                // Singapore 专用版本：固定字段映射
                validEntries = Object.entries({
                    "Building Name": properties['addr_housename'],
                    "Postal Code": properties['addr_postcode'],
                    "Building Address": [properties['addr_housenumber'], properties['addr_street']].filter(v => v && v !== "None" && v !== "0").join(" "),
                    "Building Archetype": properties['building_archetype'],
                    "ML Archetype Probability": properties['ml_probability'] ? `${(properties['ml_probability'] * 100).toPrecision(2)}%` : null,
                    "Building Levels": properties['building_levels'],
                    "Building Footprint": properties['building_footprint'] ? `${properties['building_footprint']} m²` : null,
                    "Gross Floor Area": properties['gross_floor_area'] ? `${properties['gross_floor_area']} m²` : null,
                    "EUI (BCA)": properties['eui2023'] ? `${properties['eui2023']} kWh/m²` : null,
                    "Embodied Carbon": (properties['eb_carbon'] ?? properties['embodied_carbon']) ? `${((properties['eb_carbon'] ?? properties['embodied_carbon']) / 100).toPrecision(5)}*10² kgCO2e` : null,
                    "Operational Carbon": (properties['op_carbon'] ?? properties['energy_total']) ? `${((properties['op_carbon'] ?? properties['energy_total']) / 10000).toPrecision(5)}*10⁴ kgCO2e` : null,
                    "Greenmark Rating": properties['greenmark_rating'],
                    "Greenmark Year of Award": properties['greenmark_year'],
                    "Greenmark Version": properties['greenmark_version']
                }).filter(([key, value]) => value && value !== "None" && value !== "0");
            } else {
                // 通用版本：动态读取所有属性，格式化 key，数字保留两位小数
                const formatKey = k => k.replace(/[:_]+/g, ' ').split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
                const capitalizeFirst = (text) => {
                    if (typeof text !== 'string') return text;
                    const trimmed = text.trim();
                    if (!trimmed) return trimmed;
                    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
                };
                const formatValue = v => {
                    if (v === null || v === undefined || v === "None" || v === "0") return null;
                    if (typeof v === 'number') return Number.isInteger(v) ? v : v.toFixed(2);
                    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
                        const num = Number(v);
                        return Number.isInteger(num) ? num : num.toFixed(2);
                    }
                    return capitalizeFirst(v);
                };
                validEntries = Object.entries(properties)
                    .map(([k, v]) => {
                        if (k === 'eb_carbon' || k === 'op_carbon') {
                            const num = Number(v);
                            const value = Number.isFinite(num) ? `${num.toExponential(2)} kgCO2e` : null;
                            return [formatKey(k), value];
                        }

                        if (k === 'height' || k === 'building:height') {
                            const num = Number(v);
                            const value = Number.isFinite(num)
                                ? `${Number.isInteger(num) ? num : num.toFixed(2)} m`
                                : formatValue(v);
                            return [formatKey(k), value];
                        }

                        if (k === 'building_footprint' || k === 'building:footprint') {
                            const num = Number(v);
                            const value = Number.isFinite(num)
                                ? `${Math.round(num)} m²`
                                : formatValue(v);
                            return [formatKey(k), value];
                        }

                        return [formatKey(k), formatValue(v)];
                    })
                    .filter(([key, value]) => value !== null && value !== undefined && value !== '' && value !== "None" && value !== "0");
            }
            if (validEntries.length > 0) {
                const popupHTML = `
                    <h3>Building Information</h3>
                    <p>${validEntries.map(([key, value]) => `${key}: ${value}`).join("<br>")}</p>
                `;
                if (this.currentPopup) this.currentPopup.remove();
                this.currentPopup = new mapboxgl.Popup({ className: 'custom-popup' })
                    .setLngLat(e.lngLat)
                    .setHTML(popupHTML)
                    .addTo(map);
                
                // 移除 popup tip
                setTimeout(() => {
                    const tipElement = map.getCanvas().parentElement.querySelector('.mapboxgl-popup-tip');
                    if (tipElement) tipElement.remove();
                }, 10);
            }
        });

        // 绘制相关事件
        map.on('draw.create', UserDraw);
        map.on('draw.delete', UserDraw);
        map.on('draw.update', UserDraw);
        // 监听绘制事件，显示 .calculation-box
        map.on('draw.create', function (e) {
            console.log('Polygon created', e);
            map.draw.changeMode('simple_select');
            const calculationBox = document.querySelector('.calculation-box');
            if (calculationBox) calculationBox.style.display = 'block';
        });
        map.on('dblclick', function () {
            if (window.draw) window.draw.changeMode('simple_select');
            console.log('Draw is done');
            const calculationBox = document.querySelector('.calculation-box');
            if (calculationBox) calculationBox.style.display = 'block';
        });
    }
}

// --- Draw统一处理及分析函数 ---
function UserDraw(e) {
    if (!e.features || e.features.length === 0) return;  // 空值检查
    const areaResult = updateArea(e);
    const analysisResult = analyzePolygon(e);
    displayResults(areaResult, analysisResult);
}

// 计算多边形面积
function updateArea(e) {
    const data = window.draw ? window.draw.getAll() : { features: [] };
    let result = '';
    if (data.features.length > 0) {
        const area = window.turf.area(data.features[0]);
        const rounded_area = Math.round(area * 100) / 100;
        result = `<p>Total Area: ${rounded_area} m²</p>`;
    } else {
        result = '';
        if (e.type !== 'draw.delete') {
            alert('Draw a polygon to explore building properties within the area.');
        }
    }
    return result;
}

// 分析多边形内数据
function analyzePolygon(e) {
    const polygon = e.features[0].geometry;
    const pointsSources = [window.__ubemBaseBuildingLayerId || 'sg-buildings-3d'];
    let count = 0;
    let totalEnergy = 0;
    let totalEmbodiedCarbon = 0;
    let totalGrossFloorArea = 0;
    let buildingTypes = {};
    pointsSources.forEach(function (pointsSource) {
        const features = window.map.queryRenderedFeatures({ layers: [pointsSource] });
        features.forEach(function (feature) {
            const centroid = window.turf.centroid(feature).geometry;
            const isInside = window.turf.booleanPointInPolygon(centroid, polygon);
            if (isInside) {
                count++;
                totalEnergy += feature.properties.op_carbon || feature.properties.energy_total || 0;
                totalEmbodiedCarbon += feature.properties.eb_carbon || feature.properties.embodied_carbon || 0;
                totalGrossFloorArea += feature.properties['gross_floor_area'] || 0;
                const buildingType = feature.properties['building_archetype'];
                if (buildingTypes[buildingType]) {
                    buildingTypes[buildingType]++;
                } else {
                    buildingTypes[buildingType] = 1;
                }
            }
        });
    });
    let buildingTypeInfo = '';
    for (const type in buildingTypes) {
        buildingTypeInfo += `<p>${type} Buildings: ${buildingTypes[type]}</p>`;
    }
    return `
        <p>Building Numbers: ${count}</p>
        <p>Total Embodied Carbon: ${totalEmbodiedCarbon.toFixed(2)}</p>
        <p>Total Operational Carbon: ${totalEnergy.toFixed(2)}</p>
        <p>Total Gross Floor Area: ${totalGrossFloorArea.toFixed(2)} m²</p>
        ${buildingTypeInfo} <br>
    `;
}

// 显示结果
function displayResults(areaResult, analysisResult) {
    const answer = document.getElementById('calculated-area');
    if (answer) {
        answer.innerHTML = `${areaResult}${analysisResult}`;
    } else {
        console.error('Element with id "calculated-area" not found.');
    }
}

// 关闭按钮事件，确保DOM已加载
window.addEventListener('DOMContentLoaded', function () {
    const calculationBox = document.querySelector('.calculation-box');
    const closeButton = document.querySelector('.closex');
    if (closeButton && calculationBox) {
        closeButton.addEventListener('click', function () {
            calculationBox.style.display = 'none';
        });
    }
});