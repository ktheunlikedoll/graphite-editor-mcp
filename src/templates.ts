/**
 * The four Graphite templates: factories that produce a complete .graphite
 * document object from typed parameters.
 *
 * CHAIN PROVENANCE (every chain compiled and/or rendered by the pinned CLI):
 *  - solid-background  — p5 trial chain minus the adjustment:
 *                        EmptyImage → generic wrapper → CreateArtboard
 *                        (`p5-custom-duotone.graphite`, renders headlessly).
 *                        The gradient variant uses the demo-proven vector route
 *                        Rectangle → Fill (`parametric-dunescape.graphite`,
 *                        Fill `_has_transform: false` → gradient auto-covers
 *                        the shape's bounding box).
 *  - pattern-background — `raster_nodes::std_nodes::NoisePatternNode` with
 *                        `clip: false` (full-bleed; default clips to 100x100).
 *                        Full 16-input serialization copied from the working
 *                        demo `marbled-mandelbrot.graphite`.
 *  - text-on-background — director-executed TextNode chain
 *                        (`tmp/p4-direct-text-itemwrapped.graphite`): TextNode
 *                        (fallback font via TypeDefault Resource) →
 *                        TextToVector → Fill (proven placement transform) →
 *                        generic wrapper → CreateArtboard. Rendered to a valid
 *                        1000x500 PNG by the pinned CLI.
 *  - duotone-image      — demo-proven NoisePattern → GradientMap chain
 *                        (`marbled-mandelbrot.graphite`), top-level layout per
 *                        the p5 trial. GradientMap maps gamma luma
 *                        (0.3/0.59/0.11) through the two-stop ramp and
 *                        preserves source alpha.
 */

import { SpecInvalidError } from './errors.js';
import {
  ArtboardOptions,
  DocInput,
  DocNodeEntry,
  GraphiteDocument,
  PROVEN_TEXT_TRANSFORM,
  RgbColor,
  artboardWrapperNode,
  assembleDocument,
  boolValue,
  colorValue,
  dAffine2Value,
  f64Value,
  genericWrapperNode,
  gradientRampValue,
  nodeInput,
  monitorTransformWrapperNode,
  nonePrimaryValue,
  nullNonePrimaryValue,
  protoNodeEntry,
  stringValue,
  u32Value,
} from './values.js';

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

/** A typed color parameter: linear-RGB channels in 0..1. */
export interface ColorParam {
  red: number;
  green: number;
  blue: number;
  /** 0..1; defaults to 1 (opaque). */
  alpha?: number;
}

export interface SolidBackgroundSolidParams {
  variant: 'solid';
  /** Document (artboard) width in pixels. */
  width: number;
  /** Document (artboard) height in pixels. */
  height: number;
  /** The solid background color. */
  color: ColorParam;
}

export interface SolidBackgroundGradientParams {
  variant: 'gradient';
  /** Document (artboard) width in pixels. */
  width: number;
  /** Document (artboard) height in pixels. */
  height: number;
  /** Gradient stop at position 0. */
  from: ColorParam;
  /** Gradient stop at position 1. */
  to: ColorParam;
}

export type SolidBackgroundParams = SolidBackgroundSolidParams | SolidBackgroundGradientParams;

export interface PatternBackgroundParams {
  width: number;
  height: number;
  /** Noise seed (u32). Different seeds give visibly different patterns. */
  seed: number;
  /** Noise scale: larger values give finer-grained texture. */
  scale: number;
}

export interface TextOnBackgroundParams {
  width: number;
  height: number;
  /** Background color behind the text. */
  background: ColorParam;
  /** The text to render (fallback font). Non-empty. */
  text: string;
  /** The text fill color. */
  textColor: ColorParam;
  /**
   * Font size in px (TextNode `size` input). Default 48 — the size of the
   * director-verified render the placement transform was proven with. Larger
   * sizes render larger text near the same anchor; placement is NOT re-derived
   * per size (see templates/README.md).
   */
  fontSize?: number;
}

export interface DuotoneImageParams {
  width: number;
  height: number;
  /** Noise seed feeding the GradientMap. */
  seed: number;
  /** Noise scale. */
  scale: number;
  /** Ramp stop at position 0 (maps darkest luma). */
  dark: ColorParam;
  /** Ramp stop at position 1 (maps lightest luma). */
  light: ColorParam;
  /** Reverse the ramp mapping (dark ↔ light). Default false. */
  reverse?: boolean;
}

export type TemplateParams =
  | SolidBackgroundParams
  | PatternBackgroundParams
  | TextOnBackgroundParams
  | DuotoneImageParams;

export type TemplateId = 'solid-background' | 'pattern-background' | 'text-on-background' | 'duotone-image';

// ---------------------------------------------------------------------------
// Parameter validation (precise SpecInvalidError failures — Phase-2 taxonomy)
// ---------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return typeof value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SpecInvalidError(
      `${field} must be a positive integer (got ${describeValue(value)}). ` +
        `Both width and height are always required — graphene-cli silently renders a 1x1 ` +
        `default viewport when a dimension is missing, so Graphite refuses incomplete sizes.`,
    );
  }
  return value;
}

function requireColor(value: unknown, field: string): RgbColor {
  const fail = (why: string): never => {
    throw new SpecInvalidError(
      `${field} must be a color object with red/green/blue (and optional alpha) channels in 0..1 ` +
        `(${why}). Colors are linear-space RGB, serialized with linear: true.`,
    );
  };
  if (typeof value !== 'object' || value === null) fail(`got ${describeValue(value)}`);
  const c = value as Record<string, unknown>;
  for (const channel of ['red', 'green', 'blue'] as const) {
    const v = c[channel];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      fail(`channel ${channel} is ${describeValue(v)}`);
    }
  }
  const alpha = c.alpha === undefined ? 1 : c.alpha;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    fail(`alpha is ${describeValue(alpha)}`);
  }
  return {
    red: c.red as number,
    green: c.green as number,
    blue: c.blue as number,
    alpha: alpha as number,
    linear: true,
  };
}

function requireSeed(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new SpecInvalidError(
      `${field} must be an integer in 0..4294967295 (got ${describeValue(value)}) — ` +
        `the NoisePattern seed is a u32 engine input.`,
    );
  }
  return value;
}

function requireScale(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SpecInvalidError(
      `${field} must be a positive, finite number (got ${describeValue(value)}) — ` +
        `it sets the NoisePattern feature size in engine units.`,
    );
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpecInvalidError(
      `${field} must be a non-empty string (got ${describeValue(value)}) — ` +
        `empty text produces no geometry, which cannot be a meaningful artifact.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shared artboard defaults (proven trial values)
// ---------------------------------------------------------------------------

/** Neutral artboard background used by the trials (inert when layers cover it). */
const TRIAL_ARTBOARD_COLOR: RgbColor = { red: 0.06, green: 0.06, blue: 0.08, alpha: 1, linear: true };

function artboardOptions(width: number, height: number, background: RgbColor): ArtboardOptions {
  return { x: 0, y: 0, width, height, background };
}

// ---------------------------------------------------------------------------
// Template (a): solid-background
// ---------------------------------------------------------------------------

/**
 * Solid variant: EmptyImage → generic wrapper → CreateArtboard (p5 chain minus
 * the adjustment). The color fills BOTH the EmptyImage raster and the artboard
 * background slot so the visible result is unambiguous.
 */
function buildSolidSolid(params: SolidBackgroundSolidParams): GraphiteDocument {
  const width = requirePositiveInteger(params.width, 'width');
  const height = requirePositiveInteger(params.height, 'height');
  const color = requireColor(params.color, 'color');

  const nodes: Array<[number, DocNodeEntry]> = [
    [
      101,
      protoNodeEntry('raster_nodes::std_nodes::EmptyImageNode', [
        // [0] transform: axis lengths encode W x H (p5 trial: [1000, 0, 0, 500, 0, 0])
        dAffine2Value([width, 0, 0, height, 0, 0]),
        // [1] color
        colorValue(color),
      ]),
    ],
    [102, genericWrapperNode(101)],
    [103, artboardWrapperNode(102, artboardOptions(width, height, color))],
  ];
  return assembleDocument(nodes, 103);
}

/**
 * Gradient variant: Rectangle → Monitor+Transform (moves the rect, which the
 * engine generates CENTERED at the origin, onto the artboard area) → Fill
 * (GradientRamp paint) → generic wrapper → CreateArtboard. The transform route
 * is the demo-proven placement primitive (`marbled-mandelbrot.graphite`); Fill
 * `_has_transform: false` then auto-derives the gradient placement from the
 * transformed shape's bounding box — no manual gradient transform math.
 */
function buildSolidGradient(params: SolidBackgroundGradientParams): GraphiteDocument {
  const width = requirePositiveInteger(params.width, 'width');
  const height = requirePositiveInteger(params.height, 'height');
  const from = requireColor(params.from, 'from');
  const to = requireColor(params.to, 'to');

  const nodes: Array<[number, DocNodeEntry]> = [
    [
      101,
      protoNodeEntry('vector_nodes::generator_nodes::RectangleNode', [
        // [0] primary — demo spelling: bare "None"
        nonePrimaryValue(),
        // [1] width
        f64Value(width),
        // [2] height
        f64Value(height),
        // [3] corner radius (sharp corners)
        {
          Value: { tagged_value: { BoxCorners: [0.0] }, exposed: false },
        },
        // [4] clamped (demo sends true)
        boolValue(true),
        // [5] individual corner radii (demo sends false)
        boolValue(false),
      ]),
    ],
    // [102] translation +width/2, +height/2: rect [-w/2..w/2] x [-h/2..h/2] → [0..w] x [0..h]
    [102, monitorTransformWrapperNode(101, { translation: [width / 2, height / 2] })],
    [
      103,
      protoNodeEntry('graphene_core::vector::FillNode', [
        // [0] content (the placed rectangle)
        nodeInput(102),
        // [1] paint — the gradient itself; auto-placement via _has_transform=false
        gradientRampValue([from, to]),
        // [2] _backup_color
        colorValue(from),
        // [3] _backup_gradient (same ramp, demo/p4 proven backup slot)
        gradientRampValue([from, to]),
        // [4] _gradient_form
        { Value: { tagged_value: { GradientForm: 'Linear' }, exposed: false } },
        // [5] _has_transform: false → gradient auto-covers the shape bbox
        boolValue(false),
        // [6] _transform (inert identity while _has_transform is false)
        dAffine2Value([1, 0, 0, 1, 0, 0]),
      ]),
    ],
    [104, genericWrapperNode(103)],
    [105, artboardWrapperNode(104, artboardOptions(width, height, to))],
  ];
  return assembleDocument(nodes, 105);
}

function buildSolidBackground(params: SolidBackgroundParams): GraphiteDocument {
  const variant =
    typeof params === 'object' && params !== null ? (params as { variant?: unknown }).variant : undefined;
  if (variant !== 'solid' && variant !== 'gradient') {
    throw new SpecInvalidError(
      `solid-background params must carry variant: 'solid' | 'gradient' (got ${describeValue(variant)})`,
    );
  }
  if (variant === 'solid') return buildSolidSolid(params as SolidBackgroundSolidParams);
  return buildSolidGradient(params as SolidBackgroundGradientParams);
}

// ---------------------------------------------------------------------------
// Noise pattern serialization (16 inputs, exact source order)
// ---------------------------------------------------------------------------

/**
 * Full NoisePatternNode input list, order verified against the pinned source
 * (`node-graph/nodes/raster/src/std_nodes.rs` noise_pattern) and the working
 * demo `marbled-mandelbrot.graphite`. Enum values copied from the demo;
 * `clip: false` for full-bleed (the default clips to the 100x100 square).
 */
function noisePatternInputs(seed: number, scale: number): DocInput[] {
  return [
    nonePrimaryValue(), // [0] _primary
    boolValue(false), // [1] clip = false → full-bleed
    u32Value(seed), // [2] seed
    f64Value(scale), // [3] scale
    { Value: { tagged_value: { NoiseType: 'OpenSimplex2' }, exposed: false } }, // [4] noise_type
    { Value: { tagged_value: { DomainWarpType: 'OpenSimplex2' }, exposed: false } }, // [5] domain_warp_type
    f64Value(100.0), // [6] domain_warp_amplitude
    { Value: { tagged_value: { FractalType: 'PingPong' }, exposed: false } }, // [7] fractal_type
    u32Value(3), // [8] fractal_octaves
    f64Value(2.0), // [9] fractal_lacunarity
    f64Value(0.5), // [10] fractal_gain
    f64Value(0.0), // [11] fractal_weighted_strength (no source default — always sent)
    f64Value(2.0), // [12] fractal_ping_pong_strength
    { Value: { tagged_value: { CellularDistanceFunction: 'Hybrid' }, exposed: false } }, // [13] cellular_distance_function
    { Value: { tagged_value: { CellularReturnType: 'CellValue' }, exposed: false } }, // [14] cellular_return_type
    f64Value(1.0), // [15] cellular_jitter
  ];
}

// ---------------------------------------------------------------------------
// Template (b): pattern-background
// ---------------------------------------------------------------------------

function buildPatternBackground(params: PatternBackgroundParams): GraphiteDocument {
  const width = requirePositiveInteger(params.width, 'width');
  const height = requirePositiveInteger(params.height, 'height');
  const seed = requireSeed(params.seed, 'seed');
  const scale = requireScale(params.scale, 'scale');

  const nodes: Array<[number, DocNodeEntry]> = [
    [101, protoNodeEntry('raster_nodes::std_nodes::NoisePatternNode', noisePatternInputs(seed, scale))],
    [102, genericWrapperNode(101)],
    [103, artboardWrapperNode(102, artboardOptions(width, height, TRIAL_ARTBOARD_COLOR))],
  ];
  return assembleDocument(nodes, 103);
}

// ---------------------------------------------------------------------------
// Template (c): text-on-background
// ---------------------------------------------------------------------------

/**
 * Director-executed TextNode chain. Input order verified against the pinned
 * source (`node-graph/nodes/gstd/src/text.rs`, `fn text`). The font input is
 * the TypeDefault Resource marker → the engine's embedded fallback font. The
 * Fill node carries the PROVEN placement transform from the director-verified
 * document, copied verbatim.
 */
function buildTextOnBackground(params: TextOnBackgroundParams): GraphiteDocument {
  const width = requirePositiveInteger(params.width, 'width');
  const height = requirePositiveInteger(params.height, 'height');
  const background = requireColor(params.background, 'background');
  const text = requireText(params.text, 'text');
  const textColor = requireColor(params.textColor, 'textColor');
  const fontSize = params.fontSize === undefined ? 48 : requireScale(params.fontSize, 'fontSize');

  const nodes: Array<[number, DocNodeEntry]> = [
    [
      101,
      protoNodeEntry('graphene_std::text::TextNode', [
        nullNonePrimaryValue(), // [0] _primary
        stringValue(text), // [1] text
        // [2] font — TypeDefault Resource → embedded fallback font
        {
          Value: {
            tagged_value: { TypeDefault: { Item: { Concrete: { name: 'graphene_resource::Resource' } } } },
            exposed: false,
          },
        },
        f64Value(fontSize), // [3] size
        f64Value(1.2), // [4] line_height (proven default)
        f64Value(0.0), // [5] letter_spacing
        f64Value(0.0), // [6] letter_tilt
        boolValue(false), // [7] has_max_width
        f64Value(width), // [8] max_width (inert while has_max_width is false)
        boolValue(false), // [9] has_max_height
        f64Value(height), // [10] max_height (inert while has_max_height is false)
        { Value: { tagged_value: { TextAlign: 'AlignLeft' }, exposed: false } }, // [11] align
      ]),
    ],
    [102, protoNodeEntry('graphene_std::text::TextToVectorNode', [nodeInput(101)])],
    [
      103,
      protoNodeEntry('graphene_core::vector::FillNode', [
        nodeInput(102), // [0] content
        colorValue(textColor), // [1] paint — the text color
        colorValue(textColor), // [2] _backup_color
        gradientRampValue([{ red: 1, green: 1, blue: 1, alpha: 1, linear: true }, { red: 0, green: 0, blue: 0, alpha: 1, linear: true }]), // [3] _backup_gradient (p4-direct proven backup)
        { Value: { tagged_value: { GradientForm: 'Linear' }, exposed: false } }, // [4] _gradient_form
        boolValue(true), // [5] _has_transform
        dAffine2Value(PROVEN_TEXT_TRANSFORM), // [6] _transform — proven placement
      ]),
    ],
    [104, genericWrapperNode(103)],
    [105, artboardWrapperNode(104, artboardOptions(width, height, background))],
  ];
  return assembleDocument(nodes, 105);
}

// ---------------------------------------------------------------------------
// Template (d): duotone-image
// ---------------------------------------------------------------------------

/**
 * Levels input black/white points (composite channel, percentage units) for
 * the duotone chain's field stretch. The NoisePattern output has a measured
 * luminance floor ≈0.25 and ceiling <0.9 for every noise/fractal/warp config,
 * so an un-stretched field never reaches the GradientMap ramp's shadow stop
 * (probe evidence: 6-config sweep, 0.0% of pixels below luma 64). 25 / 90
 * stretch the field to the full 0..1 range — measured on the rendered sample:
 * ramp luma span [7.9..122.5] (linear-255) fully covered, min 1.0 / max 122.5.
 */
const DUOTONE_LEVELS_INPUT_BLACK = 25.0;
const DUOTONE_LEVELS_INPUT_WHITE = 90.0;

/**
 * Full LevelsNode input list (composite + R/G/B/A channel groups), order
 * verified against the pinned source (`node-graph/nodes/raster/src/
 * adjustments.rs`, `fn levels`): image, then per-channel groups of 5 —
 * shadows (percentage, input black point), midtones (gamma), highlights
 * (percentage, input white point), output minimums (percentage), output
 * maximums (percentage) — with `PercentageF32 = f32` on the wire
 * (`node-graph/libraries/no-std-types/src/registry.rs`). Only the composite
 * group is non-default; channel groups carry their defaults explicitly.
 */
function duotoneLevelsInputs(imageNodeId: number): DocInput[] {
  const f32 = (n: number): DocInput => ({ Value: { tagged_value: { F32: n }, exposed: false } });
  const channelDefaults = (): DocInput[] => [f32(0), f32(1), f32(100), f32(0), f32(100)];
  return [
    nodeInput(imageNodeId), // [0] image
    f32(DUOTONE_LEVELS_INPUT_BLACK), // [1] shadows — input black point (%)
    f32(1), // [2] midtones — gamma (default)
    f32(DUOTONE_LEVELS_INPUT_WHITE), // [3] highlights — input white point (%)
    f32(0), // [4] output minimums (default)
    f32(100), // [5] output maximums (default)
    ...channelDefaults(), // [6..10] red
    ...channelDefaults(), // [11..15] green
    ...channelDefaults(), // [16..20] blue
    ...channelDefaults(), // [21..25] alpha
  ];
}

/**
 * Demo-proven NoisePattern → Levels (field stretch) → GradientMap chain,
 * top-level layout per the p5 trial. GradientMapNode input order verified
 * against the pinned source (`node-graph/nodes/raster/src/adjustments.rs`,
 * `fn gradient_map`); LevelsNode against `fn levels` in the same file. The
 * Levels stretch is required: the raw noise field's ≈0.25 luminance floor
 * never reaches the ramp's shadow stop (see DUOTONE_LEVELS_* constants).
 */
function buildDuotoneImage(params: DuotoneImageParams): GraphiteDocument {
  const width = requirePositiveInteger(params.width, 'width');
  const height = requirePositiveInteger(params.height, 'height');
  const seed = requireSeed(params.seed, 'seed');
  const scale = requireScale(params.scale, 'scale');
  const dark = requireColor(params.dark, 'dark');
  const light = requireColor(params.light, 'light');
  const reverse = params.reverse === true;

  const nodes: Array<[number, DocNodeEntry]> = [
    [101, protoNodeEntry('raster_nodes::std_nodes::NoisePatternNode', noisePatternInputs(seed, scale))],
    [105, protoNodeEntry('raster_nodes::adjustments::LevelsNode', duotoneLevelsInputs(101))],
    [
      102,
      protoNodeEntry('raster_nodes::adjustments::GradientMapNode', [
        nodeInput(105), // [0] image — the level-stretched noise field
        gradientRampValue([dark, light]), // [1] gradient — the two-stop duotone ramp
        boolValue(reverse), // [2] reverse
      ]),
    ],
    [103, genericWrapperNode(102)],
    [104, artboardWrapperNode(103, artboardOptions(width, height, dark))],
  ];
  return assembleDocument(nodes, 104);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface TemplateDefinition<P = TemplateParams> {
  /** One-line description of what the template produces. */
  description: string;
  /** Human-readable parameter summary (for MCP tool introspection later). */
  paramsSummary: string;
  /** The typed parameter interface name. */
  paramsTypeName: string;
  /** Builds the complete document object from validated parameters. */
  build(params: P): GraphiteDocument;
}

/** A definition whose build accepts any template's params (after validation). */
export type AnyTemplateDefinition = TemplateDefinition<TemplateParams>;

/** Default parameters — one per template; drives the committed sample outputs. */
export const DEFAULT_PARAMS: Record<TemplateId, TemplateParams> = {
  'solid-background': { variant: 'solid', width: 1000, height: 500, color: { red: 0.12, green: 0.42, blue: 0.95, alpha: 1 } },
  'pattern-background': { width: 1000, height: 500, seed: 0, scale: 35 },
  'text-on-background': {
    width: 1000,
    height: 500,
    background: { red: 0.06, green: 0.06, blue: 0.08, alpha: 1 },
    text: 'GRAPHITE TEMPLATE',
    textColor: { red: 0.12, green: 0.42, blue: 0.95, alpha: 1 },
    fontSize: 48,
  },
  'duotone-image': {
    width: 1000,
    height: 500,
    seed: 0,
    scale: 35,
    dark: { red: 0.02, green: 0.02, blue: 0.12, alpha: 1 },
    light: { red: 1.0, green: 0.3, blue: 0.03, alpha: 1 },
    reverse: false,
  },
};

/**
 * The template manifest. `build` performs full parameter validation and throws
 * SpecInvalidError with a precise message on any bad parameter.
 */
export const TEMPLATES: Record<TemplateId, AnyTemplateDefinition> = {
  'solid-background': {
    description: 'Full-bleed solid color background (EmptyImage route) or two-color linear gradient background (proven Rectangle→Fill vector route).',
    paramsSummary: 'variant: \'solid\' | \'gradient\'; width: int; height: int; color (solid) | from, to (gradient): linear-RGB channels 0..1',
    paramsTypeName: 'SolidBackgroundParams',
    build: buildSolidBackground as AnyTemplateDefinition['build'],
  },
  'pattern-background': {
    description: 'Procedural noise-pattern background (NoisePatternNode, clip disabled for full-bleed) rendered as grayscale luminance texture.',
    paramsSummary: 'width: int; height: int; seed: u32; scale: positive number',
    paramsTypeName: 'PatternBackgroundParams',
    build: buildPatternBackground as AnyTemplateDefinition['build'],
  },
  'text-on-background': {
    description: 'Fallback-font text (TextNode → TextToVector → Fill with the proven placement transform) over a solid background color.',
    paramsSummary: 'width: int; height: int; background: color; text: non-empty string; textColor: color; fontSize?: number (default 48)',
    paramsTypeName: 'TextOnBackgroundParams',
    build: buildTextOnBackground as AnyTemplateDefinition['build'],
  },
  'duotone-image': {
    description: 'Procedural noise mapped through a two-color gradient ramp (Levels field-stretch → GradientMap duotone; gamma-luma 0.3/0.59/0.11 → ramp position, alpha preserved).',
    paramsSummary: 'width: int; height: int; seed: u32; scale: positive number; dark, light: color (ramp stops); reverse?: boolean',
    paramsTypeName: 'DuotoneImageParams',
    build: buildDuotoneImage as AnyTemplateDefinition['build'],
  },
};

/** Every known template id, for precise unknown-id errors. */
export const TEMPLATE_IDS: readonly string[] = Object.keys(TEMPLATES).sort();
