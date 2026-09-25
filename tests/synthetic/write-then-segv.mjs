#!/usr/bin/env node
/**
 * Synthetic graphene-cli `export` fake: writes a REAL minimal PNG to the
 * --output path, then dies with SIGSEGV — reproducing the measured engine
 * behavior (successful exports exit 139 after the artifact is written).
 */
import { writeFileSync } from 'node:fs';
import { buildMinimalPng, dieBySegfault, getOutputPath } from './_synthetic_lib.mjs';

const output = getOutputPath(process.argv.slice(2));
if (!output) {
  console.error('write-then-segv fake: missing --output/-o');
  process.exit(2);
}
writeFileSync(output, buildMinimalPng());
dieBySegfault();