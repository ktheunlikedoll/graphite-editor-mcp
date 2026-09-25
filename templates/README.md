# Graphite templates

Four document templates for the Graphite engine — typed params in, a complete
`.graphite` document out, proven by a real `graphene-cli` render. Built by
`buildDocument(id, params)` (`src/builder.ts`) from factories in
`src/templates.ts`; the `.graphite` files in this directory are the
**default-param instantiations**, byte-identical to `buildDefaultDocument(id)`
(enforced by a drift-guard test in `tests/builder.test.ts`).

Every template's epilogue (generic graphic wrapper → CreateArtboard wrapper →
single export) is copied verbatim from the execution-verified trial fixtures —
see "Provenance" per template and `src/values.ts` for the full ground-truth map.

## Render proofs (pinned CLI build, sha256 `1a45054d…dbc7`)

Rendered by `tests/templates-e2e.test.ts` via the Phase-2 runner
(`GraphiteRunner.render`, never hand-assembled args). Artifacts live under
`tmp/phase3-e2e/` (gitignored scratch). Every successful export writes a valid
file and then dies with SIGSEGV — the runner quarantines it, and the tests
assert `quarantine.quarantinedAfterWrite === true` on every render.

| Template | Proof artifact | sha256 | Dims | Bytes | Determinism (same doc rendered twice) |
|---|---|---|---|---|---|
| `solid-background` | `tmp/phase3-e2e/sample-solid-background.png` | `1801e8e7f9fe3181bb3c5ff662d38f2137e0b2b512a23e91ca1f968d97c93267` | 1000×500 | 8,683 | byte-identical |
| `pattern-background` | `tmp/phase3-e2e/sample-pattern-background.png` | `d12953884f52fd3bb132a47c76942e2752b925521cb8ea95b0a08498f69d89c1` | 1000×500 | 1,500,678 | byte-identical |
| `text-on-background` | `tmp/phase3-e2e/sample-text-on-background.png` | `fb38976ade67b7b3fc315c025bdd261a0c7f502d32aa21cc041228fab5f54957` | 1000×500 | 14,127 | byte-identical |
| `duotone-image` | `tmp/phase3-e2e/sample-duotone-image.png` | `d8386201dff4eb089fee9554663e8ebbe656bdc8a50a888809bd35e23fcbe887` | 1000×500 | 1,301,293 | byte-identical |

Parametric AC evidence (all real renders, in `tmp/phase3-e2e/`): gradient vs
solid differs (`gradient-bw` vs `solid-red`, 500,000 px); solid color change
differs (`solid-blue`); seed change differs (`pattern-seed0/7`); scale change
differs (`pattern-scale35/8`); text change differs (`text-a/b`); duotone ramp
change differs (`duotone-orange/blue`); `reverse: true` differs
(`duotone-forward/reversed`); custom-size doc renders at exactly 600×400
(`custom-size.png`).

---

## solid-background

Solid color background or a two-color linear gradient background. Default
sample: solid blue `rgb(0.12, 0.42, 0.95)`.

Params (`SolidBackgroundParams`, discriminated by `variant`):

| Param | Type | Notes |
|---|---|---|
| `variant` | `'solid' \| 'gradient'` | picks the chain |
| `width` | positive integer | artboard/document width (always required) |
| `height` | positive integer | artboard/document height (always required) |
| `color` | color | solid variant: the background color |
| `from`, `to` | colors | gradient variant: ramp stops at positions 0 and 1 |

Gradient direction: `from` at the left edge → `to` at the right edge (verified:
TL=[0,0,0], center=[128,128,128], BR=[255,255,255] for a black→white ramp).

Provenance — solid variant: the p5 trial chain minus the adjustment
(`EmptyImageNode` with the `[w,0,0,h,0,0]` transform → generic wrapper →
CreateArtboard); re-proven this phase: the rendered image covers the artboard
exactly (0 uncovered pixels against a contrasting artboard background probe).
Gradient variant: the demo-proven vector route (`parametric-dunescape.graphite`)
`RectangleNode` → Fill with a `GradientRamp` paint. **Placement detail
(discovered by probe):** the engine generates rectangles CENTERED at the origin,
so the chain inserts the demo's Monitor+Transform wrapper
(`marbled-mandelbrot.graphite`) with translation `[w/2, h/2]` to land the rect
on `[0,0]–[w,h]`; Fill's `_has_transform: false` then auto-derives the gradient
placement from the transformed shape's bounding box. The artboard background
slot carries the `to` color (visible only if the rect failed to cover).

## pattern-background

Procedural noise texture (grayscale luminance) filling the artboard.
Default sample: seed 0, scale 35.

Params (`PatternBackgroundParams`): `width`, `height` (positive integers,
always required), `seed` (u32; different seeds → different patterns),
`scale` (positive number; larger = finer texture).

Provenance: `NoisePatternNode` full 16-input serialization copied from the
working demo `marbled-mandelbrot.graphite`; input order cross-checked against
the pinned source (`node-graph/nodes/raster/src/std_nodes.rs`,
`noise_pattern`). `clip: false` is mandatory for full-bleed — the default
clips to the engine's 100×100 square. Headless footprint verified: the noise
covers the entire artboard at any requested size.

## text-on-background

Fallback-font text over a solid background. Default sample: blue
"GRAPHITE TEMPLATE" at 48 px on the trial dark background.

Params (`TextOnBackgroundParams`): `width`, `height` (always required),
`background` (color), `text` (non-empty string), `textColor` (color),
`fontSize` (number, default 48 — the size of the verified proof render).

Provenance: the director-executed TextNode chain
(`tmp/p4-direct-text-itemwrapped.graphite`, compiled AND rendered by the pinned
CLI): `TextNode` (fallback font via the TypeDefault-Resource marker) →
`TextToVectorNode` → `FillNode` (text color paint + the proven placement
transform, copied verbatim with `_has_transform: true`) → generic wrapper →
CreateArtboard. Input order checked against the pinned source
(`node-graph/nodes/gstd/src/text.rs`, `fn text`).

**Placement note (measured, not derived):** the proven transform anchors text
near the top-left (default render: glyph bbox ≈ x 2–421, y 13–46 for 17 chars
at 48 px). `fontSize` scales the glyphs proportionally (96 px → cap height
≈ 65 px) around the same anchor; the template does NOT re-derive placement per
size, and there is no position parameter this phase.

**Route choice (per the phase brief's allowance):** the TextNode route was
shipped for template (c) because the font size is a real node parameter
(StringValueNode has none — size would live only in the Fill transform), and it
is execution-verified by the pinned CLI. The StringValueNode skeleton is
therefore NOT exported as a second template; it remains as the p4 fixture in
`tests/fixtures/` (read-only reference), and its proven Fill-transform is the
one this template reuses verbatim.

## duotone-image

Procedural noise mapped through a two-color gradient ramp. Default sample:
seed 0, scale 35, dark `rgb(0.02, 0.02, 0.12)` → light `rgb(1.0, 0.3, 0.03)`.

Params (`DuotoneImageParams`): `width`, `height` (always required), `seed`
(u32), `scale` (positive number), `dark`/`light` (colors — ramp stops at
positions 0/1), `reverse` (boolean, default false — flips the luma→position
mapping).

Provenance: the demo-proven chain (`marbled-mandelbrot.graphite`)
`NoisePatternNode` → `raster_nodes::adjustments::LevelsNode` (field stretch) →
`raster_nodes::adjustments::GradientMapNode` (inputs `[image, gradient,
reverse]`, verified against the pinned source
`node-graph/nodes/raster/src/adjustments.rs` — gamma luma 0.3/0.59/0.11 → ramp
position, source alpha preserved) laid out at top level per the p5 trial
structure. The two-stop `GradientRamp` serialization
(`stops.color/position/midpoint`, `gradient_space: "RgbGamma"`) is copied from
the demo's GradientMap inputs; the Levels inputs (composite + R/G/B/A groups of
5: shadows/midtones/highlights/output-min/max) are verified against `fn levels`
in the same source file (`PercentageF32 = f32` on the wire).

**Levels stretch (measured necessity, 2026-09-22 revision):** the NoisePattern
output field is high-biased with a luminance floor ≈0.25 — a 6-config sweep
(noise type / fractal type / domain warp) showed 0.0% of pixels below luma 64,
so an unstretched field NEVER reaches the ramp's shadow stop (the template
rendered as flat orange with thin mid-blend lines). The chain therefore inserts
`LevelsNode` between noise and gradient map with input black 25% / white 90%
(composite group; channel groups at defaults), stretching the field to the full
0..1 range. Measured on the rendered default sample: linear-255 ramp luma span
[7.9 (navy) .. 122.5 (orange)] fully covered — min 1.0, max 122.5, smooth
blends across the noise structure. Noise parameters are unchanged (seed 0,
scale 35 — measured: larger `scale` = larger features on this engine).

---

### Shared serialization conventions

- Colors: `{"Color": {"red": R, "green": G, "blue": B, "alpha": A, "linear":
  true}}` — linear-space RGB, channels 0..1 (as in both trial fixtures).
- Two-stop gradient: `{"GradientRamp": {"stops": {"color": [c0, c1],
  "position": [0.0, 1.0], "midpoint": [0.5, 0.5]}, "gradient_space":
  "RgbGamma"}}`.
- Documents serialize as pretty JSON (2-space indent, trailing newline) with
  the fixture key order; `network_metadata` is the trial-verbatim constant
  (proven inert for headless use — the text-chain document rendered fine
  carrying the trial's "Gradient Map" editor metadata).
- The engine renders the artboard's document-space bounds; render `size`
  should match the document's `width`/`height` (all e2e proofs do).
