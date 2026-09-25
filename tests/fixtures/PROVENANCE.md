# Fixtures — provenance

Both `.graphite` files are **verbatim byte copies** of trial documents from
the internal Graphite evaluation workspace (read-only reference material;
originals live in the maintainer's internal evaluation workspace and are not
part of this repository):

| File | sha256 (copy) | Origin |
|---|---|---|
| `p4-hand-authored.graphite` | `186950e203acf27d9d263b88198a0a6d80b449d694b712c9d48ea0a96f1a3f89` | Trial P4 — hand-authored text chain (`StringValueNode` → `TextToVectorNode` → `FillNode` → generic wrapper → CreateArtboard), compiled + rendered by graphene-cli during the trials. |
| `p5-custom-duotone.graphite` | `cbdbb2f88faed5a6130ee3036983124ba244d6dfc4c8602d7989597341834151` | Trial P5 — EmptyImage → DuotoneNode chain, compiled during the trials. Note: the p5 `DuotoneNode` route itself later proved unusable in the pinned CLI build ("No implementations found" at export); the fixture is kept as the ground-truth shape of the EmptyImage + wrapper epilogue, which Phase 3's builder re-proved with `GradientMapNode`. |

They are consumed by `tests/builder.test.ts` for the document round-trip test
(parse → reserialize → deep-equal at the JSON value level) and stand as the
reference serialization the generated templates were copied from. Do not edit.
