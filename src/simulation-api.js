function getResponseTextSnippet(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

function looksLikeHtml(text) {
    const trimmed = String(text || '').trim().toLowerCase();
    return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<body');
}

async function parseJsonResponse(response, errorContext) {
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
        throw new Error(`${errorContext} returned HTML instead of JSON. Check that the simulation service URL points to the backend API. URL: ${response.url}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${errorContext} returned invalid JSON. Response: ${getResponseTextSnippet(text)}`);
    }
}

export async function checkSimulationServiceHealth(serviceUrl) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/health`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });

        return parseJsonResponse(response, 'Simulation service health check');
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('Simulation service health check timed out. Make sure the local backend is running and responsive.');
        }
        throw new Error('Cannot reach the simulation backend. Start it with:\nnpm run simulation:start');
    } finally {
        window.clearTimeout(timeoutId);
    }
}

export async function createSimulationJob({ payload, serviceUrl }) {
    let response;

    try {
        response = await fetch(`${serviceUrl.replace(/\/$/, '')}/simulation-jobs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } catch {
        throw new Error('Cannot reach the simulation backend. Start it with:\nnpm run simulation:start');
    }

    return parseJsonResponse(response, 'Failed to create simulation job');
}

export async function getSimulationJob({ jobId, serviceUrl }) {
    const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/simulation-jobs/${jobId}`, {
        headers: {
            Accept: 'application/json'
        }
    });

    if (response.status === 404) {
        throw new Error('Simulation job not found. The simulation backend was likely restarted while the job was running. Please submit the simulation again.');
    }

    return parseJsonResponse(response, 'Failed to fetch simulation job');
}

export function getBuildingSqlDownloadUrl({ jobId, buildingId, serviceUrl }) {
    return `${serviceUrl.replace(/\/$/, '')}/simulation-jobs/${encodeURIComponent(jobId)}/buildings/${encodeURIComponent(toArtifactToken(buildingId))}/sql`;
}

export async function getBuildingHourlyOutputs({ jobId, buildingId, serviceUrl }) {
    const baseUrl = serviceUrl.replace(/\/$/, '');
    const queryUrl = `${baseUrl}/simulation-jobs/${encodeURIComponent(jobId)}/building-hourly?building_id=${encodeURIComponent(buildingId)}`;
    let response = await fetch(queryUrl, {
        headers: {
            Accept: 'application/json'
        }
    });

    if (response.status === 404 || response.status === 405) {
        response = await fetch(
            `${baseUrl}/simulation-jobs/${encodeURIComponent(jobId)}/buildings/${encodeURIComponent(toArtifactToken(buildingId))}/hourly`,
            {
                headers: {
                    Accept: 'application/json'
                }
            }
        );
    }

    return parseJsonResponse(response, 'Failed to fetch hourly simulation outputs');
}

function toArtifactToken(value) {
    const token = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^[._]+|[._]+$/g, '');
    return token || 'building';
}

export async function syncIdfTemplate({ payload, serviceUrl }) {
    let response;

    try {
        response = await fetch(`${serviceUrl.replace(/\/$/, '')}/idf-templates/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } catch {
        throw new Error('Cannot reach the simulation backend. Start it with:\nnpm run simulation:start');
    }

    return parseJsonResponse(response, 'Failed to sync IDF template');
}
