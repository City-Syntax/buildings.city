import { promises as fs } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const userDataDir = resolve(rootDir, 'user-data');
const userBuildingsDir = resolve(userDataDir, 'buildings');
const distUserBuildingsDir = resolve(rootDir, 'dist', 'user-data', 'buildings');
const contentTypes = {
    '.geojson': 'application/geo+json',
    '.json': 'application/json'
};

async function readRequestJson(req) {
    const chunks = [];

    for await (const chunk of req) {
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function resolveConfiguredGeoJSONPath(requestedPath = '') {
    const configPath = resolve(userDataDir, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const configuredPath = String(config?.buildings_source?.data || '').trim();
    const dataPath = String(requestedPath || configuredPath).trim();

    if (!dataPath || dataPath !== configuredPath) {
        throw new Error('Request must target the active config.buildings_source.data GeoJSON.');
    }

    return isAbsolute(dataPath) && !dataPath.startsWith('/') && !dataPath.startsWith('\\')
        ? resolve(dataPath)
        : resolve(rootDir, dataPath.replace(/^[/\\]+/, ''));
}

function isInside(parent, child) {
    const normalizedParent = resolve(parent);
    const normalizedChild = resolve(child);
    return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + sep);
}

async function copyDirectory(source, target) {
    const entries = await fs.readdir(source, { withFileTypes: true });
    await fs.mkdir(target, { recursive: true });

    await Promise.all(entries.map(async entry => {
        const sourcePath = resolve(source, entry.name);
        const targetPath = resolve(target, entry.name);

        if (entry.isDirectory()) {
            await copyDirectory(sourcePath, targetPath);
        } else if (entry.isFile()) {
            await fs.mkdir(dirname(targetPath), { recursive: true });
            await fs.copyFile(sourcePath, targetPath);
        }
    }));
}

function localGeoJSONSyncPlugin() {
    return {
        name: 'buildings-city-local-geojson-sync',
        configureServer(server) {
            server.middlewares.use('/api/sync-geojson-dataset', async (req, res) => {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ detail: 'Method not allowed' }));
                    return;
                }

                try {
                    const payload = await readRequestJson(req);
                    const geojson = payload?.geojson;

                    if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
                        throw new Error('Payload geojson must be a FeatureCollection.');
                    }

                    const outputPath = await resolveConfiguredGeoJSONPath(payload?.dataPath);
                    await fs.writeFile(outputPath, `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');

                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        ok: true,
                        path: outputPath,
                        feature_count: geojson.features.length
                    }));
                } catch (error) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ detail: error?.message || 'Unable to sync GeoJSON dataset.' }));
                }
            });
        }
    };
}

function userDataStaticPlugin() {
    return {
        name: 'buildings-city-user-data-static',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                try {
                    const requestUrl = new URL(req.url || '/', 'http://localhost');
                    const prefix = '/user-data/buildings/';

                    if (!requestUrl.pathname.startsWith(prefix)) {
                        next();
                        return;
                    }

                    const relativePath = decodeURIComponent(requestUrl.pathname.slice(prefix.length));
                    const filePath = resolve(userBuildingsDir, relativePath);

                    if (!isInside(userBuildingsDir, filePath)) {
                        res.statusCode = 403;
                        res.end('Forbidden');
                        return;
                    }

                    const stat = await fs.stat(filePath);
                    if (!stat.isFile()) {
                        next();
                        return;
                    }

                    res.statusCode = 200;
                    res.setHeader('Content-Type', contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream');
                    res.setHeader('Content-Length', String(stat.size));
                    if (req.method === 'HEAD') {
                        res.end();
                        return;
                    }
                    res.end(await fs.readFile(filePath));
                } catch (error) {
                    if (error?.code === 'ENOENT') {
                        next();
                    } else {
                        res.statusCode = 500;
                        res.end(error?.message || 'Unable to read user data file.');
                    }
                }
            });
        },
        async closeBundle() {
            try {
                await copyDirectory(userBuildingsDir, distUserBuildingsDir);
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    throw error;
                }
            }
        }
    };
}

export default defineConfig({
    plugins: [localGeoJSONSyncPlugin(), userDataStaticPlugin()],
    build: {
        rollupOptions: {
            input: {
                main: resolve(rootDir, 'index.html'),
                energySimulation: resolve(rootDir, 'energy-simulation.html'),
                archetypePrediction: resolve(rootDir, 'archetype-prediction.html')
            }
        }
    }
});
