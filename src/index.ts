#!/usr/bin/env node
/**
 * graphite-mcp entrypoint: speaks MCP over stdio.
 *
 * Protocol discipline:
 *   - NOTHING is written to stdout except MCP protocol frames (the SDK owns
 *     stdout). Human-facing lines (startup notice, errors) go to stderr.
 *   - `--help` / `-h` prints the tool list to stdout and exits BEFORE any
 *     transport starts, so it cannot pollute a protocol session.
 *   - SIGINT/SIGTERM close the transport cleanly and exit 0.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGraphiteServer, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from './server.js';
import { errorEnvelope } from './tools.js';

const HELP = `graphite-mcp — the studio's programmatic graphics engine boundary (MCP, stdio)

Usage: graphite-mcp            start the MCP server on stdio
       graphite-mcp --help     this message

Tools:
${TOOL_NAMES.map((name) => `  ${name}`).join('\n')}

Env: GRAPHITE_CLI_PATH — explicit graphene-cli binary path (exclusive override;
     default: <projectRoot>/engine/Graphite/target/debug/graphene-cli)

Version: ${SERVER_VERSION}`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    // Pre-transport, exiting immediately: stdout is not a protocol stream yet.
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const server = createGraphiteServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`graphite-mcp: ${signal} received — closing\n`);
    void transport
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);
  // Single human-facing startup line (stderr — stdout is protocol-only).
  process.stderr.write(`graphite-mcp v${SERVER_VERSION}: listening on stdio (${TOOL_NAMES.length} tools)\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`graphite-mcp failed to start: ${JSON.stringify(errorEnvelope(err))}\n`);
  process.exit(1);
});