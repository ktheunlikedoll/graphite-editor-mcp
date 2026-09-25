#!/usr/bin/env node
/**
 * Synthetic graphene-cli `dump-node-metadata` fake: one valid metadata line,
 * then garbage, then a truncated line — the runner must skip bad lines.
 */
const good = {
	identifier: 'std.fill.solid',
	displayName: 'Solid Color',
	category: 'General',
	description: 'Fills the area with one color.',
	fields: [],
};
console.log(JSON.stringify(good));
console.log('this is not JSON at all');
console.log('{"identifier": "truncated"'); // truncated JSON
process.exit(0);
