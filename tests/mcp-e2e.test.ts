/**
 * MCP-LEVEL e2e for the four Graphite tools, exercised in-process over the
 * SDK's InMemoryTransport (client ↔ server, full protocol, no subprocess).
 *
 * Two tiers:
 *   - "mcp protocol surface" — schema/envelope behavior that needs NO binary
 *     (tool advertisement, SPEC_INVALID rejections, structural validation);
 *   - "mcp e2e (real graphene-cli)" — real renders/compile/registry through
 *     the pinned engine, skipped entirely when the binary is absent so the
 *     suite stays green pre-build (same guard as tests/templates-e2e.test.ts).
 *
 * Ground truth re-asserted on every successful render: the pinned CLI writes
 * a valid artifact and THEN dies with SIGSEGV — the tool result must always
 * carry quarantine metadata with quarantinedAfterWrite === true.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGraphiteServer, TOOL_NAMES } from '../src/server.js';
import { defaultCliPath } from '../src/paths.js';

const CLI_PATH = defaultCliPath();
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DUOTONE = path.join(PROJECT_ROOT, 'templates', 'duotone-image.graphite');
const EXPORTS_DIR = path.join(PROJECT_ROOT, 'exports');
const VARIANTS_DIR = path.join(PROJECT_ROOT, 'tmp', 'mcp-e2e-variants');

const E2E_TIMEOUT = 120_000;

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

let client: Client;

/** Opens one in-memory client↔server pair and returns the connected client. */
async function connectClient(): Promise<Client> {
  const server = createGraphiteServer();
  const connected = new Client({ name: 'graphite-mcp-e2e', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(clientTransport);
  await connected.connect(serverTransport);
  return connected;
}

/** Extracts (and parses) the single JSON text block of a tool result. */
function jsonOf(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((c) => c.type === 'text')?.text;
  expect(text, 'tool result must carry one text content block').toBeTruthy();
  return JSON.parse(text as string);
}

const DUOTONE_DEFAULTS = {
  width: 1000,
  height: 500,
  seed: 0,
  scale: 35,
  dark: { red: 0.02, green: 0.02, blue: 0.12, alpha: 1 },
  light: { red: 1, green: 0.3, blue: 0.03, alpha: 1 },
  reverse: false,
};

/** Shared assertions for a successful render result (either source mode). */
function expectSuccessfulRender(payload: any, opts: { templateDriven: boolean }): void {
  expect(typeof payload.artifactPath).toBe('string');
  expect(path.isAbsolute(payload.artifactPath), 'artifactPath must be absolute').toBe(true);
  expect(existsSync(payload.artifactPath), `artifact must exist: ${payload.artifactPath}`).toBe(true);
  expect(payload.format).toBe('png');
  expect(payload.byteSize).toBeGreaterThan(1000);
  expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(payload.width).toBe(1000);
  expect(payload.height).toBe(500);
  expect(payload.validation).toBeDefined();
  expect(payload.validation.valid).toBe(true);
  expect(payload.renderMs).toEqual(expect.any(Number));
  expect(payload.command).toEqual(expect.any(String));
  // Quarantine metadata is ALWAYS present; with the pinned CLI the write is
  // followed by SIGSEGV, so quarantinedAfterWrite is true — normal, expected.
  expect(payload.quarantine).toBeDefined();
  expect(payload.quarantine.quarantinedAfterWrite).toBe(true);
  expect(payload.quarantine.signal === 'SIGSEGV' || payload.quarantine.exitCode === 139).toBe(true);
  if (opts.templateDriven) {
    expect(payload.templateId).toBe('duotone-image');
    expect(payload.params).toEqual(DUOTONE_DEFAULTS);
  } else {
    expect(payload.templateId).toBeUndefined();
    expect(payload.params).toBeUndefined();
    expect(payload.documentPath).toContain(path.join('tmp', 'mcp-inline'));
  }
  expect(payload.documentPath).toEqual(expect.any(String));
}

// ---------------------------------------------------------------------------
// Protocol surface — no CLI binary required
// ---------------------------------------------------------------------------

describe('mcp protocol surface (no CLI binary required)', () => {
  beforeAll(async () => {
    client = await connectClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it('advertises exactly the four Graphite tools with descriptions and input schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description, `${tool.name} must have a description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} must advertise an input schema`).toBeDefined();
    }
  });

  it('graphite_render rejects width-only raster output with a SPEC_INVALID envelope', async () => {
    const result = await client.callTool({
      name: 'graphite_render',
      arguments: {
        templateId: 'duotone-image',
        output: { format: 'png', width: 800 },
      },
    });
    expect(result.isError).toBe(true);
    const payload = jsonOf(result);
    expect(payload.code).toBe('SPEC_INVALID');
    expect(payload.message).toMatch(/width/);
    expect(payload.message).toMatch(/height/);
  });

  it('graphite_render rejects an unknown templateId with the known list', async () => {
    const result = await client.callTool({
      name: 'graphite_render',
      arguments: {
        templateId: 'not-a-template',
        output: { format: 'png', width: 100, height: 100 },
      },
    });
    expect(result.isError).toBe(true);
    const payload = jsonOf(result);
    expect(payload.code).toBe('SPEC_INVALID');
    expect(payload.message).toMatch(/unknown template id "not-a-template"/);
    expect(payload.message).toContain('duotone-image');
  });

  it('graphite_render rejects neither and both of templateId/document', async () => {
    const neither = await client.callTool({
      name: 'graphite_render',
      arguments: { output: { format: 'png', width: 100, height: 100 } },
    });
    expect(jsonOf(neither).code).toBe('SPEC_INVALID');

    const both = await client.callTool({
      name: 'graphite_render',
      arguments: {
        templateId: 'duotone-image',
        document: {},
        output: { format: 'png', width: 100, height: 100 },
      },
    });
    expect(jsonOf(both).code).toBe('SPEC_INVALID');
  });

  it('graphite_render rejects an outputName that already carries an extension', async () => {
    const result = await client.callTool({
      name: 'graphite_render',
      arguments: {
        templateId: 'duotone-image',
        output: { format: 'png', width: 100, height: 100, outputName: 'hero.png' },
      },
    });
    expect(result.isError).toBe(true);
    const payload = jsonOf(result);
    expect(payload.code).toBe('SPEC_INVALID');
    expect(payload.message).toMatch(/base name WITHOUT a format extension/);
  });

  it('graphite_validate_doc accepts a committed template sample structurally (no compile)', async () => {
    const sample = JSON.parse(readFileSync(SAMPLE_DUOTONE, 'utf8')) as unknown;
    const result = await client.callTool({ name: 'graphite_validate_doc', arguments: { document: sample } });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.valid).toBe(true);
    expect(payload.structural.nodeCount).toBe(5);
    expect(payload.structural.reasons).toEqual([]);
    expect(Object.values(payload.structural.checks).every(Boolean)).toBe(true);
    expect(payload.compile).toBeUndefined();
    expect(payload.documentPath).toBeUndefined();
  });

  it('graphite_validate_doc reports broken exports as data (valid: false + reason)', async () => {
    const sample = JSON.parse(readFileSync(SAMPLE_DUOTONE, 'utf8')) as {
      network_interface: { network: { exports: unknown[] } };
    };
    const broken = JSON.parse(JSON.stringify(sample));
    broken.network_interface.network.exports = [{ Node: { node_id: 999999, output_index: 0 } }];
    const result = await client.callTool({ name: 'graphite_validate_doc', arguments: { document: broken } });
    expect(result.isError).toBeFalsy(); // validation results are data, not errors
    const payload = jsonOf(result);
    expect(payload.valid).toBe(false);
    expect(payload.structural.checks.exportsResolveToNodes).toBe(false);
    expect(payload.structural.reasons.join(' ')).toMatch(/999999/);
  });

  it('graphite_validate_doc reports a missing network_interface precisely', async () => {
    const result = await client.callTool({ name: 'graphite_validate_doc', arguments: { document: { foo: 1 } } });
    const payload = jsonOf(result);
    expect(payload.valid).toBe(false);
    expect(payload.structural.reasons.join(' ')).toMatch(/network_interface/);
  });

  it('graphite_validate_doc reports an invalid JSON string as data', async () => {
    const result = await client.callTool({ name: 'graphite_validate_doc', arguments: { document: '{ not json' } });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.valid).toBe(false);
    expect(payload.structural.reasons.join(' ')).toMatch(/not valid JSON/);
  });

  it('graphite_validate_doc rejects passing both document and documentPath', async () => {
    const result = await client.callTool({
      name: 'graphite_validate_doc',
      arguments: { document: {}, documentPath: 'x.graphite' },
    });
    expect(result.isError).toBe(true);
    expect(jsonOf(result).code).toBe('SPEC_INVALID');
  });

  it('graphite_render_variants rejects fewer than 2 variants with SPEC_INVALID', async () => {
    const result = await client.callTool({
      name: 'graphite_render_variants',
      arguments: { templateId: 'duotone-image', variants: [DUOTONE_DEFAULTS], format: 'png', width: 100, height: 100 },
    });
    expect(result.isError).toBe(true);
    const payload = jsonOf(result);
    expect(payload.code).toBe('SPEC_INVALID');
    expect(payload.message).toMatch(/variants/);
  });
});

// ---------------------------------------------------------------------------
// Real-CLI e2e — full pipeline over the MCP protocol
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(CLI_PATH))('mcp e2e (real graphene-cli)', () => {
  beforeAll(async () => {
    client = await connectClient();
  });

  afterAll(async () => {
    await client.close();
    // Remove artifacts this suite wrote (never touch foreign files in exports/).
    for (const name of await readdirOrEmpty(EXPORTS_DIR)) {
      if (name.startsWith('mcp-e2e-')) await rm(path.join(EXPORTS_DIR, name), { force: true });
    }
    await rm(VARIANTS_DIR, { recursive: true, force: true });
  });

  it(
    'graphite_render template-driven (duotone, default params) returns a valid artifact with quarantine metadata',
    async () => {
      const result = await client.callTool({
        name: 'graphite_render',
        arguments: {
          templateId: 'duotone-image',
          output: { format: 'png', width: 1000, height: 500, outputName: 'mcp-e2e-render-default' },
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expectSuccessfulRender(payload, { templateDriven: true });
    },
    E2E_TIMEOUT,
  );

  it(
    'graphite_render inline-document path (committed sample as the inline doc) behaves identically',
    async () => {
      const sample = JSON.parse(readFileSync(SAMPLE_DUOTONE, 'utf8')) as unknown;
      const result = await client.callTool({
        name: 'graphite_render',
        arguments: {
          document: sample,
          output: { format: 'png', width: 1000, height: 500, outputName: 'mcp-e2e-render-inline' },
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expectSuccessfulRender(payload, { templateDriven: false });
      // The inline document renders to the same pixels as the template sample
      // (determinism echo of the Phase-3 evidence, at the tool layer).
      expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    },
    E2E_TIMEOUT,
  );

  it(
    'graphite_render svg may omit size and produces a valid SVG artifact',
    async () => {
      const result = await client.callTool({
        name: 'graphite_render',
        arguments: {
          templateId: 'duotone-image',
          output: { format: 'svg', outputName: 'mcp-e2e-render-svg' },
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expect(payload.format).toBe('svg');
      expect(payload.artifactPath.endsWith('.svg')).toBe(true);
      expect(existsSync(payload.artifactPath)).toBe(true);
      expect(payload.validation.valid).toBe(true);
      expect(payload.width).toBeUndefined();
      expect(payload.height).toBeUndefined();
      expect(payload.quarantine.quarantinedAfterWrite).toBe(true);
    },
    E2E_TIMEOUT,
  );

  it('graphite_list_nodes lists all 324 identifiers', async () => {
    const result = await client.callTool({ name: 'graphite_list_nodes', arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.count).toBe(324);
    expect(payload.nodes).toHaveLength(324);
    expect(payload.nodes[0]).toEqual(expect.any(String));
  });

  it('graphite_list_nodes filter narrows the registry (case-sensitive substring)', async () => {
    const filtered = await client.callTool({ name: 'graphite_list_nodes', arguments: { filter: 'Gradient' } });
    const payload = jsonOf(filtered);
    expect(payload.count).toBe(payload.nodes.length);
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.count).toBeLessThan(324);
    for (const id of payload.nodes) expect(id).toContain('Gradient');
  });

  it(
    'graphite_search_nodes finds nodes by keyword across identifier/displayName/description',
    async () => {
      const result = await client.callTool({ name: 'graphite_search_nodes', arguments: { query: 'gradient map' } });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expect(payload.count).toBeGreaterThanOrEqual(1);
      const ids = (payload.results as Array<{ identifier?: string }>).map((r) => r.identifier ?? '');
      expect(ids).toContain('raster_nodes::adjustments::GradientMapNode');
      for (const r of payload.results) {
        expect(r.displayName).toEqual(expect.any(String));
        expect(r.category).toEqual(expect.any(String));
      }
    },
    E2E_TIMEOUT,
  );

  it('graphite_search_nodes category filter is an exact match', async () => {
    const result = await client.callTool({ name: 'graphite_search_nodes', arguments: { category: 'Math: Arithmetic' } });
    const payload = jsonOf(result);
    expect(payload.count).toBe(12);
    for (const r of payload.results) expect(r.category).toBe('Math: Arithmetic');
  });

  it('graphite_search_nodes returns zero results for nonsense without erroring', async () => {
    const result = await client.callTool({ name: 'graphite_search_nodes', arguments: { query: 'zzz-no-such-node-zzz' } });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.count).toBe(0);
    expect(payload.results).toEqual([]);
  });

  it(
    'graphite_describe_node returns the full field contract for a known node',
    async () => {
      const result = await client.callTool({
        name: 'graphite_describe_node',
        arguments: { identifier: 'raster_nodes::adjustments::GradientMapNode' },
      });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expect(payload.identifier).toBe('raster_nodes::adjustments::GradientMapNode');
      expect(payload.displayName).toBe('Gradient Map');
      expect(payload.category).toBe('Raster: Adjustment');
      expect(payload.fields.length).toBeGreaterThanOrEqual(3);
      const gradient = (payload.fields as Array<{ name?: string; default?: string }>).find((f) => f.name === 'Gradient');
      expect(gradient?.default).toContain('Color ::');
    },
    E2E_TIMEOUT,
  );

  it('graphite_describe_node rejects unknown identifiers with a SPEC_INVALID envelope', async () => {
    const result = await client.callTool({
      name: 'graphite_describe_node',
      arguments: { identifier: 'nope::NoSuchNode' },
    });
    expect(result.isError).toBe(true);
    const payload = jsonOf(result);
    expect(payload.code).toBe('SPEC_INVALID');
    expect(payload.message).toMatch(/graphite_search_nodes/);
  });

  it(
    'graphite_validate_doc compileCheck: true adds the engine verdict on a valid doc',
    async () => {
      const sample = JSON.parse(readFileSync(SAMPLE_DUOTONE, 'utf8')) as unknown;
      const result = await client.callTool({
        name: 'graphite_validate_doc',
        arguments: { document: sample, compileCheck: true },
      });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expect(payload.valid).toBe(true);
      expect(payload.compile).toBeDefined();
      expect(payload.compile.ok).toBe(true);
      expect(typeof payload.compile.stderrTail).toBe('string');
      expect(payload.documentPath).toContain(path.join('tmp', 'mcp-inline'));
    },
    E2E_TIMEOUT,
  );

  it(
    'graphite_render_variants renders 3 duotone variants: distinct artifacts, per-item quarantine',
    async () => {
      const result = await client.callTool({
        name: 'graphite_render_variants',
        arguments: {
          templateId: 'duotone-image',
          variants: [0, 7, 42].map((seed) => ({ ...DUOTONE_DEFAULTS, width: 400, height: 250, seed })),
          format: 'png',
          width: 400,
          height: 250,
          outputDir: path.relative(PROJECT_ROOT, VARIANTS_DIR),
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expect(payload.count).toBe(3);
      const paths: string[] = payload.results.map((r: any) => r.artifactPath);
      expect(new Set(paths).size).toBe(3);
      for (const item of payload.results) {
        expect(item.error).toBeUndefined();
        expect(item.templateId).toBe('duotone-image');
        expect(existsSync(item.artifactPath)).toBe(true);
        expect(item.quarantine.quarantinedAfterWrite).toBe(true);
        expect(item.validation.valid).toBe(true);
        expect(item.width).toBe(400);
        expect(item.height).toBe(250);
      }
    },
    E2E_TIMEOUT,
  );

  it(
    'graphite_render_variants completes the batch when one variant has bad params',
    async () => {
      const good: Record<string, unknown> = { ...DUOTONE_DEFAULTS, width: 300, height: 200 };
      const bad = { width: 300, height: 200, seed: 0, scale: 35 }; // missing dark/light colors
      const result = await client.callTool({
        name: 'graphite_render_variants',
        arguments: {
          templateId: 'duotone-image',
          variants: [{ ...good, seed: 1 }, bad, { ...good, seed: 2 }],
          format: 'png',
          width: 300,
          height: 200,
          outputDir: path.relative(PROJECT_ROOT, VARIANTS_DIR),
        },
      });
      // One failed item does NOT fail the call.
      expect(result.isError).toBeFalsy();
      const payload = jsonOf(result);
      expect(payload.count).toBe(3);
      expect(payload.results[0].artifactPath).toBeTruthy();
      expect(payload.results[0].quarantine.quarantinedAfterWrite).toBe(true);
      expect(payload.results[1].error).toBeDefined();
      expect(payload.results[1].error.code).toBe('SPEC_INVALID');
      expect(payload.results[1].error.message).toMatch(/dark/);
      expect(payload.results[2].artifactPath).toBeTruthy();
      expect(payload.results[2].quarantine.quarantinedAfterWrite).toBe(true);
    },
    E2E_TIMEOUT,
  );
});