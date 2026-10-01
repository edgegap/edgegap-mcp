/**
 * Builds and checks a basic Edgegap matchmaker configuration.
 *
 * Edgegap has no public API for creating a matchmaker: it is created in the
 * dashboard by uploading a JSON configuration. What an agent can usefully do is
 * produce that JSON correctly the first time, pointed at an application version
 * that actually exists, so the developer's only step is the upload.
 *
 * Format reference: https://docs.edgegap.com/learn/matchmaking/matchmaker-in-depth
 */
/** Config schema version the docs currently publish. Overridable per call. */
export const MATCHMAKER_CONFIG_VERSION = '3.3.2';
export const DASHBOARD_URL = 'https://app.edgegap.com';
const DURATION = /^\d+(ms|s|m|h)$/;
function seconds(d) {
    const m = d.match(/^(\d+)(ms|s|m|h)$/);
    if (!m)
        return NaN;
    const n = Number(m[1]);
    return m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : n * 3600;
}
export function buildMatchmakerConfig(input) {
    const problems = [];
    const cautions = [];
    if (input.min_team_size > input.max_team_size) {
        problems.push(`min_team_size (${input.min_team_size}) is greater than max_team_size (${input.max_team_size}).`);
    }
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(input.profile_name)) {
        problems.push(`profile_name "${input.profile_name}" should be letters, digits, "-" or "_". Game clients send it on every ticket.`);
    }
    const expiration = input.ticket_expiration ?? '5m';
    const removal = input.ticket_removal ?? '1m';
    for (const [field, value] of [['ticket_expiration', expiration], ['ticket_removal', removal]]) {
        if (!DURATION.test(value))
            problems.push(`${field} "${value}" is not a duration like "30s", "5m" or "1h".`);
    }
    if (seconds(expiration) < 60) {
        cautions.push(`ticket_expiration ${expiration} is short. Tickets must outlive the queue wait plus server start-up, or players are dropped before the match is ready.`);
    }
    const rules = {
        match_size: {
            type: 'player_count',
            attributes: {
                team_count: input.team_count,
                min_team_size: input.min_team_size,
                max_team_size: input.max_team_size,
            },
        },
    };
    const useLatency = input.max_latency_ms !== undefined || input.latency_difference_ms !== undefined;
    if (useLatency) {
        rules.beacons = {
            type: 'latencies',
            attributes: {
                difference: input.latency_difference_ms ?? 100,
                max_latency: input.max_latency_ms ?? 200,
            },
        };
    }
    const expansions = {};
    let lastAfter = 0;
    for (const e of [...(input.expansions ?? [])].sort((a, b) => a.after_seconds - b.after_seconds)) {
        const step = {};
        if (e.min_team_size !== undefined) {
            if (e.min_team_size > input.max_team_size) {
                problems.push(`expansion at ${e.after_seconds}s sets min_team_size ${e.min_team_size} above max_team_size ${input.max_team_size}.`);
            }
            step.match_size = { min_team_size: e.min_team_size };
        }
        if (e.max_latency_ms !== undefined) {
            if (!useLatency) {
                problems.push(`expansion at ${e.after_seconds}s relaxes max_latency_ms, but no latency rule is configured. Set max_latency_ms on the profile too.`);
            }
            step.beacons = { max_latency: e.max_latency_ms };
        }
        if (Object.keys(step).length === 0)
            continue;
        if (e.after_seconds === lastAfter)
            problems.push(`two expansions share after_seconds ${e.after_seconds}.`);
        lastAfter = e.after_seconds;
        expansions[String(e.after_seconds)] = step;
    }
    if (input.team_count * input.min_team_size === 1) {
        cautions.push('A match of one player starts a server per ticket. Fine for testing, costly in production.');
    }
    const config = {
        version: input.config_version ?? MATCHMAKER_CONFIG_VERSION,
        inspect: input.inspect ?? true,
        max_deployment_retry_count: 3,
        profiles: {
            [input.profile_name]: {
                ticket_expiration_period: expiration,
                ticket_removal_period: removal,
                group_inactivity_removal_period: '5m',
                application: { name: input.application, version: input.version },
                rules: { initial: rules, expansions },
            },
        },
    };
    return { config, problems, cautions };
}
