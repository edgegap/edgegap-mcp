/**
 * OpenAPI spec loader, Workers-flavored.
 *
 * Workers has no filesystem, so we import the bundled JSON specs as ES modules.
 * The bundler inlines them; the registry is built once and cached at module
 * scope (so cold-start cost is paid once per Worker isolate).
 */

import v1Spec from "../../spec/edgegap-v1-openapi.json";
import v2Spec from "../../spec/edgegap-v2-openapi.json";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EndpointParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema?: unknown;
}

export interface Endpoint {
  operationId: string;
  method: HttpMethod;
  path: string;
  apiVersion: "v1" | "v2";
  summary?: string;
  description?: string;
  tags: string[];
  params: EndpointParam[];
  hasBody: boolean;
}

export interface EndpointRegistry {
  byId: Map<string, Endpoint>;
  all: Endpoint[];
}

interface OpenApiDoc {
  paths?: Record<string, Record<string, OpenApiOperation>>;
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: unknown;
  }>;
  requestBody?: { content?: { "application/json"?: { schema?: unknown } } };
}

function methodToHttp(m: string): HttpMethod | null {
  const u = m.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(u)
    ? (u as HttpMethod)
    : null;
}

function ingest(
  doc: OpenApiDoc,
  apiVersion: "v1" | "v2",
  reg: EndpointRegistry,
): void {
  for (const [rawPath, methods] of Object.entries(doc.paths ?? {})) {
    for (const [m, op] of Object.entries(methods)) {
      const method = methodToHttp(m);
      if (!method) continue;
      const operationId = op.operationId;
      if (!operationId) continue;
      const resolvedPath =
        apiVersion === "v2" && !rawPath.startsWith("/v2/")
          ? "/v2" + rawPath
          : rawPath;
      const params: EndpointParam[] = (op.parameters ?? []).map((p) => ({
        name: p.name,
        in: (p.in === "path" || p.in === "query" || p.in === "header"
          ? p.in
          : "query") as EndpointParam["in"],
        required: !!p.required,
        description: p.description,
        schema: p.schema,
      }));
      reg.byId.set(operationId, {
        operationId,
        method,
        path: resolvedPath,
        apiVersion,
        summary: op.summary,
        description: op.description,
        tags: op.tags ?? [],
        params,
        hasBody: !!op.requestBody?.content?.["application/json"]?.schema,
      });
    }
  }
}

let cached: EndpointRegistry | null = null;

export function loadRegistry(): EndpointRegistry {
  if (cached) return cached;
  const reg: EndpointRegistry = { byId: new Map(), all: [] };
  ingest(v1Spec as OpenApiDoc, "v1", reg);
  ingest(v2Spec as OpenApiDoc, "v2", reg); // v2 wins on collisions
  const seen = new Set<string>();
  for (const ep of reg.byId.values()) {
    const key = `${ep.method} ${ep.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      reg.all.push(ep);
    }
  }
  cached = reg;
  return reg;
}

export function renderPath(
  template: string,
  pathParams: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    const v = pathParams[name];
    if (v === undefined || v === null || v === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(v));
  });
}

export function summarizeEndpoint(ep: Endpoint): string {
  const required = ep.params.filter((p) => p.required).map((p) => p.name);
  const optional = ep.params.filter((p) => !p.required).map((p) => p.name);
  const parts = [
    `${ep.method} ${ep.path}`,
    ep.summary ? `— ${ep.summary}` : "",
    required.length ? `required: [${required.join(", ")}]` : "",
    optional.length ? `optional: [${optional.join(", ")}]` : "",
    ep.hasBody ? "accepts JSON body" : "",
  ].filter(Boolean);
  return parts.join("  ");
}

/** Used by readOnly tool filter — true if this endpoint mutates state. */
export function isMutating(ep: Endpoint): boolean {
  return ep.method !== "GET";
}
