function getResponseTextSnippet(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
}

function looksLikeHtml(text) {
    const trimmed = String(text || '').trim().toLowerCase();
    return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<body');
}

async function parseJsonResponse(response, errorContext, { expectGeoJSON = false } = {}) {
    const text = await response.text();

    if (!response.ok) {
        if (looksLikeHtml(text)) {
            throw new Error(`${errorContext} returned HTML instead of JSON. Check the request URL: ${response.url}`);
        }

        let detail = null;
        try {
            const payload = JSON.parse(text);
            detail = payload?.detail || null;
        } catch {
            detail = null;
        }

        if (detail) {
            throw new Error(detail);
        }

        throw new Error(`${errorContext} failed with status ${response.status}. Response: ${getResponseTextSnippet(text)}`);
    }

    if (looksLikeHtml(text)) {
        const hint = expectGeoJSON
            ? 'This usually means buildings_source.data points to a page route or a missing file instead of a GeoJSON asset.'
            : 'This usually means the ML service URL is pointing at the frontend server or another non-API endpoint.';
        throw new Error(`${errorContext} returned HTML instead of JSON. ${hint} URL: ${response.url}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        const kind = expectGeoJSON ? 'GeoJSON' : 'JSON';
        throw new Error(`${errorContext} returned invalid ${kind}. Response: ${getResponseTextSnippet(text)}`);
    }
}

export async function fetchGeoJSON(geojsonPath) {
    const response = await fetch(geojsonPath, {
        headers: {
            'Accept': 'application/geo+json, application/json'
        }
    });

    return parseJsonResponse(response, `Failed to load GeoJSON from ${geojsonPath}`, { expectGeoJSON: true });
}

export async function checkMlServiceHealth(serviceUrl) {
    let response;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);

    try {
        response = await fetch(`${serviceUrl.replace(/\/$/, '')}/health`, {
            headers: {
                'Accept': 'application/json'
            },
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('ML service health check timed out. Make sure the local backend is running and responsive.');
        }
        throw new Error('Cannot reach the ML service. Make sure the local backend is running on the configured port.');
    } finally {
        window.clearTimeout(timeoutId);
    }

    const payload = await parseJsonResponse(response, 'ML service health check');

    if (payload?.status !== 'ok') {
        throw new Error('ML service responded but is not ready.');
    }

    return payload;
}

export async function predictArchetypes({
    geojson,
    serviceUrl,
    archetypeProperty = 'building_archetype',
    heightProperty = 'height'
}) {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/predict-archetypes`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            geojson,
            archetype_property: archetypeProperty,
            height_property: heightProperty
        })
    });

    return parseJsonResponse(response, 'ML service request');
}

export async function predictArchetypesFromGeoJSONUrl({
    geojsonPath,
    serviceUrl,
    archetypeProperty = 'building_archetype'
}) {
    const geojson = await fetchGeoJSON(geojsonPath);
    return predictArchetypes({ geojson, serviceUrl, archetypeProperty });
}

export async function createPredictionJob({
    geojson,
    serviceUrl,
    archetypeProperty = 'building_archetype',
    heightProperty = 'height'
}) {
    let response;

    try {
        response = await fetch(`${serviceUrl.replace(/\/$/, '')}/predict-archetypes/jobs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                geojson,
                archetype_property: archetypeProperty,
                height_property: heightProperty
            })
        });
    } catch {
        throw new Error('Cannot reach the ML backend. Start the backend with:\nnpm run ml:start');
    }

    return parseJsonResponse(response, 'Failed to create prediction job');
}

export async function getPredictionJob({ jobId, serviceUrl }) {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/predict-archetypes/jobs/${jobId}`, {
        headers: {
            'Accept': 'application/json'
        }
    });

    if (response.status === 404) {
        throw new Error('Prediction job not found. The ML backend was likely restarted while the job was running. Start the prediction again.');
    }

    return parseJsonResponse(response, 'Failed to fetch prediction job');
}

export async function createPredictionJobFromGeoJSONUrl({
    geojsonPath,
    serviceUrl,
    archetypeProperty = 'building_archetype'
}) {
    const geojson = await fetchGeoJSON(geojsonPath);
    return createPredictionJob({ geojson, serviceUrl, archetypeProperty });
}