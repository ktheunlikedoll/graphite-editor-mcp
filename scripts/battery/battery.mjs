// Emergence Battery — batch-001
// Families: A cellular-warp (fractal noise), B index-lattice (per-instance phase),
// C interference (kinetic), D fractal (mandelbrot, CLI-rendered separately).
// Self-contained: compose → render → QA → manifest → gallery. One line per item.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  protoNodeEntry, genericWrapperNode, artboardWrapperNode, monitorTransformWrapperNode,
  assembleDocument, colorValue, nodeInput, f64Value, u32Value,
  boolValue, stringValue, dVec2Value, nullNonePrimaryValue,
} from '../../dist/src/values.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGraphiteServer } from '../../dist/src/server.js';

const BATCH = 'batch-001';
const ROOT = new URL(`../../tmp/battery/${BATCH}/`, import.meta.url).pathname;
const ITEMS = ROOT + 'items/';
mkdirSync(ITEMS, { recursive: true });

const hex = (h) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255, alpha: 1 });
const PALETTES = {
  vermilion: { bg: hex('#1B1B1B'), a: hex('#E8E4E0'), b: hex('#E64A38') },
  signal:    { bg: hex('#171512'), a: hex('#E8E4E0'), b: hex('#D93A2F') },
  dunes:     { bg: hex('#0E1F24'), a: hex('#2FA08C'), b: hex('#F0B03C') },
};

// ---------------- shared graph builders --------------------------------------
const f32 = (n) => ({ Value: { tagged_value: { F32: n }, exposed: false } });
const nodes = [];
const add = (id, e) => nodes.push([id, e]);
const fresh = () => { nodes.length = 0; };

const fill = (id, contentId, paint) =>
  add(id, protoNodeEntry('graphene_core::vector::FillNode', [
    nodeInput(contentId), colorValue(paint), colorValue(paint),
    { Value: { tagged_value: { GradientRamp: { stops: { color: [{ red: 1, green: 1, blue: 1, alpha: 1, linear: true }, { red: 0, green: 0, blue: 0, alpha: 1, linear: true }], positions: [0, 1] } } }, exposed: false } },
    { Value: { tagged_value: { GradientForm: 'Linear' }, exposed: false } },
    boolValue(true),
    { Value: { tagged_value: { DAffine2: [1, 0, 0, 1, 0, 0] }, exposed: false } },
  ]));
const stroke = (id, contentId, paint, weight) =>
  add(id, protoNodeEntry('graphene_core::vector::StrokeNode', [
    nodeInput(contentId), colorValue(paint), f64Value(weight),
    { Value: { tagged_value: { StrokeAlign: 'Center' }, exposed: false } },
    { Value: { tagged_value: { StrokeCap: 'Butt' }, exposed: false } },
    { Value: { tagged_value: { StrokeJoin: 'Miter' }, exposed: false } },
    f64Value(4), { Value: { tagged_value: { DashPattern: [] }, exposed: false } }, f64Value(0),
  ]));
const rect = (id, w, h) => add(id, protoNodeEntry('vector_nodes::generator_nodes::RectangleNode', [
  nullNonePrimaryValue(), f64Value(w), f64Value(h),
  { Value: { tagged_value: { BoxCorners: [0.0] }, exposed: false } }, boolValue(true), boolValue(false),
]));
const line = (id, toX, toY) => add(id, protoNodeEntry('vector_nodes::generator_nodes::LineNode', [
  nullNonePrimaryValue(), { Value: { tagged_value: { DVec2: [toX, toY] }, exposed: false } },
]));
const animTime = (id, rate = 1) => add(id, protoNodeEntry('graphene_core::animation::AnimationTimeNode', [
  { Value: { tagged_value: 'None', exposed: false } }, f64Value(rate),
]));
const math = (id, operandId, expr, b = 0) => add(id, protoNodeEntry('math_nodes::MathNode', [
  nodeInput(operandId), stringValue(expr), f64Value(b),
]));
const sine = (id, thetaId) => add(id, protoNodeEntry('math_nodes::SineNode', [
  nodeInput(thetaId), boolValue(false), // theta + degrees mode
]));
const readIndex = (id, level = 0) => add(id, protoNodeEntry('core_types::vector::ReadIndexNode', [
  { Value: { tagged_value: 'None', exposed: false } }, u32Value(level),
]));
const timeWrapRot = (contentId, translation, mathId) => {
  const w = monitorTransformWrapperNode(contentId, { translation, rotation: 0, scale: [1, 1] });
  w.inputs[2] = nodeInput(mathId);
  return w;
};
const noise = (id, p) => add(id, protoNodeEntry('raster_nodes::std_nodes::NoisePatternNode', [
  { Value: { tagged_value: 'None', exposed: false } }, boolValue(false), u32Value(p.seed), f64Value(p.scale),
  { Value: { tagged_value: { NoiseType: p.noiseType }, exposed: false } },
  { Value: { tagged_value: { DomainWarpType: p.warp }, exposed: false } }, f64Value(p.warpAmp ?? 100),
  { Value: { tagged_value: { FractalType: p.fractal }, exposed: false } },
  u32Value(p.octaves ?? 3), f64Value(p.lacunarity ?? 2), f64Value(p.gain ?? 0.5),
  f64Value(0), f64Value(2),
  { Value: { tagged_value: { CellularDistanceFunction: 'Hybrid' }, exposed: false } },
  { Value: { tagged_value: { CellularReturnType: 'CellValue' }, exposed: false } }, f64Value(1),
]));
const levels = (id, fromId, black = 25, white = 90) => add(id, protoNodeEntry('raster_nodes::adjustments::LevelsNode', [
  nodeInput(fromId), f32(black), f32(1), f32(white), f32(0), f32(100),
  ...[0, 1, 100, 0, 100].map(f32), ...[0, 1, 100, 0, 100].map(f32),
  ...[0, 1, 100, 0, 100].map(f32), ...[0, 1, 100, 0, 100].map(f32),
]));
const protoExtend = (b, n) => protoNodeEntry('graphic_nodes::graphic::ExtendNode', [nodeInput(b), nodeInput(n)]);
const stack = (...layers) => {
  let cur = layers[0];
  for (const l of layers.slice(1)) { const id = 900 + nodes.length; add(id, protoExtend(cur, l)); cur = id; }
  return cur;
};

// ---------------- MCP render client (in-process, sequential) ------------------
const server = createGraphiteServer();
const client = new Client({ name: 'battery', version: '0.0.0' });
const [cT, sT] = InMemoryTransport.createLinkedPair();
await server.connect(cT);
await client.connect(sT);

async function render(docObj, out, format, w, h, gif) {
  const res = await client.callTool({
    name: 'graphite_render',
    arguments: { document: JSON.stringify(docObj), outputDir: 'tmp/battery/' + BATCH + '/items', output: { format, width: w, height: h, outputName: out, ...(gif ? { gif } : {}) } },
  });
  const payload = JSON.parse(res.content.find((c) => c.type === 'text').text);
  if (res.isError) return { ok: false, code: payload.code, message: payload.message?.slice(0, 160) };
  return { ok: true, path: payload.artifactPath, bytes: payload.byteSize, sha: payload.sha256 };
}

// ---------------- FAMILY A: cellular-warp (fractal noise) ---------------------
function familyA(p) {
  fresh();
  const { a, b, bg } = PALETTES[p.palette];
  noise(101, p);
  levels(102, 101, p.black ?? 25, p.white ?? 90);
  add(103, protoNodeEntry('raster_nodes::adjustments::GradientMapNode', [
    nodeInput(102),
    { Value: { tagged_value: { GradientRamp: { stops: { color: [a, b], positions: [0, 1] } } }, exposed: false } },
    boolValue(false),
  ]));
  add(104, genericWrapperNode(103));
  add(105, artboardWrapperNode(104, { width: p.w, height: p.h, background: bg }));
  return assembleDocument(nodes, 105);
}

// ---------------- FAMILY B: index-lattice (per-instance phase) ----------------
function familyB(p) {
  fresh();
  const { a, b, bg } = PALETTES[p.palette];
  rect(100, p.barW, p.barH);
  fill(101, 100, p.color === 'b' ? b : a);
  readIndex(110);
  math(111, 110, p.phaseExpr ?? 'A * 15');
  let rotId = 111;
  if (p.wave) { sine(112, 111); math(113, 112, p.waveExpr ?? 'A * 40 + 10'); rotId = 113; }
  const w = monitorTransformWrapperNode(101, { translation: [0, 0], rotation: 0, scale: [1, 1] });
  w.inputs[2] = nodeInput(rotId);
  add(104, w);
  add(105, protoNodeEntry('repeat_nodes::repeat_nodes::RepeatRadialNode', [
    nodeInput(104), f64Value(0), f64Value(p.radius ?? 220), u32Value(p.count),
  ]));
  add(106, monitorTransformWrapperNode(105, { translation: [p.cx, p.cy], rotation: 0, scale: [1, 1] }));
  add(107, genericWrapperNode(106));
  add(108, artboardWrapperNode(107, { width: p.w, height: p.h, background: bg }));
  return assembleDocument(nodes, 108);
}

// ---------------- FAMILY C: interference (kinetic) ----------------------------
function familyC(p) {
  fresh();
  const { a, b, bg } = PALETTES[p.palette];
  // field: one line, per-copy x = index*spacing, wrapped in repeat
  line(100, 0, p.h);
  stroke(101, 100, a, p.lineWeight ?? 3);
  readIndex(103);
  math(104, 103, 'A * ' + p.spacing);
  add(105, protoNodeEntry('math_nodes::CombineVec2Node', [
    { Value: { tagged_value: 'None', exposed: false } }, nodeInput(104), f64Value(0),
  ]));
  const fieldWrap = monitorTransformWrapperNode(101, { translation: [0, 0], rotation: 0, scale: [1, 1] });
  fieldWrap.inputs[1] = nodeInput(105);
  add(106, fieldWrap);
  add(107, protoNodeEntry('repeat_nodes::repeat_nodes::RepeatNode', [
    nodeInput(106), u32Value(p.lines), boolValue(false),
  ]));
  // star: spokes from center, rotated by AnimationTime
  line(110, 0, -p.speakLen);
  stroke(111, 110, b, p.speakWeight ?? 3);
  add(112, protoNodeEntry('repeat_nodes::repeat_nodes::RepeatRadialNode', [
    nodeInput(111), f64Value(0), f64Value(0), u32Value(p.spokes),
  ]));
  animTime(120);
  math(121, 120, 'A * ' + p.rate);
  const starWrap = timeWrapRot(112, [p.w / 2, p.h / 2], 121);
  add(113, starWrap);
  // optional counter-rotation on the whole field
  let fieldOuter = 107;
  if (p.counter) {
    math(115, 120, '-A * ' + (p.counterRate ?? 3));
    const cw = monitorTransformWrapperNode(107, { translation: [p.w / 2, p.h / 2], rotation: 0, scale: [1, 1] });
    cw.inputs[2] = nodeInput(115);
    add(116, cw);
    add(117, genericWrapperNode(116));
    add(118, protoExtend(113, 116)); // star over rotating field group (pre-wrap)
  }
  const g1 = 930, g2 = 931;
  add(g1, genericWrapperNode(107));
  add(g2, genericWrapperNode(113));
  const s1 = stack(g1, g2);
  add(911, artboardWrapperNode(s1, { width: p.w, height: p.h, background: bg }));
  return assembleDocument(nodes, 911);
}

// ---------------- BATCH SPEC ---------------------------------------------------
const SPECS = [
  { id: 'A1-fbm-ink-paper', family: 'cellular-warp', params: { w: 800, h: 800, seed: 3, scale: 8, noiseType: 'OpenSimplex2', warp: 'OpenSimplex2', fractal: 'FBm', palette: 'vermilion' } },
  { id: 'A2-ridged-signal', family: 'cellular-warp', params: { w: 800, h: 800, seed: 7, scale: 14, noiseType: 'OpenSimplex2', warp: 'OpenSimplex2', warpAmp: 250, fractal: 'Ridged', palette: 'signal' } },
  { id: 'A3-cellular-dunes', family: 'cellular-warp', params: { w: 800, h: 800, seed: 11, scale: 20, noiseType: 'Cellular', warp: 'None', fractal: 'FBm', palette: 'dunes', black: 30, white: 85 } },
  { id: 'A4-pingpong-deep', family: 'cellular-warp', params: { w: 800, h: 800, seed: 5, scale: 5, noiseType: 'Perlin', warp: 'OpenSimplex2Reduced', warpAmp: 300, fractal: 'PingPong', palette: 'dunes' } },
  { id: 'A5-ridge-heavy', family: 'cellular-warp', params: { w: 800, h: 800, seed: 21, scale: 10, noiseType: 'OpenSimplex2', warp: 'OpenSimplex2', warpAmp: 400, fractal: 'Ridged', palette: 'vermilion', black: 45, white: 92 } },
  { id: 'B1-ring-static', family: 'index-lattice', params: { w: 800, h: 800, count: 36, barW: 90, barH: 8, cx: 400, cy: 400, radius: 240, phaseExpr: 'A * 10', palette: 'vermilion', color: 'a' } },
  { id: 'B2-ring-wave', family: 'index-lattice', params: { w: 800, h: 800, count: 36, barW: 90, barH: 8, cx: 400, cy: 400, radius: 220, phaseExpr: 'A * 0.45', wave: true, waveExpr: 'A * 40 + 10', palette: 'signal', color: 'b' } },
  { id: 'B3-ring-dense', family: 'index-lattice', params: { w: 800, h: 800, count: 72, barW: 60, barH: 6, cx: 400, cy: 400, radius: 260, phaseExpr: 'A * 5', palette: 'dunes', color: 'b' } },
  { id: 'C1-interference-24', family: 'interference', motion: { fps: 12, frames: 24 }, params: { w: 800, h: 800, spokes: 24, speakLen: 560, rate: 30, lines: 40, spacing: 20, palette: 'vermilion' } },
  { id: 'C2-interference-72', family: 'interference', motion: { fps: 12, frames: 24 }, params: { w: 800, h: 800, spokes: 72, speakLen: 520, rate: 15, lines: 56, spacing: 14, speakWeight: 2, lineWeight: 2, palette: 'signal' } },
  { id: 'C3-interference-counter', family: 'interference', motion: { fps: 12, frames: 24 }, params: { w: 800, h: 800, spokes: 48, speakLen: 560, rate: 24, lines: 40, spacing: 24, counter: true, counterRate: 6, palette: 'vermilion' } },
  { id: 'C4-still-dense', family: 'interference', params: { w: 800, h: 800, spokes: 120, speakLen: 580, rate: 0, lines: 60, spacing: 18, speakWeight: 1, lineWeight: 2, palette: 'dunes' } },
  { id: 'C5-interference-duotone', family: 'interference', motion: { fps: 12, frames: 24 }, params: { w: 800, h: 800, spokes: 36, speakLen: 560, rate: 45, lines: 30, spacing: 30, palette: 'signal' } },
];

// ---------------- RUN ----------------------------------------------------------
const results = [];
for (const spec of SPECS) {
  try {
    let doc;
    if (spec.family === 'cellular-warp') doc = familyA(spec.params);
    else if (spec.family === 'index-lattice') doc = familyB(spec.params);
    else doc = familyC(spec.params);
    const format = spec.motion ? 'gif' : 'png';
    const res = await render(doc, spec.id, format, spec.params.w, spec.params.h,
      spec.motion ? { mode: 'frames', fps: spec.motion.fps, frames: spec.motion.frames } : undefined);
    if (!res.ok) { results.push({ id: spec.id, family: spec.family, params: spec.params, ok: false, error: `${res.code}: ${res.message}` }); console.log(`FAIL ${spec.id.padEnd(26)} ${res.code}: ${res.message?.slice(0, 90)}`); continue; }
    const ext = format === 'gif' ? 'gif' : 'png';
    const localPath = ITEMS + spec.id + '.' + ext;
    renameSync(res.path, localPath);
    res.path = localPath;
    let qa = '';
    if (format === 'gif') {
      qa = execSync(`python3 - << 'PYEOF'
from PIL import Image, ImageSequence
import numpy as np
im = Image.open('${res.path}')
fr = [np.asarray(f.convert('RGB'), dtype=np.float32) for f in ImageSequence.Iterator(im)]
d = [float(np.abs(fr[i]-fr[i-1]).mean()) for i in range(1, len(fr))]
wrap = float(np.abs(fr[0]-fr[-1]).mean())
stat = 'static' if max(d) < 0.5 else 'motion'
seam = 'seamless' if abs(wrap - d[0]) < 0.6 else 'open-seam'
print(f"{stat} seam={seam} step={d[0]:.1f}")
PYEOF`).toString().trim();
    }
    results.push({ id: spec.id, family: spec.family, params: spec.params, motion: spec.motion, ok: true, artifact: res.path, bytes: res.bytes, sha: res.sha?.slice(0, 12), qa });
    console.log(`OK   ${spec.id.padEnd(26)} ${String(res.bytes).padStart(8)}B  ${qa}`);
  } catch (err) {
    results.push({ id: spec.id, family: spec.family, params: spec.params, ok: false, error: String(err).slice(0, 200) });
    console.log(`FAIL ${spec.id.padEnd(26)} ${String(err).slice(0, 110)}`);
  }
}

// mandelbrot (CLI-rendered separately; include for the record)
const mb = ROOT + 'items/D-fractal-mandelbrot.png';
if (existsSync(mb)) {
  const st = statSync(mb);
  results.push({ id: 'D1-fractal-mandelbrot', family: 'fractal', params: { source: 'upstream demo; stale node path fixed: raster_nodes::gradient_map:: → raster_nodes::adjustments::' }, ok: true, artifact: mb, bytes: st.size });
  console.log(`OK   D1-fractal-mandelbrot    ${String(st.size).padStart(8)}B  (CLI-rendered, path-fixed)`);
}

// ---------------- GALLERY + MANIFEST + MARKS -----------------------------------
writeFileSync(ROOT + 'manifest.json', JSON.stringify({ batch: BATCH, generated: new Date().toISOString(), items: results }, null, 2));
const cell = (r) => r.ok
  ? `<figure><img src="items/${r.id}.${r.motion ? 'gif' : 'png'}" loading="lazy"><figcaption><b>${r.id}</b> · ${r.qa ?? 'still'}<br><span style="color:#666">${JSON.stringify(r.params).slice(0, 130)}</span></figcaption></figure>`
  : `<figure class="fail"><figcaption><b>${r.id}</b><br>FAIL: ${r.error}</figcaption></figure>`;
writeFileSync(ROOT + 'gallery.html', `<!DOCTYPE html><html><head><style>
body{background:#111;color:#ddd;font-family:monospace;margin:20px}
h1{font-size:14px;font-weight:400;color:#888}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:12px}
figure{margin:0;background:#1b1b1b;padding:8px;border:1px solid #333}
img{width:100%;display:block}
figcaption{font-size:10px;line-height:1.4;margin-top:6px;color:#9a9a9a}
.fail figcaption{color:#e64a38}
</style></head><body><h1>${BATCH} — emergence battery (${results.length} items; verdicts → MARKS.md)</h1>
<div class="grid">${results.map(cell).join('\n')}</div></body></html>`);
writeFileSync(ROOT + 'MARKS.md',
  `# Battery ${BATCH} — earmarks\n\nVerdict per id: KEEP (refine) / IDEA (adapt later) / PASS.\n\n| id | verdict | note |\n|---|---|---|\n` +
  results.map(r => `| ${r.id} | | |`).join('\n') + '\n');
console.log(`\nbattery complete → ${ROOT}\n  gallery: ${ROOT}gallery.html\n  marks:   ${ROOT}MARKS.md`);