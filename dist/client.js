/**
 * Thin client over the Edgegap REST API.
 *
 * Deliberately not generated from the OpenAPI spec: the generated surface is
 * ~60 operations, which is more than an agent can hold in context without
 * picking the wrong one. This wraps only what the golden path needs.
 */
import { redact } from './config.js';
export class EdgegapApiError extends Error {
    status;
    apiMessage;
    details;
    constructor(status, apiMessage, details) {
        super(`Edgegap API ${status}: ${apiMessage}`);
        this.status = status;
        this.apiMessage = apiMessage;
        this.details = details;
        this.name = 'EdgegapApiError';
    }
}
export class EdgegapClient {
    config;
    auth;
    constructor(config, auth) {
        this.config = config;
        this.auth = auth;
    }
    async request(method, version, path, options = {}) {
        const base = version === 'v2' ? this.config.baseUrlV2 : this.config.baseUrlV1;
        const url = new URL(base + path);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, String(value));
            }
        }
        // Resolved per request rather than at construction: the developer may not
        // have been asked for a token yet.
        const token = await this.auth.get();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        let response;
        try {
            response = await fetch(url.toString(), {
                method,
                headers: {
                    // Edgegap expects the literal word "token" before the value.
                    Authorization: `token ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': 'edgegap-mcp',
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller.signal,
            });
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                throw new Error(`Request to ${method} ${path} timed out after ${this.config.requestTimeoutMs}ms.`);
            }
            throw new Error(redact(`Network error calling ${method} ${path}: ${err.message}`, token));
        }
        finally {
            clearTimeout(timer);
        }
        const raw = await response.text();
        let parsed = undefined;
        if (raw) {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                parsed = { message: raw.slice(0, 500) };
            }
        }
        if (!response.ok) {
            // A rejected token is worth forgetting immediately, so the next call
            // re-prompts instead of failing repeatedly against a revoked credential.
            if (response.status === 401)
                this.auth.invalidate();
            const body = (parsed ?? {});
            throw new EdgegapApiError(response.status, redact(body.message ?? response.statusText, token), body.details);
        }
        return (parsed ?? {});
    }
    // --- Applications and versions (v1) ------------------------------------
    listApps(query = {}) {
        return this.request('GET', 'v1', '/v1/apps', { query });
    }
    createApp(body) {
        return this.request('POST', 'v1', '/v1/app', { body });
    }
    listAppVersions(appName) {
        return this.request('GET', 'v1', `/v1/app/${encodeURIComponent(appName)}/versions`);
    }
    createAppVersion(appName, body) {
        return this.request('POST', 'v1', `/v1/app/${encodeURIComponent(appName)}/version`, { body });
    }
    // --- Deployments --------------------------------------------------------
    /** v2 deploy. Returns only a request_id; the deployment is still starting. */
    deploy(body) {
        return this.request('POST', 'v2', '/deployments', { body });
    }
    getDeployment(requestId) {
        return this.request('GET', 'v1', `/v1/status/${encodeURIComponent(requestId)}`);
    }
    listDeployments(query = {}) {
        return this.request('GET', 'v1', '/v1/deployments', { query });
    }
    stopDeployment(requestId) {
        return this.request('DELETE', 'v1', `/v1/stop/${encodeURIComponent(requestId)}`);
    }
    getDeploymentLogs(requestId, format = 'text') {
        return this.request('GET', 'v1', `/v1/deployment/${encodeURIComponent(requestId)}/container-logs`, { query: { format } });
    }
    // --- Container registry -------------------------------------------------
    /**
     * Push credentials for the organization's project on registry.edgegap.com.
     * Not in the published OpenAPI spec: this is the endpoint the Unity plugin
     * uses, and it can fail until init-quick-start has provisioned the project.
     */
    getRegistryCredentials() {
        return this.request('GET', 'v1', '/v1/wizard/registry-credentials');
    }
    /** Provisions the registry project if needed. Idempotent; returns 204. */
    initQuickStart(source) {
        return this.request('POST', 'v1', '/v1/wizard/init-quick-start', { body: { source } });
    }
    /** imageName is "<project>/<image>"; the slash is part of the route. */
    listRegistryTags(imageName, query = {}) {
        const path = imageName.split('/').map(encodeURIComponent).join('/');
        return this.request('GET', 'v1', `/v1/container-registry/images/${path}/tags`, { query });
    }
    // --- Relays -------------------------------------------------------------
    createRelaySession(body) {
        return this.request('POST', 'v1', '/v1/relays/sessions', { body });
    }
    getRelaySession(sessionId) {
        return this.request('GET', 'v1', `/v1/relays/sessions/${encodeURIComponent(sessionId)}`);
    }
    authorizeRelayUser(body) {
        return this.request('POST', 'v1', '/v1/relays/sessions:authorize-user', { body });
    }
    deleteRelaySession(sessionId) {
        return this.request('DELETE', 'v1', `/v1/relays/sessions/${encodeURIComponent(sessionId)}`);
    }
}
