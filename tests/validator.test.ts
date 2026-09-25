/**
 * Unit tests for artifact validation (src/validator.ts): per-format magic-byte
 * and structure checks with precise failure reasons, format derivation from
 * output extensions, and the PNG pixel-comparison util used by the Phase 4
 * determinism acceptance criterion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  ARTIFACT_MIN_BYTES,
  comparePngPixels,
  formatFromOutputPath,
  validateArtifact,
} from '../src/validator.js';
import { ArtifactInvalidError, SpecInvalidError } from '../src/errors.js';

async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function catchSyncError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected fn to throw, but it returned');
}

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'graphite-validator-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeArtifact(name: string, bytes: Buffer | string): Promise<string> {
  const p = path.join(tmpDir, name);
  await writeFile(p, bytes);
  return p;
}

/** Real PNG of the given dimensions via pngjs (project dependency). */
function makePng(width: number, height: number, paint?: (data: Buffer, width: number) => void): Buffer {
  const image = new PNG({ width, height });
  if (paint) paint(image.data, width);
  return PNG.sync.write(image);
}

/** Structurally complete minimal GIF with the given logical screen size. */
function makeGif(width: number, height: number): Buffer {
  const header = Buffer.from('GIF89a', 'latin1');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80; // global color table flag, 2 entries
  const gct = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c; // image separator
  descriptor.writeUInt16LE(0, 1);
  descriptor.writeUInt16LE(0, 3);
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  descriptor[9] = 0x00;
  const minCode = Buffer.from([0x02]);
  const subBlock = Buffer.from([0x02, 0x44, 0x01]);
  const terminator = Buffer.from([0x00]);
  const trailer = Buffer.from([0x3b]);
  return Buffer.concat([header, lsd, gct, descriptor, minCode, subBlock, terminator, trailer]);
}

/** Minimal structurally plausible JFIF/JPEG (magic + APP0 + comment + EOI). */
function makeJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xfe, 0x00, 0x14]),
    Buffer.alloc(0x12, 0x61),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('validateArtifact: PNG', () => {
  it('accepts a real PNG and reports its IHDR dimensions', async () => {
    const p = await writeArtifact('ok.png', makePng(4, 2));

    const result = await validateArtifact(p);

    expect(result.valid).toBe(true);
    expect(result.format).toBe('png');
    expect(result.width).toBe(4);
    expect(result.height).toBe(2);
    expect(result.byteSize).toBeGreaterThanOrEqual(ARTIFACT_MIN_BYTES.png);
  });

  it('rejects bytes without the PNG signature', async () => {
    const bytes = makePng(2, 2);
    bytes[0] = 0x00;
    const p = await writeArtifact('bad-sig.png', bytes);

    const result = await validateArtifact(p, 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it('rejects truncated PNGs that are missing IEND', async () => {
    const full = makePng(512, 8);
    const truncated = full.subarray(0, full.length - 12);
    // Above the size floor, so the failure reason is truncation, not undersize.
    expect(truncated.length).toBeGreaterThanOrEqual(ARTIFACT_MIN_BYTES.png);
    const p = await writeArtifact('truncated.png', truncated);

    const result = await validateArtifact(p, 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/truncated|IEND/i);
  });

  it('rejects undersized files before deeper parsing', async () => {
    const p = await writeArtifact('tiny.png', makePng(2, 2).subarray(0, 20));

    const result = await validateArtifact(p, 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/too small/i);
  });

  it('rejects IHDR with zero dimensions', async () => {
    const bytes = makePng(2, 2);
    bytes.writeUInt32BE(0, 16);
    const p = await writeArtifact('zero-dims.png', bytes);

    const result = await validateArtifact(p, 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/zero dimensions/i);
  });
});

describe('validateArtifact: JPEG', () => {
  it('accepts JPEG by its magic bytes', async () => {
    const p = await writeArtifact('ok.jpg', makeJpeg());

    const result = await validateArtifact(p);

    expect(result.valid).toBe(true);
    expect(result.format).toBe('jpg');
  });

  it('rejects non-JPEG bytes with a precise reason', async () => {
    const p = await writeArtifact(
      'bad.jpg',
      Buffer.from('definitely not a jpeg, padding to pass the size floor, padding padding padding'),
    );

    const result = await validateArtifact(p, 'jpg');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/FF D8 FF/i);
  });
});

describe('validateArtifact: GIF', () => {
  it('accepts GIF87a and GIF89a and reports logical screen dimensions', async () => {
    const bytes87 = makeGif(3, 2);
    bytes87.write('GIF87a', 0, 'latin1');
    const p87 = await writeArtifact('ok87.gif', bytes87);
    const r87 = await validateArtifact(p87);
    expect(r87.valid).toBe(true);
    expect(r87.width).toBe(3);
    expect(r87.height).toBe(2);

    const p89 = await writeArtifact('ok89.gif', makeGif(320, 200));
    const r89 = await validateArtifact(p89);
    expect(r89.valid).toBe(true);
    expect(r89.width).toBe(320);
    expect(r89.height).toBe(200);
  });

  it('rejects a bad GIF header', async () => {
    const bytes = makeGif(3, 2);
    bytes.write('GIF88a', 0, 'latin1');
    const p = await writeArtifact('bad.gif', bytes);

    const result = await validateArtifact(p, 'gif');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/GIF87a|GIF89a/i);
  });

  it('rejects GIFs with zero logical screen dimensions', async () => {
    const p = await writeArtifact('zero.gif', makeGif(0, 0));

    const result = await validateArtifact(p, 'gif');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/logical screen|zero/i);
  });
});

describe('validateArtifact: SVG', () => {
  it('accepts a real SVG document with an <svg> root and content', async () => {
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const p = await writeArtifact('ok.svg', svg);

    const result = await validateArtifact(p);

    expect(result.valid).toBe(true);
    expect(result.format).toBe('svg');
  });

  it('rejects an SVG whose root element is not <svg>', async () => {
    const p = await writeArtifact('html.svg', '<html><body>hi</body></html>');

    const result = await validateArtifact(p, 'svg');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/<html>/);
  });

  it('rejects an empty <svg> root (closed, self-closing, comment-only)', async () => {
    const empty = await writeArtifact('empty.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await validateArtifact(empty, 'svg')).reason).toMatch(/empty/i);

    const selfClosing = await writeArtifact('selfclosing.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect((await validateArtifact(selfClosing, 'svg')).valid).toBe(false);

    const commentOnly = await writeArtifact('comment.svg', '<svg><!-- nothing here --></svg>');
    expect((await validateArtifact(commentOnly, 'svg')).reason).toMatch(/empty/i);
  });

  it('rejects an unclosed <svg> root', async () => {
    const p = await writeArtifact('unclosed.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect/>');

    const result = await validateArtifact(p, 'svg');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/closed/i);
  });

  it('rejects non-XML and non-UTF-8 payloads', async () => {
    const text = await writeArtifact('text.svg', 'just some text, no markup here at all');
    expect((await validateArtifact(text, 'svg')).valid).toBe(false);

    const binary = await writeArtifact(
      'binary.svg',
      Buffer.from([0x3c, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
    );
    expect((await validateArtifact(binary, 'svg')).reason).toMatch(/UTF-8/i);
  });
});

describe('validateArtifact: cross-cutting', () => {
  it('reports a precise reason for a missing file', async () => {
    const result = await validateArtifact(path.join(tmpDir, 'nope.png'), 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not exist/i);
  });

  it('rejects a directory path', async () => {
    const result = await validateArtifact(tmpDir, 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/regular file/i);
  });

  it('rejects empty files', async () => {
    const p = await writeArtifact('empty.png', Buffer.alloc(0));

    const result = await validateArtifact(p, 'png');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/0 bytes/i);
  });

  it('notes when the bytes are a different format than expected', async () => {
    // The real-world mislabel case: a PNG written where a .gif was expected.
    const p = await writeArtifact('mislabeled.gif', makePng(4, 2));

    const result = await validateArtifact(p, 'gif');

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/look like PNG/i);
  });
});

describe('formatFromOutputPath', () => {
  it('maps supported extensions (ground truth: svg/png/jpg/gif only)', () => {
    expect(formatFromOutputPath('a.png')).toBe('png');
    expect(formatFromOutputPath('a.jpg')).toBe('jpg');
    expect(formatFromOutputPath('a.jpeg')).toBe('jpg');
    expect(formatFromOutputPath('a.gif')).toBe('gif');
    expect(formatFromOutputPath('a.SVG')).toBe('svg');
  });

  it('rejects unsupported extensions precisely (PDF included)', () => {
    const err = catchSyncError(() => formatFromOutputPath('report.pdf'));
    expect(err instanceof SpecInvalidError).toBe(true);
    expect(err.message).toMatch(/pdf/i);
    expect(err.message).toMatch(/\.svg|\.png|\.gif/i);

    expect(() => formatFromOutputPath('no-extension')).toThrow(SpecInvalidError);
  });
});

describe('comparePngPixels', () => {
  it('reports identical images as equal', async () => {
    const a = await writeArtifact('a.png', makePng(3, 2));
    const b = await writeArtifact('b.png', makePng(3, 2));

    const cmp = comparePngPixels(a, b);

    expect(cmp.equal).toBe(true);
    expect(cmp.dimsMatch).toBe(true);
    expect(cmp.diffCount).toBe(0);
    expect(cmp.samples).toHaveLength(0);
  });

  it('pins the exact coordinates of pixel differences', async () => {
    const base = await writeArtifact('base.png', makePng(3, 2));
    // Flip the blue channel of pixel (x=2, y=1).
    const altered = await writeArtifact(
      'altered.png',
      makePng(3, 2, (data) => {
        data[(1 * 3 + 2) * 4 + 2] = 0xff;
      }),
    );

    const cmp = comparePngPixels(base, altered);

    expect(cmp.equal).toBe(false);
    expect(cmp.dimsMatch).toBe(true);
    expect(cmp.diffCount).toBe(1);
    expect(cmp.samples[0]?.x).toBe(2);
    expect(cmp.samples[0]?.y).toBe(1);
  });

  it('rejects dimension mismatches explicitly', async () => {
    const a = await writeArtifact('a2.png', makePng(3, 2));
    const b = await writeArtifact('b2.png', makePng(4, 2));

    const cmp = comparePngPixels(a, b);

    expect(cmp.equal).toBe(false);
    expect(cmp.dimsMatch).toBe(false);
    expect(cmp.reason).toMatch(/dimensions differ/i);
  });

  it('throws ArtifactInvalidError for non-PNG inputs', async () => {
    const a = await writeArtifact('text1.png', Buffer.from('not a png at all, nope nope nope nope nope nope nope nope'));
    const b = await writeArtifact('text2.png', Buffer.from('not a png at all, nope nope nope nope nope nope nope nope'));

    const err = catchSyncError(() => comparePngPixels(a, b));

    expect(err instanceof ArtifactInvalidError).toBe(true);
    expect(err.message).toMatch(/PNG/i);
  });
});

describe('validator is non-throwing for validation failures', () => {
  it('returns invalid results instead of throwing for artifact-level failures', async () => {
    const missing = await validateArtifact(path.join(tmpDir, 'missing.gif'), 'gif');
    expect(missing.valid).toBe(false);

    const garbage = await writeArtifact('garbage.gif', Buffer.from('x'.repeat(50)));
    expect((await validateArtifact(garbage, 'gif')).valid).toBe(false);
  });

  it('rejects awaiting errors only for programmer mistakes (bad expected format is not possible via typed API)', async () => {
    // validateArtifact without expectedFormat derives the format from the path;
    // an unsupported extension there is a caller bug -> SpecInvalidError.
    const err = await catchError(validateArtifact(path.join(tmpDir, 'thing.pdf')));
    expect(err instanceof SpecInvalidError).toBe(true);
  });
});