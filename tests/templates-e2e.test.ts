/**
 * REAL-CLI e2e for the four templates: every template is proven by an actual
 * graphene-cli render through the Phase-2 runner (never hand-assembled args).
 *
 * Requires the pinned debug build at
 * `<projectRoot>/engine/Graphite/target/debug/graphene-cli`; the whole suite is
 * skipped when the binary is absent so `npm test` stays green pre-build.
 *
 * Ground truth re-asserted on every real render: the CLI writes a valid
 * artifact and THEN dies with SIGSEGV — the runner quarantines it, so a
 * successful render carries `quarantine.quarantinedAfterWrite === true`.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { PNG } from 'pngjs';
import { buildDocument, writeDocument } from '../src/builder.js';
import { GraphiteRunner } from '../src/runner.js';
import { validateArtifact, comparePngPixels } from '../src/validator.js';
import { defaultCliPath } from '../src/paths.js';
import type { ArtifactResult, RenderSpec } from '../src/types.js';
import type { ColorParam, TemplateParams } from '../src/templates.js';

const CLI_PATH = defaultCliPath();
const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp', 'phase3-e2e');

const E2E_TIMEOUT = 120_000;

/** Approximate sRGB gamma transfer (c^(1/2.2)); engine-matched within ±12/255. */
function gamma255(channel: number): number {
  return Math.round(Math.pow(channel, 1 / 2.2) * 255);
}

function countPixelsMatching(pngPath: string, color: ColorParam, tolerance = 12): number {
  const png = PNG.sync.read(readFileSync(pngPath));
  const expected = [gamma255(color.red), gamma255(color.green), gamma255(color.blue)];
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (
      Math.abs(png.data[offset] - expected[0]) <= tolerance &&
      Math.abs(png.data[offset + 1] - expected[1]) <= tolerance &&
      Math.abs(png.data[offset + 2] - expected[2]) <= tolerance
    ) {
      count += 1;
    }
  }
  return count;
}

describe.skipIf(!existsSync(CLI_PATH))('templates e2e (real graphene-cli)', () => {
  let runner: GraphiteRunner;

  beforeAll(async () => {
    runner = new GraphiteRunner({ timeoutMs: 90_000 });
    await rm(E2E_DIR, { recursive: true, force: true });
  }, E2E_TIMEOUT);

  /** Builds, writes, and renders a document object; asserts the full contract. */
  async function renderDoc(
    label: string,
    doc: Parameters<typeof writeDocument>[1],
    size: { width: number; height: number },
  ): Promise<ArtifactResult> {
    const documentPath = await writeDocument(`${E2E_DIR}/${label}.graphite`, doc);
    return renderSpec({ document: documentPath, output: `${E2E_DIR}/${label}.png`, size });
  }

  async function renderSpec(spec: RenderSpec): Promise<ArtifactResult> {
    const artifact = await runner.render(spec);
    // Engine ground truth: valid artifact + SIGSEGV-after-write quarantine.
    expect(artifact.quarantine?.quarantinedAfterWrite, `quarantine for ${spec.output}`).toBe(true);
    const validation = await validateArtifact(spec.output, 'png');
    expect(validation.valid, validation.reason ?? 'artifact must be valid').toBe(true);
    expect(artifact.width, `dims of ${spec.output}`).toBe(spec.size?.width);
    expect(artifact.height, `dims of ${spec.output}`).toBe(spec.size?.height);
    return artifact;
  }

  /** Renders one of the COMMITTED sample outputs (default params). */
  function renderSample(id: string, label: string): Promise<ArtifactResult> {
    const docPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', `${id}.graphite`);
    return renderSpec({ document: docPath, output: `${E2E_DIR}/${label}.png`, size: { width: 1000, height: 500 } });
  }

  // -------------------------------------------------------------------------
  // AC-1: every template has a real-CLI render proof (default params)
  // -------------------------------------------------------------------------

  it.each(['solid-background', 'pattern-background', 'text-on-background', 'duotone-image'] as const)(
    'renders %s (committed sample) to a valid, correctly-sized PNG with quarantine metadata',
    async (id) => {
      const artifact = await renderSample(id, `sample-${id}`);
      expect(artifact.byteSize).toBeGreaterThan(1000);
      expect(artifact.signal).toBe('SIGSEGV');
    },
    E2E_TIMEOUT,
  );

  // -------------------------------------------------------------------------
  // AC-2: parametric change → different pixels (per template)
  // -------------------------------------------------------------------------

  it('solid-background: gradient variant renders visibly different pixels from the solid variant', async () => {
    await renderDoc(
      'solid-red',
      buildDocument('solid-background', { variant: 'solid', width: 1000, height: 500, color: { red: 0.9, green: 0.2, blue: 0.1 } }).document,
      { width: 1000, height: 500 },
    );
    await renderDoc(
      'gradient-bw',
      buildDocument('solid-background', {
        variant: 'gradient',
        width: 1000,
        height: 500,
        from: { red: 0, green: 0, blue: 0 },
        to: { red: 1, green: 1, blue: 1 },
      }).document,
      { width: 1000, height: 500 },
    );
    const cmp = comparePngPixels(`${E2E_DIR}/solid-red.png`, `${E2E_DIR}/gradient-bw.png`);
    expect(cmp.dimsMatch).toBe(true);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
  }, E2E_TIMEOUT);

  it('solid-background: changing the solid color changes the pixels', async () => {
    await renderDoc(
      'solid-blue',
      buildDocument('solid-background', { variant: 'solid', width: 1000, height: 500, color: { red: 0.12, green: 0.42, blue: 0.95 } }).document,
      { width: 1000, height: 500 },
    );
    const cmp = comparePngPixels(`${E2E_DIR}/solid-red.png`, `${E2E_DIR}/solid-blue.png`);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
    // the solid blue render is exactly the requested color (gamma-matched)
    expect(countPixelsMatching(`${E2E_DIR}/solid-blue.png`, { red: 0.12, green: 0.42, blue: 0.95 })).toBe(1000 * 500);
  }, E2E_TIMEOUT);

  it('pattern-background: a different seed produces different pixels', async () => {
    const base = { width: 1000, height: 500, scale: 35 } as const;
    await renderDoc(
      'pattern-seed0',
      buildDocument('pattern-background', { ...base, seed: 0 }).document,
      { width: 1000, height: 500 },
    );
    await renderDoc(
      'pattern-seed7',
      buildDocument('pattern-background', { ...base, seed: 7 }).document,
      { width: 1000, height: 500 },
    );
    const cmp = comparePngPixels(`${E2E_DIR}/pattern-seed0.png`, `${E2E_DIR}/pattern-seed7.png`);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
  }, E2E_TIMEOUT);

  it('pattern-background: a different scale produces different pixels', async () => {
    const base = { width: 1000, height: 500, seed: 0 } as const;
    await renderDoc(
      'pattern-scale35',
      buildDocument('pattern-background', { ...base, scale: 35 }).document,
      { width: 1000, height: 500 },
    );
    await renderDoc(
      'pattern-scale8',
      buildDocument('pattern-background', { ...base, scale: 8 }).document,
      { width: 1000, height: 500 },
    );
    const cmp = comparePngPixels(`${E2E_DIR}/pattern-scale35.png`, `${E2E_DIR}/pattern-scale8.png`);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
  }, E2E_TIMEOUT);

  it('text-on-background: text renders (non-uniform image, text-color pixels present) and a different string changes the pixels', async () => {
    const textColor: ColorParam = { red: 0.12, green: 0.42, blue: 0.95 };
    const base = {
      width: 1000,
      height: 500,
      background: { red: 0.06, green: 0.06, blue: 0.08 },
      textColor,
    };
    await renderDoc(
      'text-a',
      buildDocument('text-on-background', { ...base, text: 'GRAPHITE TEMPLATE' }).document,
      { width: 1000, height: 500 },
    );
    await renderDoc(
      'text-b',
      buildDocument('text-on-background', { ...base, text: 'ALTERNATE STRING' }).document,
      { width: 1000, height: 500 },
    );

    // non-uniform: thousands of pixels differ from the corner
    const corner = PNG.sync.read(readFileSync(`${E2E_DIR}/text-a.png`));
    let differing = 0;
    const bg = [corner.data[0], corner.data[1], corner.data[2]];
    for (let offset = 0; offset < corner.data.length; offset += 4) {
      if (
        Math.abs(corner.data[offset] - bg[0]) > 8 ||
        Math.abs(corner.data[offset + 1] - bg[1]) > 8 ||
        Math.abs(corner.data[offset + 2] - bg[2]) > 8
      ) {
        differing += 1;
      }
    }
    expect(differing).toBeGreaterThan(1000); // actual glyph pixels from the probe: ~5000

    // the requested text color is present (gamma-approximate match)
    expect(countPixelsMatching(`${E2E_DIR}/text-a.png`, textColor)).toBeGreaterThan(100);

    // parametric: different text → different pixels
    const cmp = comparePngPixels(`${E2E_DIR}/text-a.png`, `${E2E_DIR}/text-b.png`);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
  }, E2E_TIMEOUT);

  it('duotone-image: a different ramp changes the pixels', async () => {
    const base = { width: 1000, height: 500, seed: 0, scale: 35 } as const;
    await renderDoc(
      'duotone-orange',
      buildDocument('duotone-image', { ...base, dark: { red: 0.02, green: 0.02, blue: 0.12 }, light: { red: 1, green: 0.3, blue: 0.03 } }).document,
      { width: 1000, height: 500 },
    );
    await renderDoc(
      'duotone-blue',
      buildDocument('duotone-image', { ...base, dark: { red: 0.02, green: 0.02, blue: 0.12 }, light: { red: 0.1, green: 0.5, blue: 1 } }).document,
      { width: 1000, height: 500 },
    );
    const cmp = comparePngPixels(`${E2E_DIR}/duotone-orange.png`, `${E2E_DIR}/duotone-blue.png`);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
  }, E2E_TIMEOUT);

  it('duotone-image: reverse flips the mapping', async () => {
    const base = { width: 1000, height: 500, seed: 0, scale: 35 } as const;
    const colors = { dark: { red: 0.02, green: 0.02, blue: 0.12 }, light: { red: 1, green: 0.3, blue: 0.03 } };
    await renderDoc(
      'duotone-forward',
      buildDocument('duotone-image', { ...base, ...colors, reverse: false }).document,
      { width: 1000, height: 500 },
    );
    await renderDoc(
      'duotone-reversed',
      buildDocument('duotone-image', { ...base, ...colors, reverse: true }).document,
      { width: 1000, height: 500 },
    );
    const cmp = comparePngPixels(`${E2E_DIR}/duotone-forward.png`, `${E2E_DIR}/duotone-reversed.png`);
    expect(cmp.equal, `${cmp.diffCount} differing pixels`).toBe(false);
  }, E2E_TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3: determinism — same spec rendered twice → pixel-identical
  // -------------------------------------------------------------------------

  it.each(['solid-background', 'pattern-background', 'text-on-background', 'duotone-image'] as const)(
    'determinism: %s default sample rendered twice is pixel-identical',
    async (id) => {
      await renderSample(id, `det-${id}-a`);
      await renderSample(id, `det-${id}-b`);
      const cmp = comparePngPixels(`${E2E_DIR}/det-${id}-a.png`, `${E2E_DIR}/det-${id}-b.png`);
      expect(cmp.dimsMatch).toBe(true);
      expect(
        cmp.equal,
        cmp.equal ? 'deterministic' : `${cmp.diffCount} of ${cmp.widthA * cmp.heightA} pixels differ; first sample: ${JSON.stringify(cmp.samples)}`,
      ).toBe(true);
    },
    E2E_TIMEOUT,
  );

  // -------------------------------------------------------------------------
  // AC-1 (dims as requested): a custom-size document renders at that size
  // -------------------------------------------------------------------------

  it('renders a custom 600x400 document at exactly 600x400', async () => {
    const artifact = await renderDoc(
      'custom-size',
      buildDocument('pattern-background', { width: 600, height: 400, seed: 0, scale: 35 }).document,
      { width: 600, height: 400 },
    );
    expect(artifact.width).toBe(600);
    expect(artifact.height).toBe(400);
  }, E2E_TIMEOUT);
});
