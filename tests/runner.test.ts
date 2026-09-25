/**
 * Unit tests for the process runner (src/runner.ts) and CLI resolution
 * (src/paths.ts), exercised exclusively through the synthetic fake CLIs in
 * tests/synthetic. The real graphene-cli binary is never required here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportArgs, GraphiteRunner } from '../src/runner.js';
import { defaultCliPath, resolveCliPath, resolveProjectRoot } from '../src/paths.js';
import {
  ArtifactInvalidError,
  CliNotFoundError,
  DocInvalidError,
  RenderError,
  SpecInvalidError,
  TimeoutError,
} from '../src/errors.js';
import type { RenderSpec } from '../src/types.js';

const SYNTH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'synthetic');

const FAKES = [
  'write-then-segv.mjs',
  'write-garbage-then-segv.mjs',
  'write-nothing-clean-exit.mjs',
  'exit-nonzero.mjs',
  'hang-forever.mjs',
  'write-png-clean-exit.mjs',
  'write-png-then-exit-one.mjs',
  'list-nodes.mjs',
  'dump-node-metadata.mjs',
  'dump-node-metadata-partial.mjs',
] as const;

const fake = (name: (typeof FAKES)[number]) => path.join(SYNTH_DIR, name);

async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function catchSyncError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected fn to throw, but it returned');
}

let tmpDir = '';

beforeAll(async () => {
  // Defensive: keep the fake CLIs executable even after a fresh checkout.
  for (const name of FAKES) {
    await chmod(fake(name), 0o755);
  }
});

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'graphite-runner-'));
  await writeFile(path.join(tmpDir, 'doc.graphite'), '{"synthetic": true}', 'utf8');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const doc = () => path.join(tmpDir, 'doc.graphite');

function pngRenderSpec(output: string, size = { width: 8, height: 4 }): RenderSpec {
  return { document: doc(), output, size };
}

describe('quarantine: SIGSEGV after writing the artifact', () => {
  it('returns a quarantined success when the artifact validates', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-then-segv.mjs') });
    const output = path.join(tmpDir, 'artifact.png');

    const result = await runner.render(pngRenderSpec(output));

    expect(result.format).toBe('png');
    expect(result.byteSize).toBeGreaterThan(0);
    // The fixture writes a real 1x1 PNG.
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.quarantine).toBeDefined();
    expect(result.quarantine?.quarantinedAfterWrite).toBe(true);
    expect(
      result.quarantine?.signal === 'SIGSEGV' || result.quarantine?.exitCode === 139,
    ).toBe(true);
    expect(typeof result.stderrTail).toBe('string');
    expect(existsSync(output)).toBe(true);
  });

  it('throws ArtifactInvalidError when the crash left garbage behind', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-garbage-then-segv.mjs') });
    const output = path.join(tmpDir, 'garbage.png');

    const err = await catchError(runner.render(pngRenderSpec(output)));

    expect(err instanceof ArtifactInvalidError).toBe(true);
    if (err instanceof ArtifactInvalidError) {
      expect(err.artifactPath).toBe(output);
      expect(err.reason).toMatch(/PNG|signature|valid/i);
      expect(typeof err.stderrTail).toBe('string');
    }
  });
});

describe('clean exits (artifact validation is unconditional)', () => {
  it('exit 0 + valid artifact -> success without quarantine metadata', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-png-clean-exit.mjs') });
    const output = path.join(tmpDir, 'clean.png');

    const result = await runner.render(pngRenderSpec(output));

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.quarantine).toBeUndefined();
    expect(result.byteSize).toBeGreaterThan(0);
    // Arg-assembly invariant, observed end-to-end: the fake echoes its argv.
    expect(result.stdoutTail).toContain('"--width"');
    expect(result.stdoutTail).toContain('"--height"');
    expect(result.stdoutTail).toContain('"8"');
    expect(result.stdoutTail).toContain('"4"');
  });

  it('exit 0 + no artifact -> ArtifactInvalidError with an explicit reason', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-nothing-clean-exit.mjs') });
    const output = path.join(tmpDir, 'missing.png');

    const err = await catchError(runner.render(pngRenderSpec(output)));

    expect(err instanceof ArtifactInvalidError).toBe(true);
    if (err instanceof ArtifactInvalidError) {
      expect(err.reason).toMatch(/does not exist/i);
    }
  });

  it('nonzero exit + no artifact -> RenderError carrying the stderr tail', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('exit-nonzero.mjs') });
    const output = path.join(tmpDir, 'failed.png');

    const err = await catchError(runner.render(pngRenderSpec(output)));

    expect(err instanceof RenderError).toBe(true);
    if (err instanceof RenderError) {
      expect(err.exitCode).toBe(1);
      expect(err.signal).toBeNull();
      expect(err.stderrTail).toMatch(/deliberate failure/);
    }
  });

  it('nonzero exit + valid artifact -> RenderError that notes the validated artifact', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-png-then-exit-one.mjs') });
    const output = path.join(tmpDir, 'exit-one.png');

    const err = await catchError(runner.render(pngRenderSpec(output)));

    expect(err instanceof RenderError).toBe(true);
    if (err instanceof RenderError) {
      expect(err.exitCode).toBe(1);
      expect(err.message).toMatch(/passed validation/i);
    }
  });
});

describe('timeout enforcement', () => {
  it('kills the child and throws TimeoutError when the render exceeds its budget', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('hang-forever.mjs'), timeoutMs: 250 });
    const output = path.join(tmpDir, 'slow.png');

    const startedAt = Date.now();
    const err = await catchError(runner.render(pngRenderSpec(output)));

    expect(err instanceof TimeoutError).toBe(true);
    if (err instanceof TimeoutError) {
      expect(err.timeoutMs).toBe(250);
      expect(err.message).toContain('250ms');
    }
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});

describe('export arg assembly invariants (buildExportArgs)', () => {
  it('always emits --width and --height together for raster formats', () => {
    const args = buildExportArgs({
      document: 'doc.graphite',
      output: 'out.png',
      size: { width: 64, height: 32 },
    });

    expect(args).toContain('--width');
    expect(args).toContain('--height');
    expect(args[args.indexOf('--width') + 1]).toBe('64');
    expect(args[args.indexOf('--height') + 1]).toBe('32');
  });

  it('refuses raster output without an explicit size (width-only is impossible by construction)', () => {
    const noSize = { document: 'doc.graphite', output: 'out.png' } as unknown as RenderSpec;
    expect(() => buildExportArgs(noSize)).toThrow(SpecInvalidError);

    // Width-only cannot be expressed in TypeScript; the runtime guard catches
    // hand-built objects from JavaScript callers.
    const widthOnly = {
      document: 'doc.graphite',
      output: 'out.png',
      size: { width: 64 },
    } as unknown as RenderSpec;
    expect(() => buildExportArgs(widthOnly)).toThrow(/height/i);

    const heightOnlyJpg = {
      document: 'doc.graphite',
      output: 'out.jpg',
      size: { height: 10 },
    } as unknown as RenderSpec;
    expect(() => buildExportArgs(heightOnlyJpg)).toThrow(/width/i);
  });

  it('assembles GIF timing flags for both modes and keeps both dimensions', () => {
    const framesArgs = buildExportArgs({
      document: 'd.graphite',
      output: 'out.gif',
      size: { width: 16, height: 16 },
      gif: { mode: 'frames', fps: 12, frames: 30 },
    });
    expect(framesArgs).toEqual(
      expect.arrayContaining(['--fps', '12', '--frames', '30', '--width', '16', '--height', '16']),
    );

    const durationArgs = buildExportArgs({
      document: 'd.graphite',
      output: 'out.gif',
      size: { width: 16, height: 16 },
      gif: { mode: 'duration', duration: 2.5 },
    });
    expect(durationArgs).toEqual(
      expect.arrayContaining(['--duration', '2.5', '--width', '16', '--height', '16']),
    );
  });

  it('rejects GIF output without timing and invalid timing values', () => {
    expect(() =>
      buildExportArgs({ document: 'd.graphite', output: 'out.gif', size: { width: 16, height: 16 } }),
    ).toThrow(SpecInvalidError);

    const zeroFps = {
      document: 'd.graphite',
      output: 'out.gif',
      size: { width: 16, height: 16 },
      gif: { mode: 'frames', fps: 0, frames: 10 },
    } as unknown as RenderSpec;
    expect(() => buildExportArgs(zeroFps)).toThrow(/fps/i);
  });

  it('rejects unsupported output extensions before spawning (PDF included)', () => {
    const err = catchSyncError(() =>
      buildExportArgs({ document: 'd.graphite', output: 'out.pdf', size: { width: 16, height: 16 } }),
    );
    expect(err instanceof SpecInvalidError).toBe(true);
    expect(err.message).toMatch(/pdf/i);
    expect(err.message).toMatch(/\.svg|\.png|\.gif/i);
    expect(() => buildExportArgs({ document: 'd.graphite', output: 'no-extension' })).toThrow(
      SpecInvalidError,
    );
  });

  it('lets SVG omit size and passes --scale/--transparent through', () => {
    const plain = buildExportArgs({ document: 'd.graphite', output: 'out.svg' });
    expect(plain).toEqual(['export', 'd.graphite', '--output', 'out.svg']);

    const dressed = buildExportArgs({
      document: 'd.graphite',
      output: 'out.svg',
      scale: 2,
      transparent: true,
    });
    expect(dressed).toEqual(expect.arrayContaining(['--scale', '2', '--transparent']));
  });

  it('rejects a malformed spec before spawning', () => {
    expect(() =>
      buildExportArgs({ document: '', output: 'out.png', size: { width: 1, height: 1 } }),
    ).toThrow(SpecInvalidError);
  });
});

describe('compile + listNodeIdentifiers wrap the CLI uniformly', () => {
  it('compile resolves on exit 0 and surfaces stdout/stderr', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-nothing-clean-exit.mjs') });

    const result = await runner.compile(doc());

    expect(result.exitCode).toBe(0);
    expect(result.document).toBe(doc());
    expect(result.stdout).toContain('write-nothing-clean-exit fake');
  });

  it('compile maps nonzero exits to DocInvalidError with the CLI stderr', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('exit-nonzero.mjs') });

    const err = await catchError(runner.compile(doc()));

    expect(err instanceof DocInvalidError).toBe(true);
    if (err instanceof DocInvalidError) {
      expect(err.documentPath).toBe(doc());
      expect(err.exitCode).toBe(1);
      expect(err.stderrTail).toMatch(/deliberate failure/);
    }
  });

  it('listNodeIdentifiers parses the identifier list from stdout', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('list-nodes.mjs') });

    const result = await runner.listNodeIdentifiers();

    expect(result.exitCode).toBe(0);
    expect(result.identifiers).toEqual(['std.filter.blur', 'std.fill.solid', 'std.vector.path']);
  });

  it('dumpNodeMetadata parses the JSONL registry dump', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('dump-node-metadata.mjs') });

    const result = await runner.dumpNodeMetadata();

    expect(result.exitCode).toBe(0);
    expect(result.nodes).toHaveLength(3);
    const blur = result.nodes.find((n) => n.identifier === 'std.filter.blur');
    expect(blur).toBeDefined();
    expect(blur?.displayName).toBe('Blur');
    expect(blur?.category).toBe('Raster: Filter');
    expect(blur?.fields).toHaveLength(2);
    const sigma = blur?.fields.find((f) => f.name === 'Sigma');
    expect(sigma?.default).toBe('10.');
    expect(sigma?.softRange).toEqual([0, 100]);
    expect(sigma?.step).toBe(0.1);
    expect(sigma?.unit).toBe('px');
  });

  it('dumpNodeMetadata skips malformed JSONL lines instead of failing', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('dump-node-metadata-partial.mjs') });

    const result = await runner.dumpNodeMetadata();

    expect(result.exitCode).toBe(0);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.identifier).toBe('std.fill.solid');
  });
});

describe('artifact hygiene', () => {
  it('never validates a stale artifact left by a previous run', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-nothing-clean-exit.mjs') });
    const output = path.join(tmpDir, 'stale.png');
    await writeFile(
      output,
      Buffer.from('STALE GARBAGE from a previous run - not an image at all, padding padding padding padding padding'),
    );

    const err = await catchError(runner.render(pngRenderSpec(output)));

    expect(err instanceof ArtifactInvalidError).toBe(true);
    if (err instanceof ArtifactInvalidError) {
      expect(err.reason).toMatch(/does not exist/i);
    }
  });

  it('creates missing output directories instead of failing the render', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-png-clean-exit.mjs') });
    const output = path.join(tmpDir, 'nested', 'deeper', 'artifact.png');

    const result = await runner.render(pngRenderSpec(output));

    expect(result.byteSize).toBeGreaterThan(0);
    expect(existsSync(output)).toBe(true);
  });

  it('refuses a missing document with a precise error before spawning', async () => {
    const runner = new GraphiteRunner({ cliPath: fake('write-png-clean-exit.mjs') });
    const spec: RenderSpec = {
      document: path.join(tmpDir, 'ghost.graphite'),
      output: path.join(tmpDir, 'x.png'),
      size: { width: 4, height: 4 },
    };

    const err = await catchError(runner.render(spec));

    expect(err instanceof DocInvalidError).toBe(true);
    if (err instanceof DocInvalidError) {
      expect(err.documentPath).toBe(path.join(tmpDir, 'ghost.graphite'));
    }
  });
});

describe('CLI resolution (src/paths.ts)', () => {
  it('prefers GRAPHITE_CLI_PATH when it points at an executable file', () => {
    const override = fake('write-png-clean-exit.mjs');
    expect(resolveCliPath({ GRAPHITE_CLI_PATH: override })).toBe(path.resolve(override));
  });

  it('throws CliNotFoundError naming the env var when GRAPHITE_CLI_PATH points at a missing file', () => {
    const err = catchSyncError(() => resolveCliPath({ GRAPHITE_CLI_PATH: '/nonexistent/graphene-cli' }));
    expect(err instanceof CliNotFoundError).toBe(true);
    expect(err.message).toContain('GRAPHITE_CLI_PATH');
  });

  it('throws CliNotFoundError when the resolved path exists but is not executable', async () => {
    const notExecutable = path.join(tmpDir, 'not-executable.sh');
    await writeFile(notExecutable, '#!/bin/sh\n', 'utf8');
    await chmod(notExecutable, 0o644);

    const err = catchSyncError(() => resolveCliPath({ GRAPHITE_CLI_PATH: notExecutable }));

    expect(err instanceof CliNotFoundError).toBe(true);
    expect(err.message).toMatch(/not executable/i);
  });

  it('derives the default path from the project root', () => {
    expect(resolveProjectRoot()).toMatch(/graphite-(editor-)?mcp$/);
    expect(defaultCliPath()).toMatch(/engine[/\\]Graphite[/\\]target[/\\]debug[/\\]graphene-cli$/);
  });

  it('fails fast at GraphiteRunner construction on a bogus cliPath', () => {
    expect(() => new GraphiteRunner({ cliPath: '/nonexistent/graphene-cli' })).toThrow(CliNotFoundError);
  });
});