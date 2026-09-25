/**
 * Typed error taxonomy for the Graphite boundary.
 *
 * Doctrine: this server "exists to be boring" — every failure is a precise,
 * actionable message. Errors always carry structured fields (exit codes,
 * stderr tails, paths, reasons) so callers (MCP tools, logs) can render exact
 * diagnostics without string-scraping.
 */

/** Base class for every error this package throws. */
export class GraphiteError extends Error {
  /** Stable machine-readable code, e.g. "CLI_NOT_FOUND". */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export interface CliNotFoundErrorFields {
  /** Every candidate path that was checked. */
  searchedPaths: readonly string[];
  /** Precise reason the resolution failed. */
  reason: string;
}

/** The graphene-cli binary could not be resolved to an executable file. */
export class CliNotFoundError extends GraphiteError {
  readonly searchedPaths: readonly string[];

  constructor(fields: CliNotFoundErrorFields) {
    const searched =
      fields.searchedPaths.length > 0
        ? `Searched: ${fields.searchedPaths.map((p) => `"${p}"`).join(', ')}.`
        : 'No candidate paths were searched.';
    super(
      `${fields.reason}\n` +
        `  ${searched}\n` +
        `  Fix: set GRAPHITE_CLI_PATH to an existing, executable graphene-cli binary ` +
        `(pinned debug build: <projectRoot>/engine/Graphite/target/debug/graphene-cli).`,
      'CLI_NOT_FOUND',
    );
    this.searchedPaths = fields.searchedPaths;
  }
}

export interface DocInvalidErrorFields {
  documentPath: string;
  /** Precise complaint, e.g. "document file does not exist". */
  detail: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
}

/** graphene-cli refused the document (compile failed) or it cannot be read. */
export class DocInvalidError extends GraphiteError {
  readonly documentPath: string;
  readonly detail: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;

  constructor(fields: DocInvalidErrorFields) {
    const how = fields.signal
      ? `graphene-cli crashed with signal ${fields.signal}`
      : fields.exitCode != null
        ? `graphene-cli exited with code ${fields.exitCode}`
        : 'graphene-cli was not run';
    const tail = fields.stderrTail ? `\n  stderr tail:\n${indent(fields.stderrTail)}` : '';
    super(
      `Document cannot be rendered: "${fields.documentPath}" — ${fields.detail}.\n` +
        `  ${how}. For the engine's own diagnostic, run its validation pass:\n` +
        `    graphene-cli compile "${fields.documentPath}"${tail}`,
      'DOC_INVALID',
    );
    this.documentPath = fields.documentPath;
    this.detail = fields.detail;
    this.exitCode = fields.exitCode ?? null;
    this.signal = fields.signal ?? null;
    this.stderrTail = fields.stderrTail ?? '';
  }
}

export interface RenderErrorFields {
  command: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutTail?: string;
  stderrTail?: string;
  /** Extra context, e.g. that an artifact exists and passed validation anyway. */
  note?: string;
}

/** The render process failed in a way that is NOT the SIGSEGV-after-write case. */
export class RenderError extends GraphiteError {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly note: string;

  constructor(fields: RenderErrorFields) {
    const how = fields.signal
      ? `killed by signal ${fields.signal}`
      : `exited with code ${fields.exitCode ?? 'unknown'}`;
    const note = fields.note ? `\n  Note: ${fields.note}` : '';
    const tail = fields.stderrTail ? `\n  stderr tail:\n${indent(fields.stderrTail)}` : '';
    super(
      `Render failed: graphene-cli ${how}.\n` +
        `  Command: ${fields.command}${note}${tail}`,
      'RENDER_FAILED',
    );
    this.command = fields.command;
    this.exitCode = fields.exitCode ?? null;
    this.signal = fields.signal ?? null;
    this.stdoutTail = fields.stdoutTail ?? '';
    this.stderrTail = fields.stderrTail ?? '';
    this.note = fields.note ?? '';
  }
}

export interface ArtifactInvalidErrorFields {
  artifactPath: string;
  /** Precise validation failure, e.g. "missing PNG signature (expected 89 50 4E 47 ...)". */
  reason: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
}

/**
 * The CLI produced (or claimed to produce) an artifact that failed validation.
 * Never trust exit codes alone: this error exists so a crashed-but-broken
 * write can never be mistaken for a success.
 */
export class ArtifactInvalidError extends GraphiteError {
  readonly artifactPath: string;
  readonly reason: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;

  constructor(fields: ArtifactInvalidErrorFields) {
    const tail = fields.stderrTail ? `\n  stderr tail:\n${indent(fields.stderrTail)}` : '';
    super(
      `Artifact failed validation: "${fields.artifactPath}".\n` +
        `  Reason: ${fields.reason}${tail}`,
      'ARTIFACT_INVALID',
    );
    this.artifactPath = fields.artifactPath;
    this.reason = fields.reason;
    this.exitCode = fields.exitCode ?? null;
    this.signal = fields.signal ?? null;
    this.stderrTail = fields.stderrTail ?? '';
  }
}

export interface TimeoutErrorFields {
  command: string;
  timeoutMs: number;
  stderrTail?: string;
}

/** The render exceeded its time budget and the process was killed (SIGKILL). */
export class TimeoutError extends GraphiteError {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(fields: TimeoutErrorFields) {
    const tail = fields.stderrTail ? `\n  stderr tail so far:\n${indent(fields.stderrTail)}` : '';
    super(
      `Timed out: graphene-cli did not finish within ${fields.timeoutMs}ms and was killed (SIGKILL).\n` +
        `  Command: ${fields.command}\n` +
        `  Fix: if this document genuinely needs longer, raise timeoutMs on GraphiteRunner (default 120000).${tail}`,
      'TIMEOUT',
    );
    this.command = fields.command;
    this.timeoutMs = fields.timeoutMs;
  }
}

/**
 * A RenderSpec (or CLI-path request) is malformed before any process runs:
 * unsupported output extension, missing/incomplete size, bad GIF timing, etc.
 */
export class SpecInvalidError extends GraphiteError {
  constructor(message: string) {
    super(message, 'SPEC_INVALID');
  }
}