#!/usr/bin/env node
/**
 * Synthetic graphene-cli fake: writes a VALID PNG, then exits 1 — proves that
 * a nonzero exit with a valid artifact is still a RenderError (with the
 * validation outcome preserved in the error's message).
 */
import { writeFileSync } from 'node:fs';
import { buildMinimalPng, getOutputPath } from './_synthetic_lib.mjs';

const output = getOutputPath(process.argv.slice(2));
if (!output) {
  console.error('write-png-then-exit-one fake: missing --output/-o');
  process.exit(2);
}
writeFileSync(output, buildMinimalPng());
console.error('write-png-then-exit-one fake: artifact written, exiting 1 anyway');
process.exit(1);