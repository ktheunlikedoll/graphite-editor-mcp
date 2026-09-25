#!/usr/bin/env node
/**
 * Synthetic graphene-cli `export` fake: clean exit 0 after writing a REAL
 * minimal PNG. Echoes its argv to stdout so tests can assert the exact
 * arguments the runner assembled (e.g. that --width and --height are both
 * always present).
 */
import { writeFileSync } from 'node:fs';
import { buildMinimalPng, getOutputPath } from './_synthetic_lib.mjs';

const output = getOutputPath(process.argv.slice(2));
if (!output) {
  console.error('write-png-clean-exit fake: missing --output/-o');
  process.exit(2);
}
writeFileSync(output, buildMinimalPng());
console.log(`FAKE_ARGV ${JSON.stringify(process.argv.slice(2))}`);
process.exit(0);