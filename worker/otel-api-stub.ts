/**
 * Stand-in for "@opentelemetry/api", aliased in wrangler.jsonc.
 *
 * posthog-node imports it optionally, inside a try, to attach trace and span
 * ids to events. This Worker runs no OpenTelemetry, so there is never an
 * active span; the bundler still has to resolve the import, which fails
 * without the package. This module gives it the one call posthog-node makes.
 */
export const trace = {
  getActiveSpan(): undefined {
    return undefined;
  },
};
