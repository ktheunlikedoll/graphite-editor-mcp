/**
 * Process runner around the graphene-cli headless binary.
 *
 * EXIT-CODE DOCTRINE (measured ground truth, see TRIAL-FINDINGS.md in
 * graphite-eval): every successful export writes a complete, valid artifact
 * and THEN dies with SIGSEGV (exit 139). Exit codes are therefore never
 * trusted alone — the artifact is validated unconditionally, and abnormal
 * exits are quarantined, not fatal:
 *
 *   timeout                    -> child killed (SIGKILL) -> TimeoutError
 *   SIGSEGV / exit 139         -> validate artifact:
 *                                   valid   -> success + QuarantineInfo
 *                                   invalid -> ArtifactInvalidError
 *   exit 0                     -> validate artifact (unconditional):
 *                                   valid   -> success (no quarantine)
 *                                   invalid -> ArtifactInvalidError
 *   other nonzero exit/signal  -> RenderError (stdout/stderr tails attached)
 *
 * CONCURRENCY (v1): renders are expected to run SEQUENTIALLY. This module
 * does not enqueue or lock; the Phase 4 MCP server must serialize render tool
 * calls. Parallel graphene-cli spawns are untested and unsupported in v1.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync, type Stats } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  ArtifactInvalidError,
  CliNotFoundError,
  DocInvalidError,
  RenderError,
  SpecInvalidError,
  TimeoutError,
} from './errors.js';
import { resolveCliPath } from './paths.js';
import { formatFromOutputPath, validateArtifact } from './validator.js';
import type {
  ArtifactResult,
  CompileResult,
  DumpNodeMetadataResult,
  ListNodeIdentifiersResult,
  NodeMetadataRecord,
  OutputFormat,
  QuarantineInfo,
  RenderSpec,
  ValidationResult,
} from './types.js';

/** Default per-render timeout: 120 seconds. */
export const DEFAULT_RENDER_TIMEOUT_MS = 120_000;

/** How much stdout/stderr (tail) is kept on results and errors. */
export const OUTPUT_TAIL_BYTES = 8_192;

/** Hard cap per captured stream so a chatty CLI cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1_048_576;

export interface GraphiteRunnerOptions {
  /**
   * Explicit CLI path. Defaults to resolveCliPath() (GRAPHITE_CLI_PATH env
   * var when set, else the pinned debug build under the project root).
   */
  cliPath?: string;
  /** Per-render timeout in milliseconds. Default: 120000 (2 minutes). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Spec validation (pure — no fs, no spawn, fully unit-testable)
// ---------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return typeof value;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpecInvalidError(`${field} must be a non-empty string (got ${describeValue(value)})`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SpecInvalidError(
      `${field} must be a positive integer (got ${describeValue(value)}). ` +
        `Note: graphene-cli needs BOTH width and height; passing only one makes it silently render ` +
        `a 1x1 default viewport, so Graphite rejects incomplete sizes outright.`,
    );
  }
}

function assertPositiveNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SpecInvalidError(`${field} must be a positive, finite number (got ${describeValue(value)})`);
  }
}

/**
 * Assembles the argv for `graphene-cli export`. Pure function so the
 * arg-assembly invariants are unit-testable in isolation.
 *
 * Invariants (enforced here, tested in tests/runner.test.ts):
 *   - `--width` and `--height` are ALWAYS emitted together when a size is set.
 *   - raster formats (png/jpg/gif) refuse to render without an explicit size:
 *     the CLI's width-only fallback to a 1x1 viewport is unreachable here.
 *   - .gif requires gif timing; unsupported extensions are rejected up front.
 */
export function buildExportArgs(spec: RenderSpec): string[] {
  const format = formatFromOutputPath(spec.output); // SpecInvalidError on unsupported extension
  assertNonEmptyString(spec.document, 'spec.document');

  const args = ['export', spec.document, '--output', spec.output];

  if (format !== 'svg' && spec.size === undefined) {
    throw new SpecInvalidError(
      `output format "${format}" requires an explicit size: provide size: { width, height } with BOTH dimensions. ` +
        `Rationale: graphene-cli silently falls back to a 1x1 default viewport when dimensions are missing, ` +
        `and Graphite refuses to emit a bogus 1x1 artifact.`,
    );
  }
  if (spec.size !== undefined) {
    // Runtime re-check for JavaScript callers: width-only is unrepresentable
    // in TypeScript, but a hand-built object can still omit a dimension.
    assertPositiveInteger((spec.size as { width?: unknown }).width, 'spec.size.width');
    assertPositiveInteger((spec.size as { height?: unknown }).height, 'spec.size.height');
    args.push('--width', String(spec.size.width), '--height', String(spec.size.height));
  }

  if (spec.scale !== undefined) {
    assertPositiveNumber(spec.scale, 'spec.scale');
    args.push('--scale', String(spec.scale));
  }
  if (spec.transparent === true) {
    args.push('--transparent');
  }
  if (format === 'gif') {
    if (spec.gif === undefined) {
      throw new SpecInvalidError(
        `.gif output requires timing: gif: { mode: 'frames', fps, frames } or { mode: 'duration', duration }`,
      );
    }
    if (spec.gif.mode === 'frames') {
      assertPositiveNumber((spec.gif as { fps?: unknown }).fps, 'spec.gif.fps');
      assertPositiveInteger((spec.gif as { frames?: unknown }).frames, 'spec.gif.frames');
      args.push('--fps', String(spec.gif.fps), '--frames', String(spec.gif.frames));
    } else {
      assertPositiveNumber((spec.gif as { duration?: unknown }).duration, 'spec.gif.duration');
      args.push('--duration', String(spec.gif.duration));
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

function assertExecutableFile(cliPath: string): void {
  if (!existsSync(cliPath)) {
    throw new CliNotFoundError({ searchedPaths: [cliPath], reason: `no file exists at "${cliPath}"` });
  }
  if (!statSync(cliPath).isFile()) {
    throw new CliNotFoundError({ searchedPaths: [cliPath], reason: `"${cliPath}" is not a regular file` });
  }
  try {
    accessSync(cliPath, constants.X_OK);
  } catch {
    throw new CliNotFoundError({
      searchedPaths: [cliPath],
      reason: `"${cliPath}" exists but is not executable (missing execute permission)`,
    });
  }
}

function statSyncOrNull(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

interface CapturedOutput {
  write(chunk: Buffer): void;
  /** The (tail-capped) captured output as text. */
  text(): string;
  /** The complete captured output, uncapped (for structured parsing). */
  fullText(): string;
}

function captureOutput(): CapturedOutput {
  const chunks: Buffer[] = [];
  let total = 0;
  return {
    write(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      while (total > MAX_CAPTURE_BYTES && chunks.length > 1) {
        const dropped = chunks.shift();
        if (dropped) total -= dropped.length;
      }
    },
    text() {
      const joined = Buffer.concat(chunks);
      const tail = joined.length > OUTPUT_TAIL_BYTES ? joined.subarray(joined.length - OUTPUT_TAIL_BYTES) : joined;
      return tail.toString('utf8');
    },
    fullText() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

interface ProcessRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** Complete uncapped stdout, for structured line parsing. */
  stdoutFull: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export class GraphiteRunner {
  readonly cliPath: string;
  readonly timeoutMs: number;

  constructor(options: GraphiteRunnerOptions = {}) {
    this.cliPath = options.cliPath ?? resolveCliPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    // Fail fast at construction with a precise error, not at first spawn.
    assertExecutableFile(this.cliPath);
  }

  /**
   * Renders a spec to a validated artifact. On success the CLI may have
   * exited cleanly or crashed after the write (quarantine); on any failure a
   * typed error carries precise, actionable context. v1: run sequentially.
   */
  async render(spec: RenderSpec): Promise<ArtifactResult> {
    // Precise failure before spending a CLI spawn: refuse missing documents.
    const docStat = statSyncOrNull(spec.document);
    if (!docStat) {
      throw new DocInvalidError({ documentPath: spec.document, detail: 'document file does not exist on disk' });
    }
    if (!docStat.isFile()) {
      throw new DocInvalidError({ documentPath: spec.document, detail: 'document path is not a regular file' });
    }

    const format = formatFromOutputPath(spec.output); // SpecInvalidError on unsupported extension
    const args = buildExportArgs(spec);
    const command = this.commandLabel(args);

    // Make THIS render's validation authoritative: create the output
    // directory and never let a stale artifact from a previous run pass.
    await mkdir(path.dirname(path.resolve(spec.output)), { recursive: true }).catch(() => undefined);
    await rm(spec.output, { force: true }).catch(() => undefined);

    const run = await this.runProcess(args, this.timeoutMs);

    if (run.timedOut) {
      throw new TimeoutError({ command, timeoutMs: this.timeoutMs, stderrTail: run.stderr });
    }

    const crashedAfterWrite = run.signal === 'SIGSEGV' || (run.signal === null && run.exitCode === 139);
    const validation = await validateArtifact(spec.output, format);

    if (crashedAfterWrite) {
      if (validation.valid) {
        const quarantine: QuarantineInfo = {
          exitCode: run.exitCode,
          signal: run.signal,
          quarantinedAfterWrite: true,
          stderrTail: run.stderr,
        };
        return this.artifactResult(spec, command, run, validation, quarantine);
      }
      throw new ArtifactInvalidError({
        artifactPath: spec.output,
        reason:
          `graphene-cli crashed (signal ${run.signal ?? 'none'}, exit code ${run.exitCode ?? 'none'}) ` +
          `after writing the artifact, and the artifact failed validation: ${validation.reason}`,
        exitCode: run.exitCode,
        signal: run.signal,
        stderrTail: run.stderr,
      });
    }

    if (run.exitCode === 0 && run.signal === null) {
      if (validation.valid) {
        return this.artifactResult(spec, command, run, validation);
      }
      throw new ArtifactInvalidError({
        artifactPath: spec.output,
        reason: `graphene-cli exited 0 but the artifact failed validation: ${validation.reason}`,
        exitCode: run.exitCode,
        signal: run.signal,
        stderrTail: run.stderr,
      });
    }

    throw new RenderError({
      command,
      exitCode: run.exitCode,
      signal: run.signal,
      stdoutTail: run.stdout,
      stderrTail: run.stderr,
      note: validation.valid
        ? `an artifact exists at "${spec.output}" (${validation.byteSize} bytes) and passed validation, ` +
          `but the process reported failure — treating the render as failed`
        : undefined,
    });
  }

  /**
   * Wraps `graphene-cli compile` — the document validation pass. Exits
   * cleanly on valid documents; any nonzero exit/signal maps to
   * DocInvalidError with the engine's own stderr attached.
   */
  async compile(document: string, options: { printProto?: boolean } = {}): Promise<CompileResult> {
    const args = ['compile', document];
    if (options.printProto === true) args.push('--print-proto');
    const command = this.commandLabel(args);

    const run = await this.runProcess(args, this.timeoutMs);
    if (run.timedOut) {
      throw new TimeoutError({ command, timeoutMs: this.timeoutMs, stderrTail: run.stderr });
    }
    if (run.exitCode !== 0 || run.signal !== null) {
      throw new DocInvalidError({
        documentPath: document,
        detail: `compile ${run.signal ? `crashed with signal ${run.signal}` : `exited with code ${run.exitCode}`}`,
        exitCode: run.exitCode,
        signal: run.signal,
        stderrTail: run.stderr,
      });
    }
    return {
      document,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      command,
      durationMs: run.durationMs,
    };
  }

  /** Wraps `graphene-cli list-node-identifiers` (exits cleanly; parses stdout). */
  async listNodeIdentifiers(): Promise<ListNodeIdentifiersResult> {
    const args = ['list-node-identifiers'];
    const command = this.commandLabel(args);

    const run = await this.runProcess(args, this.timeoutMs);
    if (run.timedOut) {
      throw new TimeoutError({ command, timeoutMs: this.timeoutMs, stderrTail: run.stderr });
    }
    if (run.exitCode !== 0 || run.signal !== null) {
      throw new RenderError({
        command,
        exitCode: run.exitCode,
        signal: run.signal,
        stdoutTail: run.stdout,
        stderrTail: run.stderr,
        note: 'list-node-identifiers failed; the engine build may be broken',
      });
    }
    // Parse from the COMPLETE stream: the node registry exceeds the 8 KB
    // stdout tail (324 identifiers ≈ 12 KB), and the tail alone would drop
    // the first ~100 entries (Phase-4 fix, additive — see HANDOFF).
    const identifiers = run.stdoutFull
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { identifiers, stdout: run.stdout, exitCode: run.exitCode, command, durationMs: run.durationMs };
  }

  /** Wraps `graphene-cli dump-node-metadata` (exits cleanly; parses JSONL stdout). */
  async dumpNodeMetadata(): Promise<DumpNodeMetadataResult> {
    const args = ['dump-node-metadata'];
    const command = this.commandLabel(args);

    const run = await this.runProcess(args, this.timeoutMs);
    if (run.timedOut) {
      throw new TimeoutError({ command, timeoutMs: this.timeoutMs, stderrTail: run.stderr });
    }
    if (run.exitCode !== 0 || run.signal !== null) {
      throw new RenderError({
        command,
        exitCode: run.exitCode,
        signal: run.signal,
        stdoutTail: run.stdout,
        stderrTail: run.stderr,
        note: 'dump-node-metadata failed; the engine build may be broken or predate the dump-node-metadata command',
      });
    }
    // Parse from the COMPLETE stream (same reasoning as listNodeIdentifiers):
    // the registry dump exceeds the 8 KB stdout tail. Malformed lines are
    // skipped rather than fatal — a partial catalog beats no catalog.
    const nodes: NodeMetadataRecord[] = [];
    for (const line of run.stdoutFull.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as NodeMetadataRecord;
        if (typeof parsed.identifier === 'string' && parsed.identifier.length > 0) {
          nodes.push({ ...parsed, fields: Array.isArray(parsed.fields) ? parsed.fields : [] });
        }
      } catch {
        // Skip malformed lines; surfaced via count mismatch if it ever matters.
      }
    }
    return { nodes, stdout: run.stdout, exitCode: run.exitCode, command, durationMs: run.durationMs };
  }

  // -------------------------------------------------------------------------

  private runProcess(args: readonly string[], timeoutMs: number): Promise<ProcessRun> {
    return new Promise<ProcessRun>((resolve, reject) => {
      const startedAt = Date.now();
      const stdoutCapture = captureOutput();
      const stderrCapture = captureOutput();
      let timedOut = false;
      let settled = false;

      const child = spawn(this.cliPath, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

      // Timeout enforcement: kill on expiry; the close handler then reports
      // timedOut and the caller raises TimeoutError.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (timedOut || settled) return; // kill race; 'close' follows
        settled = true;
        clearTimeout(timer);
        reject(
          new CliNotFoundError({
            searchedPaths: [this.cliPath],
            reason: `failed to spawn "${this.cliPath}": ${err.code ?? err.message}`,
          }),
        );
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal,
          stdout: stdoutCapture.text(),
          stdoutFull: stdoutCapture.fullText(),
          stderr: stderrCapture.text(),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });

      child.stdout?.on('data', (chunk: Buffer) => stdoutCapture.write(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrCapture.write(chunk));
    });
  }

  private artifactResult(
    spec: RenderSpec,
    command: string,
    run: ProcessRun,
    validation: ValidationResult,
    quarantine?: QuarantineInfo,
  ): ArtifactResult {
    return {
      output: spec.output,
      format: validation.format as OutputFormat,
      byteSize: validation.byteSize,
      ...(validation.width !== undefined ? { width: validation.width } : {}),
      ...(validation.height !== undefined ? { height: validation.height } : {}),
      exitCode: run.exitCode,
      signal: run.signal,
      command,
      durationMs: run.durationMs,
      stdoutTail: run.stdout,
      stderrTail: run.stderr,
      ...(quarantine !== undefined ? { quarantine } : {}),
    };
  }

  /** Human-readable command line for logs (quotes parts containing spaces). */
  private commandLabel(args: readonly string[]): string {
    return [path.basename(this.cliPath), ...args]
      .map((part) => (part === '' || /\s|"/.test(part) ? JSON.stringify(part) : part))
      .join(' ');
  }
}