function getResponseSnippet(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function parseJsonResponse(response, errorContext) {
    const text = await response.text();

    if (!response.ok) {
        let detail = '';
        try {
            detail = JSON.parse(text)?.detail || '';
        } catch {
            detail = getResponseSnippet(text);
        }

        throw new Error(`${errorContext} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${errorContext} returned invalid JSON: ${getResponseSnippet(text)}`);
    }
}

export async function syncGeoJSONDataset({ geojson, dataPath }) {
    const response = await fetch('/api/sync-geojson-dataset', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({ geojson, dataPath })
    });

    return parseJsonResponse(response, 'GeoJSON dataset sync');
}

export async function reloadSimulationBuildingLibrary(serviceUrl) {
    if (!serviceUrl) {
        return null;
    }

    try {
        const baseUrl = serviceUrl.replace(/\/$/, '');
        const openApiResponse = await fetch(`${baseUrl}/openapi.json`, {
            headers: { Accept: 'application/json' }
        });

        if (!openApiResponse.ok) {
            return null;
        }

        const openApi = await openApiResponse.json();
        if (!openApi?.paths?.['/building-library/reload']) {
            console.warn('Simulation backend does not expose /building-library/reload yet. Restart the simulation service to enable cache reloads after GeoJSON sync.');
            return { status: 'skipped', reason: 'reload_endpoint_missing' };
        }

        const response = await fetch(`${baseUrl}/building-library/reload`, {
            method: 'POST',
            headers: { Accept: 'application/json' }
        });

        return parseJsonResponse(response, 'Simulation building library reload');
    } catch (error) {
        console.warn('Unable to notify simulation backend to reload the GeoJSON library.', error);
        return null;
    }
}
