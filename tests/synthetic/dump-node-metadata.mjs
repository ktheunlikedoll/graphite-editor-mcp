#!/usr/bin/env node
/**
 * Synthetic graphene-cli `dump-node-metadata` fake: prints one JSON metadata
 * object per line, exits 0 (the real command exits cleanly and fast).
 */
const lines = [
	{
		identifier: 'std.filter.blur',
		displayName: 'Blur',
		category: 'Raster: Filter',
		description: 'Blurs the input raster.',
		fields: [
			{ name: 'Image', description: 'The raster to blur.', type: 'Raster[]' },
			{ name: 'Sigma', description: 'Blur strength.', type: 'f64', default: '10.', softRange: [0, 100], step: 0.1, unit: 'px' },
		],
	},
	{
		identifier: 'std.fill.solid',
		displayName: 'Solid Color',
		category: 'General',
		description: 'Fills the area with one color.',
		fields: [{ name: 'Color', description: 'The fill color.', type: 'Color', default: 'Color :: BLACK' }],
	},
	{
		identifier: 'std.vector.path',
		displayName: 'Path',
		category: 'Vector',
		description: '',
		fields: [],
	},
];
console.log(lines.map((l) => JSON.stringify(l)).join('\n'));
process.exit(0);
