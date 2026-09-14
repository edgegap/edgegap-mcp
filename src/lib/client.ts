/**
 * Edgegap API client.
 *
 * Key difference from the stdio version: the token is passed PER REQUEST,
 * not baked into the client at construction. This is because in the Worker,
 * each MCP request is associated with a different session's token.
 */

export interface EdgegapRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface EdgegapResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

export class EdgegapError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(
      `Edgegap API ${status} on ${path}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`,
    );
    this.name = "EdgegapError";
  }
}

export class EdgegapClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {
    if (!apiToken) throw new Error("apiToken required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(req: EdgegapRequest): Promise<EdgegapResponse> {
    const url = new URL(this.baseUrl + req.path);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `token ${this.apiToken}`,
      Accept: "application/json",
      "User-Agent": "edgegap-mcp/0.2.0 (cloudflare-workers)",
    };

    let body: string | undefined;
    if (req.body !== undefined && req.method !== "GET") {
      body = JSON.stringify(req.body);
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url.toString(), { method: req.method, headers, body });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, ok: res.ok, data };
  }

  async requestOrThrow(req: EdgegapRequest): Promise<unknown> {
    const res = await this.request(req);
    if (!res.ok) throw new EdgegapError(res.status, req.path, res.data);
    return res.data;
  }
}
