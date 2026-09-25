#!/usr/bin/env node
/**
 * Synthetic graphene-cli fake: clean exit 0 and writes nothing — the "CLI
 * reported success but no artifact exists" case.
 */
console.log('write-nothing-clean-exit fake: exiting cleanly without writing an artifact');
process.exit(0);