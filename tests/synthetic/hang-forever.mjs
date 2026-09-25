#!/usr/bin/env node
/**
 * Synthetic graphene-cli fake: hangs forever (well past any test budget) until
 * the runner's timeout enforcement SIGKILLs it. Writes nothing.
 */
setInterval(() => {
  // keep the event loop alive; the runner's timeout is the only way out
}, 1_000);