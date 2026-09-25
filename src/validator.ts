/**
 * Artifact-first validation: never trust exit codes alone. Every artifact is
 * checked for (a) existence, (b) non-trivial size, and (c) format validity —
 * magic bytes + structure, with precise failure reasons.
 *
 * Ground truth (TRIAL-FINDINGS.md): graphene-cli writes .svg/.png/.jpg/.gif
 * only (PDF rejected), and every successful export is followed by SIGSEGV —
 * so this validator, not the exit code, decides whether a render succeeded.
 */
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ArtifactInvalidError, SpecInvalidError } from './errors.js';
import type { OutputFormat, ValidationResult } from './types.js';

/**
 * Per-format minimum sizes in bytes ("non-trivial size" floors). The floors
 * sit just above a truncated/empty write and at/below the smallest legal file
 * for each format (a 2x1 RGB PNG via pngjs is exactly 67 bytes). The real
 * gate is the format check below; these floors catch early truncation.
 */
export const ARTIFACT_MIN_BYTES: Readonly<Record<OutputFormat, number>> = {
  png: 67,
  jpg: 40,
  gif: 30,
  svg: 12,
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND_CHUNK_PREFIX = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]);

/**
 * Derives the output format from the artifact path's extension.
 * Throws SpecInvalidError for anything graphene-cli cannot write
 * (ground truth: "Supported formats: .svg, .png, .jpg, .gif" — no PDF).
 */
export function formatFromOutputPath(outputPath: string): OutputFormat {
  const ext = path.extname(outputPath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'png';
    case '.jpg':
    case '.jpeg':
      return 'jpg';
    case '.gif':
      return 'gif';
    case '.svg':
      return 'svg';
    default:
      throw new SpecInvalidError(
        `unsupported output extension "${ext || '(none)'}" on "${outputPath}" — ` +
          `graphene-cli writes .svg, .png, .jpg/.jpeg and .gif only (PDF is not supported by the CLI)`,
      );
  }
}

/** Cheap magic-byte sniff used to explain mismatches ("bytes look like GIF, expected PNG"). */
export function sniffFormat(buf: Buffer): OutputFormat | null {
  if (buf.length >= PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6) {
    const header = buf.subarray(0, 6).toString('latin1');
    if (header === 'GIF87a' || header === 'GIF89a') return 'gif';
  }
  if (buf.length >= 1 && buf[0] === 0x3c /* '<' */) return 'svg';
  return null;
}

interface FormatCheck {
  valid: boolean;
  reason?: string;
  width?: number;
  height?: number;
}

function checkPng(buf: Buffer): FormatCheck {
  if (buf.length < PNG_SIGNATURE.length + 8) {
    return { valid: false, reason: 'file too short to contain a PNG signature + IHDR header' };
  }
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { valid: false, reason: 'missing PNG signature (expected bytes 89 50 4E 47 0D 0A 1A 0A)' };
  }
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return { valid: false, reason: 'first chunk is not IHDR — corrupt PNG structure' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return { valid: false, reason: `IHDR declares ${width}x${height}; zero dimensions are invalid`, width, height };
  }
  if (buf.indexOf(IEND_CHUNK_PREFIX) === -1) {
    return { valid: false, reason: 'PNG is truncated: IEND chunk not found', width, height };
  }
  return { valid: true, width, height };
}

function checkJpeg(buf: Buffer): FormatCheck {
  if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return { valid: false, reason: 'missing JPEG magic (expected bytes FF D8 FF)' };
  }
  return { valid: true };
}

function checkGif(buf: Buffer): FormatCheck {
  if (buf.length < 13) {
    return { valid: false, reason: 'file too short for a GIF header + logical screen descriptor' };
  }
  const header = buf.subarray(0, 6).toString('latin1');
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return { valid: false, reason: `bad GIF header "${header}" (expected GIF87a or GIF89a)` };
  }
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width === 0 || height === 0) {
    return { valid: false, reason: `logical screen size is ${width}x${height}; zero dimensions are invalid`, width, height };
  }
  return { valid: true, width, height };
}

function stripXmlPrologue(src: string): string {
  let s = src;
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<?')) {
      const end = s.indexOf('?>');
      if (end === -1) return s;
      s = s.slice(end + 2);
      continue;
    }
    if (s.startsWith('<!--')) {
      const end = s.indexOf('-->');
      if (end === -1) return s;
      s = s.slice(end + 3);
      continue;
    }
    if (/^<!DOCTYPE/i.test(s)) {
      const end = s.indexOf('>');
      if (end === -1) return s;
      s = s.slice(end + 1);
      continue;
    }
    return s;
  }
}

function checkSvg(buf: Buffer): FormatCheck {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { valid: false, reason: 'not valid UTF-8 — cannot be an SVG document' };
  }
  const s = stripXmlPrologue(text);
  const rootMatch = /^<([A-Za-z][A-Za-z0-9_:.-]*)/.exec(s);
  if (!rootMatch) {
    return { valid: false, reason: 'does not start with an XML element — not an SVG document' };
  }
  const root = rootMatch[1];
  if (root !== 'svg') {
    return { valid: false, reason: `root element is <${root}>, expected <svg>` };
  }
  const closeIdx = s.indexOf('</svg');
  if (closeIdx === -1) {
    return { valid: false, reason: 'root <svg> element is never closed' };
  }
  const openTagEnd = s.indexOf('>', rootMatch[0].length - 1);
  const inner =
    openTagEnd === -1
      ? ''
      : s
          .slice(openTagEnd + 1, closeIdx)
          .replace(/<!--[\s\S]*?-->/g, '')
          .trim();
  if (inner.length === 0) {
    return { valid: false, reason: 'root <svg> element is empty — no drawing content' };
  }
  return { valid: true };
}

function checkFormatBytes(buf: Buffer, format: OutputFormat): FormatCheck {
  switch (format) {
    case 'png':
      return checkPng(buf);
    case 'jpg':
      return checkJpeg(buf);
    case 'gif':
      return checkGif(buf);
    case 'svg':
      return checkSvg(buf);
  }
}

/**
 * Validates an artifact file. Validation failures are RETURNED (valid: false
 * with a precise reason); only caller mistakes throw SpecInvalidError.
 *
 * @param filePath       artifact path to validate
 * @param expectedFormat format to check against; derived from the extension when omitted
 */
export async function validateArtifact(
  filePath: string,
  expectedFormat?: OutputFormat,
): Promise<ValidationResult> {
  const format = expectedFormat ?? formatFromOutputPath(filePath);
  const invalid = (
    reason: string,
    extra: { byteSize?: number; width?: number; height?: number } = {},
  ): ValidationResult => ({
    valid: false,
    format,
    path: filePath,
    reason,
    byteSize: extra.byteSize ?? 0,
    ...(extra.width !== undefined ? { width: extra.width } : {}),
    ...(extra.height !== undefined ? { height: extra.height } : {}),
  });

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return invalid(
      code === 'ENOENT'
        ? `artifact does not exist: "${filePath}"`
        : `artifact is not accessible ("${filePath}"): ${code ?? String(err)}`,
    );
  }
  if (!info.isFile()) {
    return invalid(`artifact path is not a regular file: "${filePath}"`);
  }
  const byteSize = info.size;
  if (byteSize === 0) {
    return invalid(`artifact is empty (0 bytes): "${filePath}"`, { byteSize });
  }
  const min = ARTIFACT_MIN_BYTES[format];
  if (byteSize < min) {
    return invalid(
      `artifact too small: ${byteSize} byte(s); a real ${format.toUpperCase()} is at least ${min} bytes — ` +
        `the write was likely truncated or placeholder`,
      { byteSize },
    );
  }

  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    return invalid(`artifact is not readable: ${String(err)}`, { byteSize });
  }

  const check = checkFormatBytes(buf, format);
  if (!check.valid) {
    const sniffed = sniffFormat(buf);
    const note =
      sniffed && sniffed !== format
        ? ` (note: the bytes look like ${sniffed.toUpperCase()}, not ${format.toUpperCase()})`
        : '';
    return invalid(`${check.reason}${note}`, {
      byteSize,
      ...(check.width !== undefined ? { width: check.width } : {}),
      ...(check.height !== undefined ? { height: check.height } : {}),
    });
  }

  return {
    valid: true,
    format,
    byteSize,
    path: filePath,
    ...(check.width !== undefined ? { width: check.width } : {}),
    ...(check.height !== undefined ? { height: check.height } : {}),
  };
}

export interface PixelDiffSample {
  x: number;
  y: number;
  /** Byte offset of the pixel's first channel in the RGBA buffer. */
  offset: number;
  /** [r, g, b, a] in image A. */
  colorA: number[];
  /** [r, g, b, a] in image B. */
  colorB: number[];
}

export interface PngPixelComparison {
  equal: boolean;
  dimsMatch: boolean;
  widthA: number;
  heightA: number;
  widthB: number;
  heightB: number;
  /** Number of differing pixels (0 when dimensions differ — not scanned). */
  diffCount: number;
  /** First N mismatches with exact coordinates (N = maxSamples, default 5). */
  samples: PixelDiffSample[];
  reason?: string;
}

const DEFAULT_MAX_SAMPLES = 5;

function readPngForComparison(p: string): { data: Buffer; width: number; height: number } {
  let raw: Buffer;
  try {
    raw = readFileSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    throw new ArtifactInvalidError({
      artifactPath: p,
      reason: `cannot read PNG for comparison: ${code ?? String(err)}`,
    });
  }
  try {
    const png = PNG.sync.read(raw);
    return { data: png.data, width: png.width, height: png.height };
  } catch (err) {
    throw new ArtifactInvalidError({
      artifactPath: p,
      reason: `not a decodable PNG: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Compares two PNG files pixel-by-pixel (RGBA). This is the deterministic-
 * render check the Phase 4 acceptance criterion depends on: same spec rendered
 * twice must produce pixel-identical output, with exact mismatch coordinates
 * when it does not.
 *
 * Synchronous (pngjs sync API); intended for validation-sized images.
 */
export function comparePngPixels(
  pathA: string,
  pathB: string,
  maxSamples: number = DEFAULT_MAX_SAMPLES,
): PngPixelComparison {
  const a = readPngForComparison(pathA);
  const b = readPngForComparison(pathB);

  if (a.width !== b.width || a.height !== b.height) {
    return {
      equal: false,
      dimsMatch: false,
      widthA: a.width,
      heightA: a.height,
      widthB: b.width,
      heightB: b.height,
      diffCount: 0,
      samples: [],
      reason: `dimensions differ: A is ${a.width}x${a.height}, B is ${b.width}x${b.height}`,
    };
  }

  const samples: PixelDiffSample[] = [];
  let diffCount = 0;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    if (
      a.data[offset] !== b.data[offset] ||
      a.data[offset + 1] !== b.data[offset + 1] ||
      a.data[offset + 2] !== b.data[offset + 2] ||
      a.data[offset + 3] !== b.data[offset + 3]
    ) {
      diffCount += 1;
      if (samples.length < maxSamples) {
        const pixelIndex = offset / 4;
        samples.push({
          x: pixelIndex % a.width,
          y: Math.floor(pixelIndex / a.width),
          offset,
          colorA: [a.data[offset], a.data[offset + 1], a.data[offset + 2], a.data[offset + 3]],
          colorB: [b.data[offset], b.data[offset + 1], b.data[offset + 2], b.data[offset + 3]],
        });
      }
    }
  }

  return {
    equal: diffCount === 0,
    dimsMatch: true,
    widthA: a.width,
    heightA: a.height,
    widthB: b.width,
    heightB: b.height,
    diffCount,
    samples,
    ...(diffCount > 0 ? { reason: `${diffCount} of ${a.width * a.height} pixels differ` } : {}),
  };
}