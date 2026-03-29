import * as turf from '@turf/turf';

/**
 * 25个和谐色盘 — 按archetype出现顺序依次分配，全项目统一使用
 * 色系：柔和饱和，深色背景/浅色背景均可读
 */
export const ARCHETYPE_COLOR_PALETTE = [
    '#FF6B6B', '#FFA552', '#FFD166', '#C8E06B', '#6BCB77',
    '#4DD9AC', '#45C4D4', '#4A9FE0', '#6B78E5', '#A06BE5',
    '#D46BD4', '#E56B9A', '#FF8FAB', '#FFAB76', '#FFF176',
    '#AEE571', '#57D9A3', '#48CAE4', '#5B9BD5', '#8B78E6',
    '#C774C8', '#F06292', '#FFB347', '#B5EAD7', '#85C1E9'
];

/**
 * 格式化archetype名称
 * 将 hdb_ppvc 转换为 Hdb ppvc
 * 首字母大写，下划线替换为空格，其余字母小写
 */
export function formatArchetypeName(name) {
    if (!name) return name;
    // 替换下划线为空格，然后按空格分割
    const words = name.split('_');
    // 第一个单词首字母大写，其余单词全部小写
    return words
        .map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase())
        .join(' ');
}

/**
 * 从GeoJSON提取building_archetype数据并统计
 * @param {String} geojsonPath - GeoJSON文件路径
 * @returns {Promise<Object>} 包含formatted archetype列表和统计数据的对象
 */
export async function processArchetypeData(geojsonPath) {
    try {
        const res = await fetch(geojsonPath);
        if (!res.ok) throw new Error(`Failed to load GeoJSON: ${res.statusText}`);
        const geojson = await res.json();

        return processArchetypeGeoJSON(geojson);
    } catch (e) {
        console.error('Error processing archetype data:', e);
        return { archetypes: [], stats: {}, colorMap: {} };
    }
}

export function processArchetypeGeoJSON(geojson) {
    try {
        const archetypeStats = {};
        const archetypeList = [];
        const rawToFormatted = {}; // 原始key → 格式化名称

        geojson.features.forEach(feature => {
            const archetype = feature.properties?.building_archetype;
            if (!archetype) return;

            const formattedName = formatArchetypeName(archetype);
            rawToFormatted[archetype] = formattedName;

            if (!archetypeStats[formattedName]) {
                archetypeStats[formattedName] = { count: 0, footprintArea: 0 };
                archetypeList.push(formattedName);
            }

            archetypeStats[formattedName].count++;

            try {
                if (feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
                    archetypeStats[formattedName].footprintArea += turf.area(feature);
                }
            } catch (e) {
                console.warn(`Failed to calculate area for feature:`, e);
            }
        });

        // 按字母排序后按顺序分配颜色
        archetypeList.sort();
        const colorMap = {};
        archetypeList.forEach((name, i) => {
            colorMap[name] = ARCHETYPE_COLOR_PALETTE[i % ARCHETYPE_COLOR_PALETTE.length];
        });

        // 原始key → 颜色 (供Mapbox match表达式使用)
        const rawColorMap = {};
        Object.entries(rawToFormatted).forEach(([raw, formatted]) => {
            rawColorMap[raw] = colorMap[formatted];
        });

        console.log('Archetype color map:', colorMap);

        return {
            archetypes: archetypeList,
            stats: archetypeStats,
            colorMap,
            rawColorMap,
            geojson
        };
    } catch (e) {
        console.error('Error processing archetype data:', e);
        return { archetypes: [], stats: {}, colorMap: {} };
    }
}

/**
 * 转换统计数据为sunburst图表数据结构
 * @param {Object} stats - 统计数据对象 { archetype: { count, footprintArea } }
 * @param {String} metric - 'count' 或 'footprintArea'
 * @returns {Array} sunburst数据结构
 */
export function convertToSunburstData(stats, metric = 'count') {
    return Object.entries(stats).map(([name, data]) => ({
        name: name,
        value: metric === 'count' ? data.count : Math.round(data.footprintArea)
    }));
}
