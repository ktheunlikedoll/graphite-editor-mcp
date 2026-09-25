#!/usr/bin/env bash
# Fetch and build the pinned Graphite engine (graphene-cli).
#
# Shallow-fetches the exact pinned upstream commit into engine/Graphite/ and
# builds the debug graphene-cli binary that this MCP server resolves by
# default (<projectRoot>/engine/Graphite/target/debug/graphene-cli).
#
# Reference build facts (commit, binary sha256, toolchain): docs/ENGINE-PIN.md
#
# Requirements: git, cargo (https://rustup.rs). First build takes a while.
set -euo pipefail

PINNED_SHA="d7ae6029e0c1818d81a13b0389ef1808496a715b"

cd "$(dirname "$0")/.."
mkdir -p engine

if [ -d engine/Graphite/.git ] && [ "$(git -C engine/Graphite rev-parse HEAD 2>/dev/null)" = "$PINNED_SHA" ]; then
  echo "engine/Graphite already pinned at ${PINNED_SHA} — skipping fetch"
else
  rm -rf engine/Graphite
  git init engine/Graphite >/dev/null
  git -C engine/Graphite remote add origin https://github.com/GraphiteEditor/Graphite.git
  git -C engine/Graphite fetch --depth 1 origin "$PINNED_SHA"
  git -C engine/Graphite checkout --detach FETCH_HEAD
fi

echo "engine/Graphite HEAD: $(git -C engine/Graphite rev-parse HEAD)"

# Use cargo from the default rustup location when it is not already on PATH.
command -v cargo >/dev/null 2>&1 || export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install the Rust toolchain (https://rustup.rs)" >&2; exit 1; }

cd engine/Graphite
# Local patch layer: versioned patches from docs/engine-patches/ are applied
# deterministically after checkout. The PIN itself never changes — the upstream
# tree stays at PINNED_SHA; these are this project's sanctioned, reviewed
# additions on top (e.g. the dump-node-metadata registry command). Idempotent:
# already-applied patches are skipped via git apply --check.
for patch in ../../docs/engine-patches/*.patch; do
  [ -e "$patch" ] || continue
  if git apply --check "$patch" 2>/dev/null; then
    git apply "$patch"
    echo "applied engine patch: $(basename "$patch")"
  else
    echo "patch already applied or inapplicable, skipping: $(basename "$patch")"
  fi
done

cargo build -p graphene-cli

BIN="target/debug/graphene-cli"
[ -x "$BIN" ] || { echo "build did not produce an executable at engine/Graphite/$BIN" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  echo "built binary sha256: $(sha256sum "$BIN" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  echo "built binary sha256: $(shasum -a 256 "$BIN" | cut -d' ' -f1)"
fi
echo "FETCH_ENGINE_OK — reference build facts: docs/ENGINE-PIN.md"