#!/usr/bin/env node
/**
 * Synthetic graphene-cli `export` fake: writes garbage (not decodable as any
 * artifact format) to the --output path, then dies with SIGSEGV. Exercises the
 * quarantine FAILURE path: crash + invalid artifact.
 */
import { writeFileSync } from 'node:fs';
import { dieBySegfault, getOutputPath } from './_synthetic_lib.mjs';

const output = getOutputPath(process.argv.slice(2));
if (!output) {
  console.error('write-garbage-then-segv fake: missing --output/-o');
  process.exit(2);
}
writeFileSync(output, Buffer.from('GRAPHITE SYNTHETIC GARBAGE - '.repeat(4), 'utf8'));
dieBySegfault();