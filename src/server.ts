/**
 * The graphite-mcp MCP server: creates the McpServer instance and registers
 * the four Graphite tools. Deliberately boring — all behavior lives in the
 * tool layer (src/tools.ts); this module is wiring.
 *
 * The stdio transport, signal handling, and startup logging live in the
 * entrypoint (src/index.ts) so tests can mount this server over
 * InMemoryTransport without any process-level side effects.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGraphiteTools } from './tools.js';

export const SERVER_NAME = 'graphite-mcp';
export const SERVER_VERSION = '0.1.0';

/** The six tool names, in registration order. */
export const TOOL_NAMES = [
  'graphite_render',
  'graphite_list_nodes',
  'graphite_search_nodes',
  'graphite_describe_node',
  'graphite_validate_doc',
  'graphite_render_variants',
] as const;

/**
 * Creates the graphite-mcp server with all four tools registered. No
 * transport is attached — connect() it to a transport of your choice.
 */
export function createGraphiteServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Graphite renders deterministic procedural graphics. Author documents as data ' +
        '(graphite_render with templateId+params, or inline .graphite JSON), validate before ' +
        'rendering with graphite_validate_doc, and discover the node registry with graphite_search_nodes ' +
        '(keyword/category search) and graphite_describe_node (full input contract per node) — between them ' +
        'Every successful render reports a validated artifact with sha256 and quarantine metadata — ' +
        'the pinned engine always exits SIGSEGV after writing, which is quarantined, not fatal.',
    },
  );
  registerGraphiteTools(server);
  return server;
}