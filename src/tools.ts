/**
 * The four Graphite MCP tools: input schemas, handlers, and the shared
 * render/validate pipeline.
 *
 * Doctrine (brief): this server "exists to be boring" — every call returns a
 * validated artifact or a precise error. Concretely:
 *   - success  -> one text content block: pretty JSON with full provenance
 *                 (artifactPath, sha256, validation, quarantine metadata);
 *   - failure  -> isError: true + one text content block: a JSON envelope with
 *                 the stable GraphiteError code, the message, and every
 *                 diagnostic field the error carries (stderr tails, exit
 *                 codes, paths). Unexpected (non-GraphiteError) failures get
 *                 code "UNEXPECTED" and never leak stack traces.
 *
 * Input validation happens twice by design:
 *   1. The schemas advertised to the MCP SDK (`registerTool` inputSchema)
 *      reject malformed TYPES at the protocol level (precise -32602 result).
 *   2. Each handler re-parses with a superset schema that adds the CROSS-FIELD
 *      rules (templateId XOR document, raster size completeness, variant
 *      bounds) and maps every violation to a SPEC_INVALID envelope carrying
 *      the stable "SPEC_INVALID" code.
 *
 * v1 CONCURRENCY: every handler runs sequentially (no parallel graphene-cli
 * spawns — one GPU-heavy child at a time). graphite_render_variants renders
 * its variants in a plain for-loop.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GraphiteError, SpecInvalidError } from './errors.js';
import { buildDocument, writeDocument } from './builder.js';
import { resolveProjectRoot } from './paths.js';
import { GraphiteRunner } from './runner.js';
import { validateArtifact } from './validator.js';
import type {
  ArtifactResult,
  GifTiming,
  NodeMetadataRecord,
  OutputFormat,
  QuarantineInfo,
  RenderSpec,
  ValidationResult,
} from './types.js';
import { DEFAULT_PARAMS, TEMPLATE_IDS, type TemplateId } from './templates.js';

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Serializes any thrown value into the stable error envelope. GraphiteError
 * subclasses contribute every own diagnostic field (documentPath, exitCode,
 * signal, stderrTail, artifactPath, reason, command, timeoutMs, ...);
 * anything unexpected becomes code "UNEXPECTED" with its message only —
 * never a stack trace.
 */
export function errorEnvelope(err: unknown): { code: string; message: string; [key: string]: unknown } {
  if (err instanceof GraphiteError) {
    const envelope: Record<string, unknown> = { code: err.code, message: err.message };
    for (const [key, value] of Object.entries(err)) {
      if (key === 'code') continue; // already carried as the stable code
      envelope[key] = value;
    }
    return envelope as { code: string; message: string; [key: string]: unknown };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'UNEXPECTED', message };
}

function errorResult(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(errorEnvelope(err), null, 2) }],
  };
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return typeof value;
}

/**
 * Handler-level input parse: maps zod failures to the stable SPEC_INVALID
 * envelope (bounds like "2..20 variants" are semantic rules, reported as
 * data-code-carrying results, not raw protocol errors).
 */
function parseInput<Schema extends z.ZodType>(schema: Schema, args: unknown): z.output<Schema> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SpecInvalidError(`invalid input: ${issues}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const GifTimingSchema = z.union([
  z.strictObject({ mode: z.literal('frames'), fps: z.number().positive(), frames: z.number().int().positive() }),
  z.strictObject({ mode: z.literal('duration'), duration: z.number().positive() }),
]);

/**
 * The `output` block. Strict: unknown keys are rejected up front. `width`/
 * `height` are optional HERE (SVG may omit them); the cross-field raster rule
 * (both required together) is enforced in the handler with a precise
 * SPEC_INVALID message.
 */
const OutputSpecSchema = z.strictObject({
  format: z.enum(['png', 'svg', 'jpg', 'gif']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Base file name WITHOUT extension — the format extension is appended. */
  outputName: z.string().optional(),
  /** Required for .gif output; passed through to the CLI. */
  gif: GifTimingSchema.optional(),
});

const DocumentSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const RENDER_INPUT_SCHEMA = {
  templateId: z.string().optional(),
  params: z.unknown().optional(),
  document: DocumentSchema.optional(),
  output: OutputSpecSchema,
} as const;

const RenderInputSchema = z.strictObject({
  templateId: z.string().optional(),
  params: z.unknown().optional(),
  document: DocumentSchema.optional(),
  output: OutputSpecSchema,
});

const LIST_NODES_INPUT_SCHEMA = {
  filter: z.string().optional(),
} as const;

const ListNodesInputSchema = z.strictObject({ filter: z.string().optional() });

const SEARCH_NODES_INPUT_SCHEMA = {
  /** Case-insensitive substring matched against identifier, display name, and description. */
  query: z.string().optional(),
  /** Exact-match filter on the registry's category (e.g. "Gradient", "Math: Arithmetic"). */
  category: z.string().optional(),
} as const;

const SearchNodesInputSchema = z.strictObject({ query: z.string().optional(), category: z.string().optional() });

const DESCRIBE_NODE_INPUT_SCHEMA = {
  /** Full node identifier, e.g. "raster_nodes::adjustments::GradientMapNode". graphite_search_nodes returns these. */
  identifier: z.string(),
} as const;

const DescribeNodeInputSchema = z.strictObject({ identifier: z.string() });

const VALIDATE_DOC_INPUT_SCHEMA = {
  /** Inline legacy .graphite JSON (raw JSON string or parsed object). */
  document: DocumentSchema.optional(),
  /** Path to an existing .graphite file on disk. */
  documentPath: z.string().optional(),
  /** Run the engine's own `compile` pass (default false — fast and offline). */
  compileCheck: z.boolean().optional(),
} as const;

const ValidateDocInputSchema = z.strictObject({
  document: DocumentSchema.optional(),
  documentPath: z.string().optional(),
  compileCheck: z.boolean().optional(),
});

const VARIANTS_INPUT_SCHEMA = {
  templateId: z.string(),
  /** 2..20 full param objects (bounds enforced in the handler). */
  variants: z.array(z.unknown()),
  format: z.enum(['png', 'svg', 'jpg', 'gif']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  outputDir: z.string().optional(),
} as const;

const VariantsInputSchema = z.strictObject({
  templateId: z.string(),
  variants: z.array(z.unknown()).min(2).max(20),
  format: z.enum(['png', 'svg', 'jpg', 'gif']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  outputDir: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

const FORMAT_EXTENSIONS: Record<OutputFormat, string> = {
  png: '.png',
  svg: '.svg',
  jpg: '.jpg',
  gif: '.gif',
};

/** Artifact extensions an outputName must NOT already end in (see README). */
const ARTIFACT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];

/** Lazily constructed runner; a failed construction is retried per call. */
let runnerInstance: GraphiteRunner | null = null;

function getRunner(): GraphiteRunner {
  if (runnerInstance) return runnerInstance;
  try {
    runnerInstance = new GraphiteRunner();
  } catch (err) {
    runnerInstance = null; // never memoize a failure — the next call retries
    throw err;
  }
  return runnerInstance;
}

/** Process-lifetime cache of the unfiltered node identifier list. */
let cachedNodeIdentifiers: string[] | null = null;

/** Process-lifetime cache of the full node-metadata dump. */
let cachedNodeMetadata: NodeMetadataRecord[] | null = null;

/** Loads (and caches) the full node-metadata registry via the runner. */
async function loadNodeMetadata(): Promise<NodeMetadataRecord[]> {
  if (cachedNodeMetadata === null) {
    const result = await getRunner().dumpNodeMetadata();
    cachedNodeMetadata = result.nodes;
  }
  return cachedNodeMetadata;
}

/** Where inline documents are materialized before render/compile. */
function inlineDocPath(kind: 'render' | 'validate'): string {
  return path.join(resolveProjectRoot(), 'tmp', 'mcp-inline', `${kind}-${randomUUID()}.graphite`);
}

/**
 * Materializes a document object as a .graphite file under tmp/mcp-inline/.
 * Files are kept (tmp/ is gitignored) so error messages always point at a
 * document that still exists for debugging.
 */
async function materializeInlineDocument(document: unknown, kind: 'render' | 'validate'): Promise<string> {
  return writeDocument(inlineDocPath(kind), document as Parameters<typeof writeDocument>[1]);
}

/**
 * Validates the size rule: raster formats need BOTH width and height (the
 * width-only request makes graphene-cli silently render a 1x1 default
 * viewport, so it is rejected outright); SVG may omit both but may not carry
 * exactly one. Returns an empty object for "no size".
 */
function resolveSize(
  format: OutputFormat,
  width: number | undefined,
  height: number | undefined,
): { width?: number; height?: number } {
  if (format === 'svg') {
    if ((width === undefined) !== (height === undefined)) {
      throw new SpecInvalidError(
        `output format "svg" needs BOTH width and height, or NEITHER (got width=${describe(width)}, height=${describe(height)}).`,
      );
    }
    return width !== undefined && height !== undefined ? { width, height } : {};
  }
  if (width === undefined || height === undefined) {
    throw new SpecInvalidError(
      `output format "${format}" requires an explicit size: provide width AND height with BOTH dimensions ` +
        `(got width=${describe(width)}, height=${describe(height)}). ` +
        `Rationale: graphene-cli silently falls back to a 1x1 default viewport when a dimension is missing, ` +
        `so Graphite rejects incomplete sizes outright. (SVG is the only format that may omit size.)`,
    );
  }
  return { width, height };
}

/**
 * Decides which document source the input carries and validates the XOR:
 *   { templateId, params? } (params default to the template's DEFAULT_PARAMS)
 *   OR { document } (inline legacy .graphite JSON).
 */
function resolveDocumentSource(
  input: { templateId?: string; params?: unknown; document?: unknown },
): { document: unknown; templateId?: TemplateId; params?: unknown } {
  if (input.templateId !== undefined && input.document !== undefined) {
    throw new SpecInvalidError(
      'provide EITHER { templateId, params? } OR { document } — passing both is ambiguous.',
    );
  }
  if (input.templateId !== undefined) {
    const params = input.params ?? DEFAULT_PARAMS[input.templateId as TemplateId];
    const built = buildDocument(input.templateId, params);
    return { document: built.document, templateId: built.templateId, params: built.params };
  }
  if (input.document !== undefined) {
    const raw = input.document;
    if (typeof raw === 'string') {
      try {
        return { document: JSON.parse(raw) as unknown };
      } catch (err) {
        throw new SpecInvalidError(
          `document string is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { document: raw };
  }
  throw new SpecInvalidError(
    `provide EITHER { templateId, params? } (params default to the template's DEFAULT_PARAMS) ` +
      `OR { document } (inline legacy .graphite JSON) — neither was given.`,
  );
}

/**
 * The exact artifact path the CLI is expected to write for a requested
 * format. outputName is a base name (no extension); the format extension is
 * appended. Falls back to a timestamped, collision-safe name.
 */
function resolveOutputArtifactPath(
  format: OutputFormat,
  outputName: string | undefined,
  fallbackPrefix: string,
): string {
  const ext = FORMAT_EXTENSIONS[format];
  let base: string;
  if (outputName !== undefined) {
    if (outputName.trim().length === 0) {
      throw new SpecInvalidError('output.outputName must be a non-empty base name without a format extension.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(outputName)) {
      throw new SpecInvalidError(
        `output.outputName must be a plain base name ([A-Za-z0-9._-], no path separators) — got "${outputName}". ` +
          `The format extension is appended automatically.`,
      );
    }
    const lower = outputName.toLowerCase();
    const conflicting = ARTIFACT_EXTENSIONS.find((e) => lower.endsWith(e));
    if (conflicting !== undefined) {
      throw new SpecInvalidError(
        `output.outputName must be a base name WITHOUT a format extension (got "${outputName}"). ` +
          `Use "${outputName.slice(0, -conflicting.length)}" and set output.format — the extension is appended automatically.`,
      );
    }
    return path.join(resolveProjectRoot(), 'exports', `${outputName}${ext}`);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(resolveProjectRoot(), 'exports', `${fallbackPrefix}-${timestamp}-${randomUUID().slice(0, 8)}${ext}`);
}

/** sha256 of the rendered artifact (determinism / integrity evidence). */
async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/** The result payload of a successful render — same shape everywhere. */
interface RenderToolResult {
  artifactPath: string;
  format: OutputFormat;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
  validation: ValidationResult;
  /** ALWAYS present; with the pinned CLI quarantinedAfterWrite is always true. */
  quarantine: QuarantineInfo;
  renderMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  command: string;
  documentPath: string;
  templateId?: string;
  params?: unknown;
}

/**
 * Builds the canonical tool result from a validated render. Quarantine
 * metadata is ALWAYS present: with the pinned CLI every successful export
 * SIGSEGVs after the write (quarantinedAfterWrite: true — normal, expected);
 * a clean-exit render (synthetic CLIs, future engine builds) reports
 * quarantinedAfterWrite: false.
 */
function buildRenderResult(
  artifact: ArtifactResult,
  validation: ValidationResult,
  sha256: string,
  documentPath: string,
  provenance: { templateId?: string; params?: unknown } = {},
): RenderToolResult {
  const quarantine: QuarantineInfo = artifact.quarantine
    ? { ...artifact.quarantine, quarantinedAfterWrite: true }
    : { exitCode: artifact.exitCode, signal: artifact.signal, quarantinedAfterWrite: false, stderrTail: artifact.stderrTail };
  const width = validation.width ?? artifact.width;
  const height = validation.height ?? artifact.height;
  return {
    artifactPath: path.resolve(artifact.output),
    format: artifact.format,
    byteSize: artifact.byteSize,
    sha256,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    validation,
    quarantine,
    renderMs: artifact.durationMs,
    exitCode: artifact.exitCode,
    signal: artifact.signal,
    command: artifact.command,
    documentPath,
    ...provenance,
  };
}

/** Renders one document+output spec through the runner and reports the result. */
async function renderAndReport(spec: RenderSpec, documentPath: string, provenance: { templateId?: string; params?: unknown } = {}): Promise<RenderToolResult> {
  const artifact = await getRunner().render(spec);
  // Fresh, canonical validation result for the payload (the runner has
  // already gated success on this — this is the reported evidence).
  const validation = await validateArtifact(spec.output, artifact.format);
  return buildRenderResult(artifact, validation, await sha256File(spec.output), documentPath, provenance);
}

// ---------------------------------------------------------------------------
// Tool: graphite_render
// ---------------------------------------------------------------------------

async function handleRender(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(RenderInputSchema, args);

    // Cheap, precise checks BEFORE spending any CLI spawn.
    const source = resolveDocumentSource(input);
    const size = resolveSize(input.output.format, input.output.width, input.output.height);
    const documentPath = await materializeInlineDocument(source.document, 'render');
    const artifactPath = resolveOutputArtifactPath(
      input.output.format,
      input.output.outputName,
      source.templateId ?? 'render',
    );

    const spec: RenderSpec = {
      document: documentPath,
      output: artifactPath,
      ...(size.width !== undefined ? { size: { width: size.width, height: size.height as number } } : {}),
      ...(input.output.gif !== undefined ? { gif: input.output.gif as GifTiming } : {}),
    };
    const result = await renderAndReport(spec, documentPath, {
      ...(source.templateId !== undefined ? { templateId: source.templateId, params: source.params } : {}),
    });
    return textResult(result);
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Tool: graphite_list_nodes
// ---------------------------------------------------------------------------

async function handleListNodes(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(ListNodesInputSchema, args);
    if (cachedNodeIdentifiers === null) {
      const result = await getRunner().listNodeIdentifiers();
      cachedNodeIdentifiers = result.identifiers;
    }
    const nodes =
      input.filter === undefined
        ? cachedNodeIdentifiers
        : cachedNodeIdentifiers.filter((id) => id.includes(input.filter as string));
    return textResult({ count: nodes.length, nodes });
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Tool: graphite_search_nodes
// ---------------------------------------------------------------------------

async function handleSearchNodes(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(SearchNodesInputSchema, args);
    const nodes = await loadNodeMetadata();
    const query = input.query?.toLowerCase();
    const category = input.category;
    const matches = nodes.filter((node) => {
      if (category !== undefined && node.category !== category) return false;
      if (query === undefined) return true;
      const haystack = `${node.identifier} ${node.displayName} ${node.description}`.toLowerCase();
      return haystack.includes(query);
    });
    const results = matches.map((node) => ({
      identifier: node.identifier,
      displayName: node.displayName,
      category: node.category,
      description: node.description.trim(),
    }));
    return textResult({
      count: results.length,
      results,
      hint: 'Pass an identifier to graphite_describe_node for input types, defaults, and ranges.',
    });
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Tool: graphite_describe_node
// ---------------------------------------------------------------------------

async function handleDescribeNode(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(DescribeNodeInputSchema, args);
    const nodes = await loadNodeMetadata();
    const node = nodes.find((candidate) => candidate.identifier === input.identifier);
    if (node === undefined) {
      throw new SpecInvalidError(
        `Unknown node identifier: ${input.identifier}. Use graphite_search_nodes to discover valid identifiers.`,
      );
    }
    return textResult(node);
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Tool: graphite_validate_doc
// ---------------------------------------------------------------------------

interface StructuralChecks {
  parsed: boolean;
  hasNetworkInterface: boolean;
  hasNetwork: boolean;
  hasNodesArray: boolean;
  hasExportsArray: boolean;
  nodeEntriesWellFormed: boolean;
  exportsResolveToNodes: boolean;
}

interface StructuralReport {
  checks: StructuralChecks;
  nodeCount: number;
  reasons: string[];
}

function allChecksFalse(): StructuralChecks {
  return {
    parsed: false,
    hasNetworkInterface: false,
    hasNetwork: false,
    hasNodesArray: false,
    hasExportsArray: false,
    nodeEntriesWellFormed: false,
    exportsResolveToNodes: false,
  };
}

/**
 * Structural validation of a parsed document object (pure — no fs, no CLI).
 * Checks: network_interface.network.nodes/exports present, node entries
 * shaped [id, {inputs, ...}] with unique integer ids, and every export
 * referencing an existing node id. Failures accumulate as precise reasons.
 */
function inspectStructure(document: unknown): StructuralReport {
  const checks: StructuralChecks = {
    parsed: false,
    hasNetworkInterface: false,
    hasNetwork: false,
    hasNodesArray: false,
    hasExportsArray: false,
    nodeEntriesWellFormed: false,
    exportsResolveToNodes: false,
  };
  const reasons: string[] = [];
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    reasons.push(`document is not a JSON object (got ${describe(document)})`);
    return { checks, nodeCount: 0, reasons };
  }
  checks.parsed = true;
  const doc = document as Record<string, unknown>;

  const networkInterface = doc.network_interface;
  if (typeof networkInterface !== 'object' || networkInterface === null) {
    reasons.push('missing "network_interface"');
    return { checks, nodeCount: 0, reasons };
  }
  checks.hasNetworkInterface = true;

  const network = (networkInterface as Record<string, unknown>).network;
  if (typeof network !== 'object' || network === null) {
    reasons.push('missing "network_interface.network"');
    return { checks, nodeCount: 0, reasons };
  }
  checks.hasNetwork = true;
  const net = network as Record<string, unknown>;

  const nodes = net.nodes;
  if (!Array.isArray(nodes)) {
    reasons.push(`"network_interface.network.nodes" is not an array (got ${describe(nodes)})`);
    return { checks, nodeCount: 0, reasons };
  }
  checks.hasNodesArray = true;

  const exportList = net.exports;
  if (!Array.isArray(exportList)) {
    reasons.push(`"network_interface.network.exports" is not an array (got ${describe(exportList)})`);
    return { checks, nodeCount: 0, reasons };
  }
  checks.hasExportsArray = true;

  // Node entries must be [id, entry] tuples: numeric unique id, object body
  // with an inputs array.
  const seenIds = new Set<number>();
  let wellFormed = true;
  for (const entry of nodes) {
    if (!Array.isArray(entry) || entry.length < 2) {
      reasons.push(`node entry is not an [id, entry] tuple: ${safeJson(entry)}`);
      wellFormed = false;
      continue;
    }
    const [id, nodeEntry] = entry as [unknown, unknown];
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      reasons.push(`node id is not an integer: ${describe(id)}`);
      wellFormed = false;
      continue;
    }
    if (seenIds.has(id)) {
      reasons.push(`duplicate node id ${id}`);
      wellFormed = false;
      continue;
    }
    seenIds.add(id);
    if (typeof nodeEntry !== 'object' || nodeEntry === null) {
      reasons.push(`node ${id} has no object entry`);
      wellFormed = false;
      continue;
    }
    if (!Array.isArray((nodeEntry as Record<string, unknown>).inputs)) {
      reasons.push(`node ${id} is missing an "inputs" array`);
      wellFormed = false;
    }
  }
  checks.nodeEntriesWellFormed = wellFormed;

  // Top-level exports must reference existing node ids.
  let exportsOk = true;
  for (const exp of exportList) {
    const nodeId = nodeRefId(exp);
    if (nodeId === null) {
      reasons.push(`export is not a { Node: { node_id, output_index } } reference: ${safeJson(exp)}`);
      exportsOk = false;
      continue;
    }
    if (!seenIds.has(nodeId)) {
      reasons.push(`export references node id ${nodeId}, which does not exist in network.nodes`);
      exportsOk = false;
    }
  }
  checks.exportsResolveToNodes = exportsOk;

  return { checks, nodeCount: nodes.length, reasons };
}

function nodeRefId(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const node = (value as Record<string, unknown>).Node;
  if (typeof node !== 'object' || node === null) return null;
  const nodeId = (node as Record<string, unknown>).node_id;
  if (typeof nodeId !== 'number' || !Number.isInteger(nodeId)) return null;
  return nodeId;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function invalidDocResult(reasons: string[]): CallToolResult {
  return textResult({
    valid: false,
    structural: { checks: allChecksFalse(), nodeCount: 0, reasons },
  });
}

async function handleValidateDoc(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(ValidateDocInputSchema, args);
    const hasDocument = input.document !== undefined;
    const hasDocumentPath = input.documentPath !== undefined;
    if (hasDocument === hasDocumentPath) {
      throw new SpecInvalidError(
        hasDocument
          ? 'provide EITHER { document } (inline) OR { documentPath } — passing both is ambiguous.'
          : 'provide EITHER { document } (inline legacy .graphite JSON) OR { documentPath } — neither was given.',
      );
    }

    let document: unknown;
    let documentPath: string | undefined = input.documentPath !== undefined ? path.resolve(input.documentPath) : undefined;

    if (hasDocument) {
      const raw = input.document;
      if (typeof raw === 'string') {
        try {
          document = JSON.parse(raw) as unknown;
        } catch (err) {
          return invalidDocResult([`document string is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
        }
      } else {
        document = raw;
      }
    } else {
      let text: string;
      try {
        text = await readFile(documentPath as string, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        return invalidDocResult([
          code === 'ENOENT'
            ? `document file does not exist: "${documentPath}"`
            : `document file is not readable ("${documentPath}"): ${code ?? String(err)}`,
        ]);
      }
      try {
        document = JSON.parse(text) as unknown;
      } catch (err) {
        return invalidDocResult([
          `document file "${documentPath}" does not contain valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ]);
      }
    }

    const structure = inspectStructure(document);
    const structuralValid = Object.values(structure.checks).every(Boolean) && structure.reasons.length === 0;

    let compile: { ok: boolean; stderrTail: string; reason?: string } | undefined;
    if (input.compileCheck === true) {
      if (!structuralValid) {
        compile = { ok: false, stderrTail: '', reason: 'not run: structural validation failed' };
      } else {
        const filePath = hasDocument ? await materializeInlineDocument(document, 'validate') : (documentPath as string);
        try {
          const compileResult = await getRunner().compile(filePath);
          compile = { ok: true, stderrTail: compileResult.stderr };
        } catch (err) {
          const envelope = errorEnvelope(err);
          compile = {
            ok: false,
            stderrTail: typeof envelope.stderrTail === 'string' ? envelope.stderrTail : '',
            ...(envelope.code !== 'DOC_INVALID' ? { reason: String(envelope.message) } : {}),
          };
        }
        documentPath = documentPath ?? filePath;
      }
    }

    const valid = structuralValid && (compile === undefined || compile.ok);
    return textResult({
      valid,
      structural: { checks: structure.checks, nodeCount: structure.nodeCount, reasons: structure.reasons },
      ...(compile !== undefined ? { compile } : {}),
      ...(documentPath !== undefined ? { documentPath } : {}),
    });
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Tool: graphite_render_variants
// ---------------------------------------------------------------------------

type VariantItem = RenderToolResult | { templateId: string; params: unknown; error: { code: string; message: string; [key: string]: unknown } };

async function handleRenderVariants(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(VariantsInputSchema, args);
    const { templateId, format, width, height } = input;
    // Relative outputDir resolves against the project root (consistent with
    // every other path this server derives).
    const outputDir = path.resolve(resolveProjectRoot(), input.outputDir ?? 'exports');
    const ext = FORMAT_EXTENSIONS[format];
    const runner = getRunner();

    const results: VariantItem[] = [];
    let failures = 0;

    // v1 doctrine: SEQUENTIAL renders — one GPU-heavy child at a time.
    for (let index = 0; index < input.variants.length; index += 1) {
      const params = input.variants[index];
      try {
        const built = buildDocument(templateId, params);
        const documentPath = await materializeInlineDocument(built.document, 'render');
        const artifactPath = path.join(outputDir, `${templateId}-${index}${ext}`);
        const result = await renderAndReport(
          { document: documentPath, output: artifactPath, size: { width, height } },
          documentPath,
          { templateId: built.templateId, params: built.params },
        );
        results.push(result);
      } catch (err) {
        failures += 1;
        results.push({ templateId, params, error: errorEnvelope(err) });
      }
    }

    const allFailed = failures === results.length;
    return textResult({ count: results.length, results }, allFailed);
  } catch (err) {
    return errorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the four Graphite tools on an MCP server. Exported separately
 * from createGraphiteServer so tests can mount the tool set on their own
 * server instances.
 */
export function registerGraphiteTools(server: McpServer): void {
  server.registerTool('graphite_render', {
    title: 'Graphite render',
    description:
      'Render a Graphite document to a validated artifact. Pass EITHER { templateId, params? } ' +
      `(params default to the template defaults; known templates: ${TEMPLATE_IDS.join(', ')}) ` +
      'OR { document } (inline legacy .graphite JSON, materialized under tmp/mcp-inline/). ' +
      'output: { format: png|svg|jpg|gif, width?, height?, outputName? } — raster formats require BOTH width and height; ' +
      'SVG may omit size; outputName is a base name (extension appended automatically). ' +
      'Artifacts land in <projectRoot>/exports/. Every success reports sha256, artifact validation, and quarantine ' +
      'metadata: the pinned CLI always exits SIGSEGV after writing, so quarantinedAfterWrite: true is normal and expected.',
    inputSchema: RENDER_INPUT_SCHEMA,
  }, handleRender);

  server.registerTool('graphite_list_nodes', {
    title: 'Graphite node registry',
    description:
      'List every node identifier the pinned graphene-cli understands (exits cleanly; cached in memory after the first call). ' +
      'Optional filter: case-sensitive substring match.',
    inputSchema: LIST_NODES_INPUT_SCHEMA,
  }, handleListNodes);

  server.registerTool('graphite_search_nodes', {
    title: 'Graphite node search',
    description:
      'Search the pinned engine\'s 324-node registry by keyword (matches identifier, display name, and description; ' +
      'case-insensitive) and/or exact category. Returns identifiers + summaries; pair with graphite_describe_node ' +
      'for input types, defaults, and ranges. Cached in memory after the first call.',
    inputSchema: SEARCH_NODES_INPUT_SCHEMA,
  }, handleSearchNodes);

  server.registerTool('graphite_describe_node', {
    title: 'Graphite node details',
    description:
      'Full metadata for ONE registry node: display name, category, description, and every input field with its type, ' +
      'default expression, soft/hard numeric ranges, step, and unit. The authoritative contract for authoring or ' +
      'wiring that node in a custom document.',
    inputSchema: DESCRIBE_NODE_INPUT_SCHEMA,
  }, handleDescribeNode);

  server.registerTool('graphite_validate_doc', {
    title: 'Graphite document validator',
    description:
      'Structurally validate a Graphite document WITHOUT rendering: JSON parse, network_interface shape, node-entry tuples, ' +
      'and export references. Pass EITHER { document } (inline) OR { documentPath }. Optional compileCheck: true adds the ' +
      "engine's own compile verdict (default false). Validation results are data: an invalid document returns valid: false " +
      'with precise reasons instead of an error.',
    inputSchema: VALIDATE_DOC_INPUT_SCHEMA,
  }, handleValidateDoc);

  server.registerTool('graphite_render_variants', {
    title: 'Graphite batch renderer',
    description:
      'Render 2..20 parametric variants of ONE template sequentially (one GPU-heavy child at a time). Each variant is a full ' +
      'params object; artifacts land as <templateId>-<index>.<format> under outputDir (default <projectRoot>/exports/). ' +
      'A failing variant is reported per-item and does NOT abort the batch; the call is an error only when every variant fails.',
    inputSchema: VARIANTS_INPUT_SCHEMA,
  }, handleRenderVariants);
}