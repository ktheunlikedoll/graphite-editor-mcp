# Engine pin record

- **Pinned upstream commit:** `d7ae6029e0c1818d81a13b0389ef1808496a715b` (GraphiteEditor/Graphite)
- **Fetch method:** `scripts/fetch-engine.sh` — `git init` + `git fetch --depth 1 origin <sha>` + `git checkout --detach FETCH_HEAD` (exact-SHA shallow fetch; GitHub allowAnySHA1InWant), then `cargo build -p graphene-cli`. Runnable from a fresh clone of this repository.
- **Verified HEAD:** `git rev-parse HEAD` → `d7ae6029e0c1818d81a13b0389ef1808496a715b`
- **Tree cleanliness:** pristine at the reference build. As of v1.1 the build applies this project's **sanctioned patch layer** (`docs/engine-patches/*.patch`, applied deterministically by `fetch-engine.sh` after checkout): `0001` adds the `dump-node-metadata` registry command (JSONL dump of `NodeMetadata` — display name, category, description, per-field types/defaults/ranges/units) that powers `graphite_search_nodes`/`graphite_describe_node`. The PIN is unchanged — upstream source stays at `d7ae6029`; patches are versioned, reviewed additions on top, re-applied on every rebuild.
- **Build command:** `cargo build -p graphene-cli` (reference build used rustc 1.98.1)
- **Reference build result:** exit 0
- **Binary:** `engine/Graphite/target/debug/graphene-cli` (debug)
- **Binary sha256 (v1.1 build, patches applied):** `8d537b30aa679bd907acf6c6cdd63473ae37b978ebe17b00472680b260ba9b8b`
- **Reference (pre-patch) binary sha256:** `1a45054d5616cd28400330ed91b8c6052a45704383354f23daf3e60fb235dbc7`
- **Registry cross-check:** `list-node-identifiers` → 324 identifiers on this build (`raster_nodes::adjustments::GradientMapNode`, `raster_nodes::std_nodes::EmptyImageNode`, `raster_nodes::std_nodes::NoisePatternNode` present as expected).
- **Post-export behavior (reconfirmed on this build):** valid artifact written, then SIGSEGV exit 139. The quarantine contract in `src/runner.ts` handles this — see the README's quarantine section.

## Notes on reproducibility

The commit SHA is exactly reproducible (shallow exact-SHA fetch). The **binary** sha256 above is the reference build recorded on the machine that produced the verification evidence; a rebuild on a different toolchain may produce a byte-different binary (different rustc/dependency resolution) while remaining behaviorally equivalent. If your rebuilt binary's sha256 differs, that is expected — the behavioral ground truth is the pinned commit plus the repository's test suite.

The engine clone and build artifacts are gitignored (`engine/` is never committed) — this file and `scripts/fetch-engine.sh` are the committed, reproducible record.