#!/usr/bin/env node
/**
 * Synthetic graphene-cli `list-node-identifiers` fake: prints identifiers,
 * exits 0 (the real command exits cleanly and fast; no quarantine needed).
 */
const identifiers = ['std.filter.blur', 'std.fill.solid', 'std.vector.path'];
console.log(identifiers.join('\n'));
process.exit(0);