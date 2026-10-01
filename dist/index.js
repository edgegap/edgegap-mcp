#!/usr/bin/env node
/**
 * Edgegap MCP server.
 *
 * Exposes curated tools covering the path from "I have a headless server
 * build" to "players are connected to it" — Dockerfile checks, registry push,
 * deploy, relays for peer-to-peer games, and a matchmaker config — so a coding
 * agent can take a developer through it without reading the API reference.
 *
 * Transport is stdio, which is what Claude Code, Cursor, Codex and VS Code use
 * for locally configured servers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ConfigError } from './config.js';
import { EdgegapClient } from './client.js';
import { registerTools, serverInstructions } from './tools.js';
import { TokenProvider, warnIfTokenInArgv } from './auth.js';
async function main() {
    let config;
    try {
        config = loadConfig();
    }
    catch (err) {
        if (err instanceof ConfigError) {
            // stderr only: stdout is the MCP protocol channel and must stay clean.
            process.stderr.write(`[edgegap-mcp] ${err.message}\n`);
            process.exit(1);
        }
        throw err;
    }
    const server = new McpServer({ name: 'edgegap', version: '0.2.2' }, { instructions: serverInstructions('local') });
    warnIfTokenInArgv();
    const auth = new TokenProvider(config);
    auth.attach(server.server);
    auth.installExitHandlers();
    registerTools(server, new EdgegapClient(config, auth), config, auth);
    if (!config.envToken) {
        process.stderr.write('[edgegap-mcp] no token configured: you will be asked for one at first ' +
            'use. It stays in memory on this machine and is never written to disk ' +
            'or sent to Edgegap.\n');
    }
    if (config.readOnly) {
        process.stderr.write('[edgegap-mcp] read-only mode: mutating tools are not registered\n');
    }
    await server.connect(new StdioServerTransport());
}
main().catch((err) => {
    process.stderr.write(`[edgegap-mcp] fatal: ${err.message}\n`);
    process.exit(1);
});
