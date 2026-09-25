import { defineConfig } from 'vitest/config';

// Unit tests run exclusively against the synthetic fake CLIs in tests/synthetic —
// the real graphene-cli binary is never required (or run) by this suite.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});