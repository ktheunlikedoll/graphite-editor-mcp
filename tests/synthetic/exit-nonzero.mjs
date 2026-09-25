#!/usr/bin/env node
/**
 * Synthetic graphene-cli fake: exits 1 after writing nothing — the plain
 * render-failure case (invalid document, engine-side error, ...).
 */
console.error('exit-nonzero fake: deliberate failure (synthetic render error)');
process.exit(1);