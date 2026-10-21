# Changelog

Published versions of `@edgegap/mcp`, which also run on the hosted endpoint at `mcp.edgegap.dev`. Dates are npm publish dates. Versions merged but never published (0.5.8, 0.6.0) shipped as part of the next release. Older entries are summarised from the commit history.

## 0.7.0

**New tools:**
- `edgegap_list_locations` and `edgegap_list_ping_beacons`: where servers can run (only the locations with capacity, when you give a version) and the beacons clients ping to measure latency.
- `edgegap_get_app_version` and `edgegap_update_app_version`: read a version in full, and change its tag, active state, max duration, registry login, image caching (`force_cache`), verify_image or grace period without creating a new one.
- `edgegap_update_app`: turn an application on or off.
- `edgegap_get_deployment_metrics`: CPU, throttling, memory and network, as latest, average and peak.
- `edgegap_delete_registry_tag`: delete one exact tag. Wildcards, `latest` and bulk deletes are refused.
- `edgegap_list_relay_sessions` and `edgegap_revoke_relay_user`.

**Changes:**
- Every result is scrubbed of the API token, including successful ones. Results also carry `structuredContent`.
- `edgegap_deploy` now says its `cpu_units`/`memory_mb` override is not in the published v2 API and may be ignored.
- The Docker image is built for `linux/arm64` as well as `linux/amd64`.
- New tests: spec parity (`test/spec.mjs`), a tool-list snapshot (`test/snapshot.mjs`) and unit tests. CI also scans every tracked file for secrets and local paths.

## 0.6.3 (2026-10-21)
- Skills pack 0.13.1, with 19 skills: adds Photon's Simple FPS sample, Godot, Colyseus and Nakama, all routed in the server instructions.

## 0.6.2 (2026-10-20)
- `edgegap_build_matchmaker_config` next steps poll `GET /tickets/{id}`; groups and memberships are offered only as the party alternative.

## 0.6.1 (2026-10-20)
- Guardrails:
  - Refuses `latest`, empty and malformed image tags.
  - Refuses a `docker_image` that holds a registry or tag.
  - `EDGEGAP_MAX_AGENT_DEPLOYMENTS` caps running agent deployments (default 5).
  - Env vars named like secrets are hidden in the dashboard.
- The hosted endpoint only accepts UUID Edgegap tokens; other bearers are reported as `auth_problem: foreign`.
- Skills pack 0.9.0, adding `edgegap-fusion`.

## 0.5.7 (2026-10-20)
- Skills pack 0.8.0: adds `edgegap-ngo` and `edgegap-eos-voice`, routed in the instructions.

## 0.5.6 (2026-10-19)
- The hosted endpoint records why a call had no token (`auth_problem`).

## 0.5.5 (2026-10-15)
- Serves `edgegap-manus`. Fixes cached tool schemas blocking new skills. Upgrades dependencies past open advisories.

## 0.5.4 / 0.5.3 (2026-10-15)
- Serves `edgegap-purrnet` and `edgegap-fishnet`.

## 0.5.2 (2026-10-14)
- PostHog MCP Analytics on the hosted Worker (opt-out header; the local server sends nothing).

## 0.5.1 (2026-10-14)
- The skills line comes first in the server instructions.

## 0.5.0 (2026-10-14)
- Serves the Edgegap agent skills over MCP: `edgegap_list_skills`, `edgegap_get_skill`, prompts and `edgegap-skill://` resources.

## 0.4.0 (2026-10-13)
- Guardrails:
  - `dry_run` on every write tool.
  - Refuses the API token in env vars, tags and webhooks.
  - Forced `edgegap-mcp` deploy tag.
  - Auto-stop reporting.
  - Strict single-ID stop.
  - API host label on every result.
- Adds `edgegap_context` and a `User-Agent`.

## 0.3.3 / 0.3.2 / 0.3.1 (2026-10-08 to 2026-10-09)
- Fixes from the WebGL + Mirror + matchmaker end-to-end test.
- Registry tools fixed against the real API.
- `npx @edgegap/mcp` starts again.

## 0.3.0 / 0.2.2 / 0.2.0 (2026-09-30 to 2026-10-01)
- Dockerfile generator and validator, relays, and a matchmaker config builder.
- Dedicated servers recommended over relays.

## 0.1.x (2026-09-14 to 2026-09-16)
- First releases: apps, versions, deploy, wait, logs, stop.
