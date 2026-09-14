/**
 * Thin client over the Edgegap REST API.
 *
 * Deliberately not generated from the OpenAPI spec: the generated surface is
 * ~60 operations, which is more than an agent can hold in context without
 * picking the wrong one. This wraps only what the golden path needs.
 */

import { Config, redact } from './config.js';
import { TokenSource } from './auth.js';

export class EdgegapApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiMessage: string,
    public readonly details?: unknown
  ) {
    super(`Edgegap API ${status}: ${apiMessage}`);
    this.name = 'EdgegapApiError';
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class EdgegapClient {
  constructor(
    private readonly config: Config,
    private readonly auth: TokenSource
  ) {}

  private async request<T>(
    method: Method,
    version: 'v1' | 'v2',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
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

    let response: Response;
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
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Request to ${method} ${path} timed out after ${this.config.requestTimeoutMs}ms.`
        );
      }
      throw new Error(
        redact(`Network error calling ${method} ${path}: ${(err as Error).message}`, token)
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { message: raw.slice(0, 500) };
      }
    }

    if (!response.ok) {
      // A rejected token is worth forgetting immediately, so the next call
      // re-prompts instead of failing repeatedly against a revoked credential.
      if (response.status === 401) this.auth.invalidate();

      const body = (parsed ?? {}) as { message?: string; details?: unknown };
      throw new EdgegapApiError(
        response.status,
        redact(body.message ?? response.statusText, token),
        body.details
      );
    }

    return (parsed ?? {}) as T;
  }

  // --- Applications and versions (v1) ------------------------------------

  listApps(query: { page?: number; limit?: number } = {}) {
    return this.request<ListAppsResponse>('GET', 'v1', '/v1/apps', { query });
  }

  createApp(body: { name: string; is_active: boolean; image: string }) {
    return this.request<AppRecord>('POST', 'v1', '/v1/app', { body });
  }

  listAppVersions(appName: string) {
    return this.request<ListVersionsResponse>(
      'GET',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/versions`
    );
  }

  createAppVersion(appName: string, body: Record<string, unknown>) {
    return this.request<{ success: boolean; version: AppVersionRecord }>(
      'POST',
      'v1',
      `/v1/app/${encodeURIComponent(appName)}/version`,
      { body }
    );
  }

  // --- Deployments --------------------------------------------------------

  /** v2 deploy. Returns only a request_id; the deployment is still starting. */
  deploy(body: Record<string, unknown>) {
    return this.request<{ request_id: string }>('POST', 'v2', '/deployments', { body });
  }

  getDeployment(requestId: string) {
    return this.request<DeploymentStatus>(
      'GET',
      'v1',
      `/v1/status/${encodeURIComponent(requestId)}`
    );
  }

  listDeployments(query: { query?: string; page?: number; limit?: number } = {}) {
    return this.request<ListDeploymentsResponse>('GET', 'v1', '/v1/deployments', { query });
  }

  stopDeployment(requestId: string) {
    return this.request<{ message: string; deployment_summary?: DeploymentStatus }>(
      'DELETE',
      'v1',
      `/v1/stop/${encodeURIComponent(requestId)}`
    );
  }

  getDeploymentLogs(requestId: string, format: 'text' | 'ndjson' = 'text') {
    return this.request<DeploymentLogs>(
      'GET',
      'v1',
      `/v1/deployment/${encodeURIComponent(requestId)}/container-logs`,
      { query: { format } }
    );
  }
}

// --- Response shapes (only the fields the tools actually surface) ----------

export interface AppRecord {
  name: string;
  is_active: boolean;
  create_time?: string;
  last_updated?: string;
}

export interface ListAppsResponse {
  applications?: AppRecord[];
  total_count?: number;
}

export interface AppVersionRecord {
  name: string;
  is_active?: boolean;
  req_cpu?: number;
  req_memory?: number;
  docker_repository?: string;
  docker_image?: string;
  docker_tag?: string;
  max_duration?: number;
  caching_percent?: number;
  ports?: Array<{ port: number; protocol: string; name?: string }>;
}

export interface ListVersionsResponse {
  versions?: AppVersionRecord[];
  total_count?: number;
}

export interface DeploymentPort {
  name: string;
  link: string;
  internal: number;
  external: number;
  protocol: string;
}

export interface DeploymentStatus {
  request_id: string;
  fqdn: string;
  public_ip: string;
  app_name: string;
  app_version: string;
  current_status: string;
  running: boolean;
  error: boolean;
  error_detail?: string;
  elapsed_time?: number;
  max_duration?: number;
  ports?: Record<string, DeploymentPort>;
  location?: { city?: string; country?: string; continent?: string };
  tags?: string[];
}

export interface ListDeploymentsResponse {
  data?: Array<{
    request_id: string;
    fqdn: string;
    public_ip: string;
    ready: boolean;
    start_time: string;
    ports?: Record<string, DeploymentPort>;
    tags?: string[];
  }>;
  total_count?: number;
}

export interface DeploymentLogs {
  logs?: string;
  crash_logs?: string | null;
  crash_data?: { exit_code?: number; message?: string; restart_count?: number } | null;
  logs_link?: string | null;
}
