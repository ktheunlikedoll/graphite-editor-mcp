/**
 * Core data contracts for the Graphite artifact pipeline.
 *
 * Graphite doctrine: agents author documents as data, a headless CLI renders
 * them, and every call returns a validated artifact or a precise error. These
 * types are the vocabulary shared by the process runner (Phase 2) and the MCP
 * tool layer (Phase 4).
 */

/**
 * Artifact formats graphene-cli can write; the extension of --output decides.
 * Ground truth (TRIAL-FINDINGS.md): the CLI accepts exactly .svg, .png,
 * .jpg/.jpeg and .gif — PDF is explicitly rejected.
 */
export type OutputFormat = 'png' | 'jpg' | 'gif' | 'svg';

/**
 * Raster render size. Both dimensions live in ONE object on purpose: a
 * width-only or height-only request is unrepresentable at the type level.
 * Ground truth: graphene-cli silently falls back to a 1x1 default viewport
 * when only one dimension is passed — Graphite refuses that failure mode.
 */
export interface RasterSize {
  width: number;
  height: number;
}

/** GIF timing: either an explicit frame count + fps, or a total duration in seconds. */
export type GifTiming =
  | { mode: 'frames'; fps: number; frames: number }
  | { mode: 'duration'; duration: number };

/** What the caller wants rendered. Pure data — no process handles, no streams. */
export interface RenderSpec {
  /** Path to the .graphite document to render. */
  document: string;
  /** Output artifact path; the file extension selects the format. */
  output: string;
  /** Raster size in pixels. Required for png/jpg/gif; optional for svg. */
  size?: RasterSize;
  /** Optional scale factor, passed through as --scale. */
  scale?: number;
  /** Pass --transparent to the CLI (applies to formats that support alpha). */
  transparent?: boolean;
  /** Required for .gif output. */
  gif?: GifTiming;
}

/**
 * Metadata for the crash quarantine. Ground truth: every successful
 * graphene-cli export writes a complete, valid file and THEN dies with
 * SIGSEGV (exit 139). The runner validates the artifact and quarantines the
 * abnormal exit instead of failing the render.
 */
export interface QuarantineInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  quarantinedAfterWrite: boolean;
  stderrTail: string;
}

/**
 * Result of artifact validation. Validation failures are RETURNED (never
 * thrown) so callers can inspect them; only caller mistakes (unsupported
 * extension, bad arguments) throw.
 */
export interface ValidationResult {
  valid: boolean;
  format: OutputFormat | null;
  byteSize: number;
  path: string;
  /** Precise, human-readable failure reason when valid is false. */
  reason?: string;
  /** Pixel dimensions when the format encodes them (PNG IHDR, GIF logical screen). */
  width?: number;
  height?: number;
}

/** Successful render: a validated artifact plus full provenance metadata. */
export interface ArtifactResult {
  output: string;
  format: OutputFormat;
  byteSize: number;
  width?: number;
  height?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Human-readable command line, for logs (paths may contain spaces). */
  command: string;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /** Present when the CLI crashed after writing a valid artifact. */
  quarantine?: QuarantineInfo;
}

/** Result of `graphene-cli compile` — the document validation pass. */
export interface CompileResult {
  document: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  durationMs: number;
}

/** Result of `graphene-cli list-node-identifiers` (exits cleanly, fast). */
export interface ListNodeIdentifiersResult {
  identifiers: string[];
  stdout: string;
  exitCode: number;
  command: string;
  durationMs: number;
}

/** One node's registry metadata, as dumped by `graphene-cli dump-node-metadata` (JSONL). */
export interface NodeMetadataRecord {
  identifier: string;
  displayName: string;
  category: string;
  description: string;
  fields: Array<{
    name: string;
    description: string;
    type?: string;
    default?: string;
    softRange?: [number, number];
    hardRange?: [number, number];
    step?: number;
    unit?: string;
    hidden?: boolean;
  }>;
}

/** Result of `graphene-cli dump-node-metadata` (exits cleanly, fast). */
export interface DumpNodeMetadataResult {
  nodes: NodeMetadataRecord[];
  stdout: string;
  exitCode: number;
  command: string;
  durationMs: number;
}