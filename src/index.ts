#!/usr/bin/env node
/**
 * Edgegap MCP server.
 *
 * Exposes ten curated tools covering the path from "I have a game server
 * container" to "players are connected to it", so a coding agent can take a
 * developer through it without the developer reading the API reference.
 *
 * Transport is stdio, which is what Claude Code, Cursor, Codex and VS Code use
 * for locally configured servers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ConfigError } from './config.js';
import { EdgegapClient } from './client.js';
import { registerTools } from './tools.js';
import { TokenProvider, warnIfTokenInArgv } from './auth.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stderr only: stdout is the MCP protocol channel and must stay clean.
      process.stderr.write(`[edgegap-mcp] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = new McpServer(
    { name: 'edgegap', version: '0.1.0' },
    {
      instructions:
        'Deploy and operate game servers on Edgegap.\n\n' +
        'Golden path for a first deployment:\n' +
        '1. edgegap_list_apps to see what already exists\n' +
        '2. edgegap_create_app if no suitable application is there\n' +
        '3. edgegap_create_app_version to register the container image\n' +
        '4. edgegap_deploy to start an instance near the players\n' +
        '5. edgegap_wait_for_deployment to get the connection address\n' +
        '6. edgegap_stop_deployment when finished\n\n' +
        'Deployments cost money while running. Tag test deployments and stop ' +
        'them before ending the task. If a deployment errors, read the container ' +
        'logs before redeploying.\n\n' +
        'Credentials: if no token was configured, the first tool call asks the ' +
        'developer for one. That token is org-wide and cannot be scoped by ' +
        'Edgegap, so it authorises far more than any single task needs. Treat it ' +
        'as a supervised credential: do not use it for work the developer did ' +
        'not ask for, do not enumerate or modify unrelated applications, and do ' +
        'not repeat operations against it to explore what is possible. If the ' +
        'developer declines to provide a token, stop and report which operation ' +
        'needed it — do not retry.',
    }
  );

  warnIfTokenInArgv();

  const auth = new TokenProvider(config);
  auth.attach(server.server);
  auth.installExitHandlers();

  registerTools(server, new EdgegapClient(config, auth), config, auth);

  if (!config.envToken) {
    process.stderr.write(
      '[edgegap-mcp] no token configured: you will be asked for one at first ' +
        'use. It stays in memory on this machine and is never written to disk ' +
        'or sent to Edgegap.\n'
    );
  }

  if (config.readOnly) {
    process.stderr.write('[edgegap-mcp] read-only mode: mutating tools are not registered\n');
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[edgegap-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
