/**
 * Structural tests for the builder + templates (no CLI required).
 *
 * Ground truth asserted here: the wrapper epilogue (exports → artboard
 * wrapper), param substitution into the right node inputs, the precise-error
 * taxonomy on bad params, deterministic serialization, and the fixture
 * round-trip (parse trial fixture → reserialize → deep-equal at JSON level).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDefaultDocument, buildDocument, serializeDocument, writeDocument } from '../src/builder.js';
import { DEFAULT_PARAMS, TEMPLATES, TEMPLATE_IDS, type TemplateParams } from '../src/templates.js';
import { PROVEN_TEXT_TRANSFORM, type DocNodeEntry, type GraphiteDocument } from '../src/values.js';
import { SpecInvalidError } from '../src/errors.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Finds a top-level node entry by id. */
function node(doc: GraphiteDocument, id: number): DocNodeEntry {
  const entry = doc.network_interface.network.nodes.find(([nodeId]) => nodeId === id);
  if (!entry) throw new Error(`node ${id} not found in document`);
  return entry[1];
}

/** The implementation name of a ProtoNode entry ('Network' for wrappers). */
function implName(nodeEntry: DocNodeEntry): string {
  if (!('ProtoNode' in nodeEntry.implementation)) return 'Network';
  return nodeEntry.implementation.ProtoNode.name;
}

/** Walks nested value input to its tagged payload (unwraps the variant key). */
function taggedPayload(input: unknown): Record<string, unknown> {
  const v = (input as { Value?: { tagged_value?: Record<string, unknown> } }).Value?.tagged_value;
  if (typeof v !== 'object' || v === null) throw new Error(`not a tagged value: ${JSON.stringify(input)}`);
  return v;
}

describe('builder: template ids', () => {
  it('exposes exactly the four brief-mandated templates', () => {
    expect(TEMPLATE_IDS).toEqual(['duotone-image', 'pattern-background', 'solid-background', 'text-on-background']);
  });

  it('rejects an unknown template id with the known ids listed', () => {
    try {
      buildDocument('gradient-machine', {});
      expect.unreachable('buildDocument must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpecInvalidError);
      const e = err as SpecInvalidError;
      expect(e.code).toBe('SPEC_INVALID');
      expect(e.message).toMatch(/unknown template id "gradient-machine"/);
      for (const id of TEMPLATE_IDS) expect(e.message).toContain(id);
    }
  });
});

describe('builder: solid-background', () => {
  const params = { variant: 'solid' as const, width: 1000, height: 500, color: { red: 0.9, green: 0.2, blue: 0.1 } };
  const doc = buildDocument('solid-background', params).document;

  it('chains EmptyImage → generic wrapper → CreateArtboard and exports the artboard', () => {
    expect(implName(node(doc, 101))).toBe('raster_nodes::std_nodes::EmptyImageNode');
    expect(implName(node(doc, 102))).toBe('Network'); // generic graphic wrapper
    expect(implName(node(doc, 103))).toBe('Network'); // CreateArtboard wrapper
    // the artboard wrapper's inner network creates the artboard
    const artboard = node(doc, 103);
    if (!('Network' in artboard.implementation)) throw new Error('node 103 is not a Network');
    const innerNames = artboard.implementation.Network.nodes.map(
      ([, n]) => ('ProtoNode' in n.implementation ? n.implementation.ProtoNode.name : 'Network'),
    );
    expect(innerNames).toContain('graphic_nodes::artboard::CreateArtboardNode');
    // the document exports point AT the artboard wrapper
    expect(doc.network_interface.network.exports).toEqual([{ Node: { node_id: 103, output_index: 0 } }]);
  });

  it('lands the color in the EmptyImage input and the artboard background slot', () => {
    const emptyImageColor = taggedPayload(node(doc, 101).inputs[1]).Color as Record<string, number>;
    expect(emptyImageColor).toMatchObject({ red: 0.9, green: 0.2, blue: 0.1, linear: true });
    const artboardBg = taggedPayload(node(doc, 103).inputs[4]).Color as Record<string, number>;
    expect(artboardBg).toMatchObject({ red: 0.9, green: 0.2, blue: 0.1, linear: true });
  });

  it('encodes size in the EmptyImage transform AND the artboard dimensions', () => {
    const transform = taggedPayload(node(doc, 101).inputs[0]).DAffine2 as number[];
    expect(transform).toEqual([1000, 0, 0, 500, 0, 0]); // p5-proven W×H axis-length encoding
    const dims = taggedPayload(node(doc, 103).inputs[3]).DVec2 as number[];
    expect(dims).toEqual([1000, 500]);
  });

  it('builds the gradient variant on the Rectangle → Transform → Fill route', () => {
    const gdoc = buildDocument('solid-background', {
      variant: 'gradient',
      width: 1000,
      height: 500,
      from: { red: 0, green: 0, blue: 0 },
      to: { red: 1, green: 1, blue: 1 },
    }).document;
    expect(implName(node(gdoc, 101))).toBe('vector_nodes::generator_nodes::RectangleNode');
    expect(implName(node(gdoc, 102))).toBe('Network'); // Monitor+Transform wrapper
    expect(implName(node(gdoc, 103))).toBe('graphene_core::vector::FillNode');
    expect(implName(node(gdoc, 104))).toBe('Network'); // generic wrapper
    expect(implName(node(gdoc, 105))).toBe('Network'); // artboard wrapper
    expect(gdoc.network_interface.network.exports).toEqual([{ Node: { node_id: 105, output_index: 0 } }]);
    // transform wrapper centers→artboard: translation = [w/2, h/2]
    const translation = taggedPayload(node(gdoc, 102).inputs[1]).DVec2 as number[];
    expect(translation).toEqual([500, 250]);
    // the gradient ramp carries BOTH param colors in the paint slot
    const stops = (taggedPayload(node(gdoc, 103).inputs[1]).GradientRamp as { stops: { color: Record<string, number>[] } }).stops.color;
    expect(stops[0]).toMatchObject({ red: 0, green: 0, blue: 0, linear: true });
    expect(stops[1]).toMatchObject({ red: 1, green: 1, blue: 1, linear: true });
    // _has_transform false → gradient auto-placement
    expect(taggedPayload(node(gdoc, 103).inputs[5]).Bool).toBe(false);
  });
});

describe('builder: pattern-background', () => {
  const doc = buildDocument('pattern-background', { width: 800, height: 400, seed: 7, scale: 12.5 }).document;

  it('chains NoisePattern (clip disabled) → generic wrapper → CreateArtboard', () => {
    expect(implName(node(doc, 101))).toBe('raster_nodes::std_nodes::NoisePatternNode');
    expect(implName(node(doc, 102))).toBe('Network');
    expect(implName(node(doc, 103))).toBe('Network');
    expect(doc.network_interface.network.exports).toEqual([{ Node: { node_id: 103, output_index: 0 } }]);
  });

  it('lands seed and scale in the NoisePattern inputs and disables clipping', () => {
    const noise = node(doc, 101);
    expect(taggedPayload(noise.inputs[1]).Bool).toBe(false); // clip = false → full-bleed
    expect(taggedPayload(noise.inputs[2]).U32).toBe(7);
    expect(taggedPayload(noise.inputs[3]).F64).toBe(12.5);
    // full 16-input serialization (source order, demo-verified)
    expect(noise.inputs).toHaveLength(16);
  });

  it('encodes the artboard dimensions', () => {
    const dims = taggedPayload(node(doc, 103).inputs[3]).DVec2 as number[];
    expect(dims).toEqual([800, 400]);
  });
});

describe('builder: text-on-background', () => {
  const params = {
    width: 1000,
    height: 500,
    background: { red: 0.06, green: 0.06, blue: 0.08 },
    text: 'HELLO GRAPHITE',
    textColor: { red: 0.12, green: 0.42, blue: 0.95 },
  };
  const doc = buildDocument('text-on-background', params).document;

  it('chains TextNode → TextToVector → Fill → generic wrapper → CreateArtboard', () => {
    expect(implName(node(doc, 101))).toBe('graphene_std::text::TextNode');
    expect(implName(node(doc, 102))).toBe('graphene_std::text::TextToVectorNode');
    expect(implName(node(doc, 103))).toBe('graphene_core::vector::FillNode');
    expect(implName(node(doc, 104))).toBe('Network');
    expect(implName(node(doc, 105))).toBe('Network');
    expect(doc.network_interface.network.exports).toEqual([{ Node: { node_id: 105, output_index: 0 } }]);
  });

  it('lands text and font size in the TextNode and the fallback-font marker is present', () => {
    const textNode = node(doc, 101);
    expect(textNode.inputs).toHaveLength(12); // source-order inputs of fn text
    expect(taggedPayload(textNode.inputs[1]).String).toBe('HELLO GRAPHITE');
    expect(taggedPayload(textNode.inputs[2]).TypeDefault).toEqual({
      Item: { Concrete: { name: 'graphene_resource::Resource' } },
    });
    expect(taggedPayload(textNode.inputs[3]).F64).toBe(48); // default font size
  });

  it('carries the proven placement transform in the Fill node', () => {
    const fill = node(doc, 103);
    const paint = taggedPayload(fill.inputs[1]).Color as Record<string, number>;
    expect(paint).toMatchObject({ red: 0.12, green: 0.42, blue: 0.95, linear: true });
    expect(taggedPayload(fill.inputs[5]).Bool).toBe(true); // _has_transform
    expect(taggedPayload(fill.inputs[6]).DAffine2).toEqual([...PROVEN_TEXT_TRANSFORM]);
  });

  it('lands the background color in the artboard background slot', () => {
    const bg = taggedPayload(node(doc, 105).inputs[4]).Color as Record<string, number>;
    expect(bg).toMatchObject({ red: 0.06, green: 0.06, blue: 0.08, linear: true });
  });

  it('honors the fontSize parameter', () => {
    const big = buildDocument('text-on-background', { ...params, fontSize: 96 }).document;
    expect(taggedPayload(node(big, 101).inputs[3]).F64).toBe(96);
  });
});

describe('builder: duotone-image', () => {
  const doc = buildDocument('duotone-image', {
    width: 1000,
    height: 500,
    seed: 3,
    scale: 35,
    dark: { red: 0.02, green: 0.02, blue: 0.12 },
    light: { red: 1, green: 0.3, blue: 0.03 },
    reverse: true,
  }).document;

  it('chains NoisePattern → Levels → GradientMap → generic wrapper → CreateArtboard', () => {
    expect(implName(node(doc, 101))).toBe('raster_nodes::std_nodes::NoisePatternNode');
    expect(implName(node(doc, 105))).toBe('raster_nodes::adjustments::LevelsNode');
    expect(implName(node(doc, 102))).toBe('raster_nodes::adjustments::GradientMapNode');
    expect(implName(node(doc, 103))).toBe('Network');
    expect(implName(node(doc, 104))).toBe('Network');
    expect(doc.network_interface.network.exports).toEqual([{ Node: { node_id: 104, output_index: 0 } }]);
  });

  it('feeds the stretched noise into the GradientMap and lands the ramp colors + reverse flag', () => {
    const map = node(doc, 102);
    expect(map.inputs[0]).toEqual({ Node: { node_id: 105, output_index: 0 } }); // the Levels-stretched field
    const levels = node(doc, 105);
    expect(implName(levels)).toBe('raster_nodes::adjustments::LevelsNode');
    expect(levels.inputs[0]).toEqual({ Node: { node_id: 101, output_index: 0 } }); // fed by the noise
    // composite input black/white points: the field stretch that makes the ramp's shadow stop reachable
    expect(taggedPayload(levels.inputs[1]).F32).toBe(25);
    expect(taggedPayload(levels.inputs[3]).F32).toBe(90);
    const ramp = taggedPayload(map.inputs[1]).GradientRamp as {
      stops: { color: Record<string, number>[]; position: number[]; midpoint: number[] };
      gradient_space: string;
    };
    expect(ramp.gradient_space).toBe('RgbGamma');
    expect(ramp.stops.position).toEqual([0, 1]);
    expect(ramp.stops.midpoint).toEqual([0.5, 0.5]);
    expect(ramp.stops.color[0]).toMatchObject({ red: 0.02, green: 0.02, blue: 0.12, linear: true });
    expect(ramp.stops.color[1]).toMatchObject({ red: 1, green: 0.3, blue: 0.03, linear: true });
    expect(taggedPayload(map.inputs[2]).Bool).toBe(true); // reverse
  });

  it('defaults reverse to false when omitted', () => {
    const plain = buildDocument('duotone-image', {
      width: 10,
      height: 10,
      seed: 0,
      scale: 1,
      dark: { red: 0, green: 0, blue: 0 },
      light: { red: 1, green: 1, blue: 1 },
    }).document;
    expect(taggedPayload(node(plain, 102).inputs[2]).Bool).toBe(false);
  });
});

describe('builder: precise parameter errors (SpecInvalidError taxonomy)', () => {
  it('refuses missing width (both dimensions always required)', () => {
    expect(() =>
      buildDocument('solid-background', { variant: 'solid', height: 500, color: { red: 1, green: 0, blue: 0 } }),
    ).toThrow(SpecInvalidError);
    try {
      buildDocument('pattern-background', { height: 500, seed: 0, scale: 35 });
      expect.unreachable();
    } catch (err) {
      expect((err as SpecInvalidError).message).toMatch(/width/);
      expect((err as SpecInvalidError).message).toMatch(/Both width and height are always required/);
    }
  });

  it('refuses non-positive and fractional sizes', () => {
    expect(() => buildDocument('duotone-image', { width: 0, height: 500, seed: 0, scale: 35, dark: { red: 0, green: 0, blue: 0 }, light: { red: 1, green: 1, blue: 1 } })).toThrow(SpecInvalidError);
    expect(() => buildDocument('pattern-background', { width: 10.5, height: 500, seed: 0, scale: 35 })).toThrow(SpecInvalidError);
  });

  it('refuses out-of-range color channels with the channel named', () => {
    try {
      buildDocument('solid-background', { variant: 'solid', width: 10, height: 10, color: { red: 1.5, green: 0, blue: 0 } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpecInvalidError);
      expect((err as SpecInvalidError).message).toMatch(/channel red is 1\.5/);
    }
  });

  it('refuses out-of-range seeds (u32) and non-positive scales', () => {
    expect(() => buildDocument('pattern-background', { width: 10, height: 10, seed: -1, scale: 35 })).toThrow(/seed/u);
    expect(() => buildDocument('pattern-background', { width: 10, height: 10, seed: 4294967296, scale: 35 })).toThrow(/seed/u);
    expect(() => buildDocument('pattern-background', { width: 10, height: 10, seed: 0, scale: 0 })).toThrow(/scale/u);
  });

  it('refuses empty text', () => {
    expect(() =>
      buildDocument('text-on-background', {
        width: 100,
        height: 100,
        background: { red: 0, green: 0, blue: 0 },
        text: '   ',
        textColor: { red: 1, green: 1, blue: 1 },
      }),
    ).toThrow(/text/);
  });

  it('refuses an unknown solid-background variant', () => {
    expect(() => buildDocument('solid-background', { variant: 'plaid', width: 10, height: 10, color: { red: 0, green: 0, blue: 0 } })).toThrow(
      /variant: 'solid' \| 'gradient' \(got plaid\)/u,
    );
  });
});

describe('serializeDocument: determinism', () => {
  it('is byte-stable across repeated builds and serializations', () => {
    const params: TemplateParams = { ...DEFAULT_PARAMS['duotone-image'] };
    const first = serializeDocument(buildDocument('duotone-image', params).document);
    const second = serializeDocument(buildDocument('duotone-image', params).document);
    expect(second).toBe(first);
    // stable key order: JSON round-trip of the same object yields the same bytes
    const reparsed = JSON.parse(first) as GraphiteDocument;
    expect(serializeDocument(reparsed)).toBe(first);
  });

  it('ends with a trailing newline and uses 2-space indent (fixture file convention)', () => {
    const text = serializeDocument(buildDefaultDocument('solid-background').document);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.startsWith('{\n  "network_interface"')).toBe(true);
  });
});

describe('round-trip: trial fixtures reserialize to the same JSON value', () => {
  for (const fixture of ['p4-hand-authored.graphite', 'p5-custom-duotone.graphite']) {
    it(`round-trips ${fixture}`, () => {
      const raw = readFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', fixture), 'utf8');
      const parsed = JSON.parse(raw) as GraphiteDocument;
      const reserialized = serializeDocument(parsed);
      expect(JSON.parse(reserialized)).toEqual(parsed);
    });
  }
});

describe('committed sample outputs', () => {
  for (const id of TEMPLATE_IDS) {
    it(`templates/${id}.graphite is byte-identical to the default-param build (drift guard)`, () => {
      const onDisk = readFileSync(path.join(PROJECT_ROOT, 'templates', `${id}.graphite`), 'utf8');
      const built = serializeDocument(buildDefaultDocument(id).document);
      expect(onDisk).toBe(built);
    });
  }
});

describe('writeDocument', () => {
  it('rejects paths without the .graphite extension', async () => {
    await expect(
      writeDocument('/tmp/should-never-be-written.png', buildDefaultDocument('solid-background').document),
    ).rejects.toBeInstanceOf(SpecInvalidError);
  });

  it('creates parent directories and writes the serialized document', async () => {
    const target = path.join(PROJECT_ROOT, 'tmp', 'builder-test', 'nested', 'doc.graphite');
    const written = await writeDocument(target, buildDefaultDocument('pattern-background').document);
    expect(written).toBe(target);
    const onDisk = readFileSync(target, 'utf8');
    expect(onDisk).toBe(serializeDocument(buildDefaultDocument('pattern-background').document));
  });
});

describe('template manifest shape', () => {
  it('every template carries description, params summary, type name and a build fn', () => {
    for (const [id, definition] of Object.entries(TEMPLATES)) {
      expect(typeof definition.description, id).toBe('string');
      expect(definition.description.length, id).toBeGreaterThan(0);
      expect(typeof definition.paramsSummary, id).toBe('string');
      expect(definition.paramsSummary.length, id).toBeGreaterThan(0);
      expect(definition.paramsTypeName, id).toMatch(/Params$/u);
      expect(typeof definition.build, id).toBe('function');
    }
  });

  it('buildDefaultDocument covers every template id', () => {
    for (const id of TEMPLATE_IDS) {
      const doc = buildDefaultDocument(id).document;
      expect(Object.keys(doc)).toContain('network_interface');
    }
  });
});
