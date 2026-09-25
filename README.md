# graphite-editor-mcp

> **A programmatic graphics engine boundary for AI agents.** Deterministic, node-graph-based, agent-drivable: agents author documents as data, a headless CLI renders them, assets are reproducible and versionable. The MCP server is the stable boundary that makes this usable by agents and automation: it wraps data-driving, never GUI-driving, and it exists to be boring — every call returns a validated artifact or a precise error. Print/DTP finishing is deliberately out of scope; Graphite owns procedural/generative asset production.

## What this is — and is not

**It is:** an MCP server (stdio) exposing six tools over the pinned `graphene-cli` binary. Agents author documents as data — either template + parameters or inline legacy `.graphite` JSON — and receive validated, hashed artifacts with full provenance. Nothing here drives a GUI.

**It is not:** a print pipeline. `graphene-cli` writes `.png`, `.jpg`, `.jpeg`, `.gif` and `.svg` only — **PDF is explicitly rejected upstream** (headless print chains compose downstream, e.g. HTML/CSS → WeasyPrint → Ghostscript, with Graphite supplying the art). It is also not an upstream Graphite fork: the engine is pinned at a verified commit; the only source change is a small, versioned patch layer applied deterministically at build time (see `docs/ENGINE-PIN.md`).

## Architecture (one paragraph)

Tools → builder/templates → runner → pinned CLI: each MCP tool validates its inputs, produces a complete legacy `.graphite` document (via the template factories in `src/templates.ts` or an inline document materialized under `tmp/mcp-inline/`), and hands a render spec to `GraphiteRunner` (`src/runner.ts`), which spawns the pinned `graphene-cli` binary, captures its output tails, enforces a per-render timeout, and — because **every successful export writes a valid artifact and THEN dies with SIGSEGV** — validates the artifact unconditionally (`src/validator.ts`: magic bytes + structure + size floors) and quarantines the abnormal exit instead of trusting exit codes. Failures are typed (`src/errors.ts`) with stable codes and precise diagnostics; the MCP layer turns every failure into an `isError` result carrying the code.

## Quickstart

Prerequisites:

- **Node ≥ 22** (see `package.json` `engines`).
- **Rust toolchain** (`cargo` on PATH, or at `~/.cargo/bin`) — for building the pinned engine.
- **git** — for the shallow engine fetch.

```bash
git clone https://github.com/ktheunlikedoll/graphite-editor-mcp.git
cd graphite-editor-mcp
npm install
bash scripts/fetch-engine.sh   # shallow-fetch the pinned upstream SHA into engine/ and build graphene-cli
npm run build                  # tsc → dist/src/*.js
npm test                       # optional; the real-CLI test tiers run when the binary is present
```

`scripts/fetch-engine.sh` shallow-fetches the exact pinned upstream commit into `engine/Graphite/` (gitignored — never committed) and builds the debug `graphene-cli`. It is idempotent: if `engine/Graphite` is already at the pinned commit, it skips the fetch. First build takes a while. Reference build facts — commit SHA, binary sha256, toolchain — are recorded in **`docs/ENGINE-PIN.md`**.

### The CLI path: `GRAPHITE_CLI_PATH`

Resolution order (`src/paths.ts`):

1. `GRAPHITE_CLI_PATH` env var — used **exclusively** when set. A broken value fails precisely on that value; it never silently falls back.
2. Default: `<projectRoot>/engine/Graphite/target/debug/graphene-cli` (the pinned debug build).
3. Otherwise: `CLI_NOT_FOUND` error listing exactly what was searched.

## Tool contracts

Four tools, stdio transport, official MCP SDK, zod-validated inputs. Every result is one JSON text block. Every failure is an `isError: true` result whose text is a JSON error envelope:

```json
{
  "code": "SPEC_INVALID",
  "message": "output format \"png\" requires an explicit size: provide width AND height with BOTH dimensions (got width=800, height=undefined). Rationale: graphene-cli silently falls back to a 1x1 default viewport when a dimension is missing, so Graphite rejects incomplete sizes outright. (SVG is the only format that may omit size.)",
  "name": "SpecInvalidError"
}
```

### Error codes

| Code | Class | When |
|---|---|---|
| `CLI_NOT_FOUND` | `CliNotFoundError` | No usable binary (missing, not a file, not executable). Carries `searchedPaths`, `reason`. |
| `DOC_INVALID` | `DocInvalidError` | The engine refused the document (compile failed) or it cannot be read. Carries `documentPath`, `detail`, `exitCode`, `signal`, `stderrTail`. |
| `RENDER_FAILED` | `RenderError` | The CLI failed in a way that is NOT the SIGSEGV-after-write case. Carries `command`, `exitCode`, `signal`, `stdoutTail`, `stderrTail`. |
| `ARTIFACT_INVALID` | `ArtifactInvalidError` | The CLI produced (or claimed to produce) an artifact that failed validation. Carries `artifactPath`, `reason`, `exitCode`, `signal`, `stderrTail`. |
| `TIMEOUT` | `TimeoutError` | Render exceeded its time budget (default 120 s) and was killed. Carries `command`, `timeoutMs`, `stderrTail`. |
| `SPEC_INVALID` | `SpecInvalidError` | Malformed request before/without any process run: unknown template id, bad params, incomplete raster size, unsupported GIF timing, bad `outputName`, variant-count bounds. |
| `UNEXPECTED` | — | Any non-Graphite error; message only, never a stack trace. |

### `graphite_render`

Renders a document to a validated artifact.

| Input | Type | Notes |
|---|---|---|
| `templateId` | `string?` | One of the four template ids. **Either `templateId` or `document` — never both.** |
| `params` | `object?` | Template parameters; defaults to the template's `DEFAULT_PARAMS` when omitted. Validated by the template factory. |
| `document` | `object \| string?` | Inline legacy `.graphite` JSON (parsed object or raw JSON string). Materialized under `tmp/mcp-inline/` before rendering. |
| `output.format` | `"png" \| "svg" \| "jpg" \| "gif"` | Required. |
| `output.width` / `output.height` | `int?` | **Both required together for raster formats** (png/jpg/gif); a width-only request is rejected with `SPEC_INVALID` (the CLI would silently render a 1x1 default viewport). SVG may omit both. |
| `output.outputName` | `string?` | Base name WITHOUT extension — the format extension is appended (`hero` + png → `exports/hero.png`). Defaults to a timestamped, collision-safe name (`<templateId or "render">-<ISO timestamp>-<8 hex chars>`). |
| `output.gif` | `{ mode: "frames", fps, frames } \| { mode: "duration", duration }` | Required for `.gif`. |

Output path: `<projectRoot>/exports/<name>` (directory created on demand; the runner deletes stale artifacts of the same path before rendering so validation is always about THIS render).

Successful result (real output, template-driven duotone with default params):

```json
{
  "artifactPath": "<project-root>/exports/readme-example.png",
  "format": "png",
  "byteSize": 1154138,
  "sha256": "93ef9b199f1e166cb95d26ba584f7038745a701ff18c9195e4ffc3eb23060b75",
  "width": 1000,
  "height": 500,
  "validation": {
    "valid": true,
    "format": "png",
    "byteSize": 1154138,
    "path": "<project-root>/exports/readme-example.png",
    "width": 1000,
    "height": 500
  },
  "quarantine": {
    "exitCode": null,
    "signal": "SIGSEGV",
    "quarantinedAfterWrite": true,
    "stderrTail": ""
  },
  "renderMs": 1502,
  "exitCode": null,
  "signal": "SIGSEGV",
  "command": "graphene-cli export …/tmp/mcp-inline/render-….graphite --output …/exports/readme-example.png --width 1000 --height 500",
  "documentPath": "<project-root>/tmp/mcp-inline/render-….graphite",
  "templateId": "duotone-image",
  "params": { "width": 1000, "height": 500, "seed": 0, "scale": 35, "dark": { "red": 0.02, "green": 0.02, "blue": 0.12, "alpha": 1 }, "light": { "red": 1, "green": 0.3, "blue": 0.03, "alpha": 1 }, "reverse": false }
}
```

`templateId`/`params` echo only on template-driven renders (echoing the parameters actually used — defaults included). The render is NOT compiled separately first: the export itself surfaces compile errors (`DOC_INVALID`), so every call spawns exactly one CLI process.

### `graphite_list_nodes`

No required inputs; optional `filter` (case-sensitive substring). Returns `{ "count": <n>, "nodes": ["…", …] }` from `graphene-cli list-node-identifiers` — **324 identifiers** on the pinned build. The unfiltered list is cached in memory after the first success (process lifetime; the pin cannot change under a running server).

```json
{
  "count": 1,
  "nodes": ["raster_nodes::adjustments::GradientMapNode"]
}
```

### `graphite_search_nodes`

Keyword/category search over the full node registry. Inputs: optional `query` (case-insensitive substring across identifier, display name, and description) and optional `category` (exact match, e.g. `"Gradient"`, `"Math: Arithmetic"`). Returns `{ count, results: [{ identifier, displayName, category, description }], hint }` — pair with `graphite_describe_node` for the input contract. Backed by `graphene-cli dump-node-metadata` (JSONL, cached process-lifetime).

### `graphite_describe_node`

Full metadata for one node: required `identifier` (as returned by search). Returns `{ identifier, displayName, category, description, fields: [{ name, description, type?, default?, softRange?, hardRange?, step?, unit?, hidden? }] }` — the authoritative contract for wiring that node into a custom document. Unknown identifiers return a `SPEC_INVALID` envelope that points at search.

### `graphite_validate_doc`

Structural validation of a document WITHOUT rendering. Pass either `document` (inline object or JSON string) or `documentPath` (existing file) — never both. Optional `compileCheck: true` adds the engine's own `compile` verdict (default `false` — fast and offline). **Validation results are data:** an invalid document returns `valid: false` with precise reasons; it is not an error result.

```json
{
  "valid": false,
  "structural": {
    "checks": {
      "parsed": true, "hasNetworkInterface": true, "hasNetwork": true,
      "hasNodesArray": true, "hasExportsArray": true,
      "nodeEntriesWellFormed": true, "exportsResolveToNodes": false
    },
    "nodeCount": 4,
    "reasons": ["export references node id 999999, which does not exist in network.nodes"]
  }
}
```

With `compileCheck: true` on a structurally-valid document:

```json
{
  "valid": true,
  "structural": { "checks": { "parsed": true, "hasNetworkInterface": true, "hasNetwork": true, "hasNodesArray": true, "hasExportsArray": true, "nodeEntriesWellFormed": true, "exportsResolveToNodes": true }, "nodeCount": 4, "reasons": [] },
  "compile": { "ok": true, "stderrTail": "" },
  "documentPath": "<project-root>/tmp/mcp-inline/validate-….graphite"
}
```

Compile runs only after structural validation passes; when structural validation fails, `compile` is reported as `{ "ok": false, "reason": "not run: structural validation failed" }` (no wasted spawn). `documentPath` echoes the on-disk path (the materialized copy for inline documents). A failed engine compile sets `compile.ok: false` with the engine's `stderrTail`.

### `graphite_render_variants`

Sequential batch renderer (v1 doctrine: never parallel — one GPU-heavy child at a time).

| Input | Type | Notes |
|---|---|---|
| `templateId` | `string` | Required. |
| `variants` | `params[]` | **2..20** full parameter objects; each validated independently. |
| `format` | `"png" \| "svg" \| "jpg" \| "gif"` | Required. |
| `width` / `height` | `int` | Required — the render size for every variant (pass the same values inside each variant's params). |
| `outputDir` | `string?` | Default `<projectRoot>/exports/`; relative paths resolve against the project root. |

Outputs: `<templateId>-<index>.<format>` (index = position in `variants`, 0-based) under the output dir. Each variant goes through the full render + validate pipeline; a failing variant is reported per-item and does NOT abort the batch — the call is `isError` only when **every** variant fails.

Result: `{ "count": 3, "results": [ …same shape as graphite_render results… ] }`; a failed item looks like `{ "templateId": "duotone-image", "params": { … }, "error": { "code": "SPEC_INVALID", "message": "…" } }`.

## Motion (animated GIF, verified)

Time is data. Wire `graphene_core::animation::AnimationTimeNode` → `math_nodes::MathNode` (expression, e.g. `A * 45`) → any node input — wrapper rotation, translation, gradient stops — and export GIF:

```json
{ "output": { "format": "gif", "width": 800, "height": 500,
              "gif": { "mode": "frames", "fps": 12, "frames": 24 } } }
```

Headless export injects `frame_index / fps` as animation time per frame (verified frame-exact), so any time-driven parameter animates. Authoring rules proven in builds:

- **Seamless loops:** total rotation per loop must equal a multiple of the shape's rotational symmetry (e.g. 90° = 12 spoke pitches on a 48-spoke star); per-frame motion must NOT equal a symmetry multiple, or the animation aliases into stillness (wagon-wheel). Verify both numerically from the GIF frames.
- **Never** wire `RealTimeNode` (wall-clock, non-deterministic) into agent-authored documents; `QuantizeAnimationTimeNode` gives stop-motion stepping.
- Per-instance variation: `core_types::vector::ReadIndexNode` (loop level 0) → MathNode → a transform input **inside** the repeated content; `RepeatNode` stacks copies without it, `RepeatRadialNode` at radius 0 produces spokes from a center point.
- Output container is GIF only — narrative timelines and audio belong to a video engine, not this boundary.

See `docs/demo/` for rendered examples (static banner, kinetic loop).

## Authoring notes (hard-won, verified)

Facts upstream does not document, established by pixel-level evidence during builds:

- **Colors are sRGB floats (hex ÷ 255), passed through to output bytes** in both PNG and GIF — the CLI applies no gamma conversion at the boundary. Pass `#1B1B1B` as `{ "red": 0.106, "green": 0.106, "blue": 0.106 }`.
- A **scalar fed into a Vec2 input broadcasts to both components** — compose explicitly with `math_nodes::CombineVec2Node` (X + Y inputs) when the components differ.
- `vector_nodes::generator_nodes::LineNode` draws **from the local origin** to its `Line To` value; its primary input is unit-typed (pass `None`, not a position).
- Shapes render **centered on their origin** after transform translation; text anchors top-left-ish. Position with transform wrappers (`TransformNode`), not fill transforms, when composing.
- The GIF path skips the SIGSEGV quarantine? No — the quarantine applies to every export; GIFs are validated like PNGs.
- `graphite_search_nodes` / `graphite_describe_node` are the intended entry point for authoring beyond the four seed templates: search the 324-node registry, read the exact input contract (types, defaults, ranges, units), then author inline JSON against it.

## Demos

Rendered by this server (see `docs/demo/`):

| Artifact | What it demonstrates |
|---|---|
| `evidence-engine-banner.png` | hand-authored 19-node custom document: multi-layer stack (noise → gradient-map field, positioned vector rules, vector text) |
| `kinetic-01-interference.gif` | headless motion: radial star rotating through a line field, seamless loop, AnimationTime-driven |

## Templates

| Id | Produces | Params | Provenance |
|---|---|---|---|
| `solid-background` | Full-bleed solid color (EmptyImage route) or two-color linear gradient (proven Rectangle→Fill vector route) | `variant: 'solid' \| 'gradient'; width; height; color` (solid) \| `from, to` (gradient) — linear-RGB channels 0..1 | working demo gradient route |
| `pattern-background` | Procedural noise-pattern background (NoisePatternNode, clip disabled → full-bleed) | `width; height; seed (u32); scale` | working demo — full 16-input serialization |
| `text-on-background` | Fallback-font text (TextNode → TextToVector → Fill) over a solid background | `width; height; background; text; textColor; fontSize?` (default 48) | executed TextNode chain with proven placement transform |
| `duotone-image` | Procedural noise mapped through a two-color gradient ramp (GradientMap duotone) | `width; height; seed (u32); scale; dark, light; reverse?` | demo-proven NoisePattern → GradientMap chain |

Default parameters per template live in `src/templates.ts` (`DEFAULT_PARAMS`) and are exactly the committed sample outputs in `templates/*.graphite`. Agents never hand-write wrapper JSON.

## The SIGSEGV quarantine — why every render reports `quarantinedAfterWrite`

Ground truth on the pinned engine build: **every successful `graphene-cli export` writes a complete, valid artifact and THEN dies with SIGSEGV (exit 139)** — reproducibly (likely the detached GPU-poll thread in `graphene-cli/src/main.rs`).

The runner therefore never trusts exit codes: it validates the artifact unconditionally (existence, non-trivial size, magic bytes + structure). When the CLI crashed after writing a valid artifact, the render **succeeds** and carries quarantine metadata `{ exitCode, signal, quarantinedAfterWrite: true, stderrTail }`. This is normal and expected — a successful tool result with `quarantine.quarantinedAfterWrite: true` is the pinned engine behaving exactly as measured. If a future engine build stops crashing, the field flips to `false` (exit 0 + valid artifact). A crash that left a broken artifact is NOT quarantined: it is an `ARTIFACT_INVALID` error.

## Determinism

Same spec rendered twice → byte-identical output. Evidence: the Phase-3 suite asserts pixel-identical renders for all four templates (`tests/templates-e2e.test.ts`, `determinism: … pixel-identical`), and every tool result carries the artifact `sha256`, so any two renders of the same document can be compared by hash. Assets are reproducible and diffable — the point of the whole boundary.

## Engine pin & support statement

- **Pinned engine:** upstream Graphite (`GraphiteEditor/Graphite`) at commit `d7ae6029e0c1818d81a13b0389ef1808496a715b`, fetched shallowly and built by `scripts/fetch-engine.sh`. Build facts and the reference binary sha256: `docs/ENGINE-PIN.md`.
- **Why a pin:** upstream is a fast-churning alpha. The pin exists for **reproducibility** — the node registry (324 identifiers on this build), document serialization shapes, and rendered output are only stable against one exact engine commit. Deterministic tooling requires a deterministic engine.
- **Sanctioned patch layer:** the PIN itself never changes — upstream source stays at the pinned commit — and `scripts/fetch-engine.sh` deterministically re-applies this project's versioned patches (`docs/engine-patches/*.patch`, currently `0001`: the `dump-node-metadata` registry command powering `graphite_search_nodes`/`graphite_describe_node`) after checkout. The patch is written to be upstreamable verbatim.
- **Upgrading is a deliberate re-pin:** choose a new upstream commit, update the pinned SHA in `scripts/fetch-engine.sh` and `docs/ENGINE-PIN.md`, rebuild, and re-run the **full test suite** (including the real-CLI e2e tiers) before relying on the new build. Node-registry content and serialization shapes can change between upstream versions.
- **Support boundary:** bugs in this repository (the MCP server, builder, runner, validator) belong here; questions about engine behavior belong upstream at `GraphiteEditor/Graphite`. The SIGSEGV-after-write quirk is an upstream behavior, absorbed by the quarantine contract above.

## Built on Graphite

This project is an independent tooling boundary **built on the Graphite editor** — the free, open-source, node-based graphics editor by the Graphite Foundation.

- **Project & web app:** [graphite.art](https://graphite.art) · **Code:** [GraphiteEditor/Graphite](https://github.com/GraphiteEditor/Graphite)
- **Engine license:** dual [MIT / Apache-2.0](https://github.com/GraphiteEditor/Graphite#license) — this wrapper complies with both.
- **Relationship:** not affiliated with or endorsed by the Graphite project. We pin an exact upstream commit (see the engine-pin section) and contribute findings upstream where useful.
- **Demo provenance:** `docs/demo/` artifacts are rendered by this server from original documents. `docs/fractal-proof/` (internal) derives from upstream's `demo-artwork/marbled-mandelbrot.graphite` (Apache-2.0) with a local node-path fix.

## Integration

Register the server with your MCP client (Claude Desktop, Cursor, or any client supporting the Model Context Protocol). Give it the absolute path to the built entrypoint:

```json
{
  "mcpServers": {
    "graphite-editor-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/graphite-editor-mcp/dist/src/index.js"]
    }
  }
}
```

To explore the server interactively:

```bash
npx @modelcontextprotocol/inspector node dist/src/index.js
```

A scripted non-interactive stdio handshake lives at `scripts/stdio-probe.mjs` (`node scripts/stdio-probe.mjs dist/src/index.js graphite_list_nodes '{"filter":"GradientMap"}'`).

## Limitations

- **No PDF / no print pipeline** — the CLI rejects PDF.
- **Fallback-font text only** — the text template uses the engine's embedded fallback font. The raw-`TextNode` resource failure is fully decoded and the authoring-shape fix is execution-verified; see `docs/font-resource-investigation.md` — embedded brand fonts would need the `.gdd` resource route (future work, not this build).
- **Sequential renders in v1** — one graphene-cli child at a time; `graphite_render_variants` runs its variants in a plain loop.
- **Debug-binary latency** — the pinned debug build spends ~1–1.5 s per spawn (startup + render); a release build (`cargo build --release -p graphene-cli`, then point `GRAPHITE_CLI_PATH` at it) cuts that substantially.
- **Inline documents are materialized and kept** under `tmp/mcp-inline/` (small JSON files; gitignored) so error messages always point at a real document on disk.
- `graphite_list_nodes` caches the registry per process lifetime.
- Strictly a wrapper: no upstream source modifications, no GUI driving.

## Development

```
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.json → dist/src/*.js
npm test            # vitest run — 122 tests, 5 files
```

Test layout (`tests/`):

- `runner.test.ts` / `validator.test.ts` — process-runner and artifact-validation units against **synthetic fake CLIs** in `tests/synthetic/*.mjs` (crash-after-write, clean exits, hangs, garbage writes) — the real binary is never required.
- `builder.test.ts` / fixtures — builder + template round-trips against committed proven documents in `tests/fixtures/`.
- `templates-e2e.test.ts` — real-CLI renders of all four templates, parametric pixel checks, determinism. Skipped as a whole when the binary is absent (`describe.skipIf`).
- `mcp-e2e.test.ts` — the MCP surface over the SDK's `InMemoryTransport`: a protocol tier (no binary needed: tool advertisement, `SPEC_INVALID` envelopes, structural validation) and a real-CLI tier (template/inline renders, list-nodes, compile check, variants batch).

Engine pin: `docs/ENGINE-PIN.md` records the pinned commit, the reproducible `scripts/fetch-engine.sh`, and the reference binary sha256; the clone (`engine/`) is gitignored and never modified.

---

Built by [The Native Creative](https://thenativecreative.co.za).

Licensed under the [MIT License](LICENSE) — Copyright (c) 2026 The Native Creative.