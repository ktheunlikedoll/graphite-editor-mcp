/**
 * CLI binary resolution for the graphene-cli engine.
 *
 * Resolution order:
 *   1. GRAPHITE_CLI_PATH env var — used EXCLUSIVELY when set. A broken value
 *      fails precisely on that value instead of silently falling back
 *      (explicit user intent must not be papered over).
 *   2. <projectRoot>/engine/Graphite/target/debug/graphene-cli (the pinned
 *      debug build).
 *   3. CliNotFoundError with precise messages and the searched paths.
 *
 * projectRoot resolution (documented choice): walk up from THIS module's
 * directory looking for a package.json named "graphite-editor-mcp". This works
 * identically for src/ (vitest, tsx) and dist/ (compiled output), and survives
 * test runners that change cwd. If that walk fails, walk up from
 * process.cwd(); as a last resort, fall back to this module's parent
 * directory (src/.. or dist/..).
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliNotFoundError } from './errors.js';

/** CLI path relative to the project root (pinned debug build — ground truth). */
const DEFAULT_CLI_SEGMENTS = ['engine', 'Graphite', 'target', 'debug', 'graphene-cli'] as const;

const PACKAGE_MARKER = 'package.json';
const PACKAGE_NAME = 'graphite-editor-mcp';

/**
 * Walks up from startDir looking for the graphite-editor-mcp package.json marker.
 * Returns null if the filesystem root is reached first.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const marker = path.join(dir, PACKAGE_MARKER);
    if (existsSync(marker)) {
      try {
        const pkg = JSON.parse(readFileSync(marker, 'utf8')) as { name?: unknown };
        if (pkg.name === PACKAGE_NAME) return dir;
      } catch {
        // Unreadable package.json: keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolves the project root robustly (see module doc for the strategy). */
export function resolveProjectRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = findProjectRoot(moduleDir);
  if (fromModule) return fromModule;
  const fromCwd = findProjectRoot(process.cwd());
  if (fromCwd) return fromCwd;
  // Best-effort fallback: src/.. or dist/.. is the project root in both layouts.
  return path.dirname(moduleDir);
}

/** The default (pinned debug build) CLI path for the given/derived project root. */
export function defaultCliPath(root: string = resolveProjectRoot()): string {
  return path.join(root, ...DEFAULT_CLI_SEGMENTS);
}

/**
 * Resolves the graphene-cli binary path, verifying it is an existing,
 * executable, regular file. Throws CliNotFoundError with a precise,
 * actionable message otherwise.
 */
export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = defaultCliPath();
  const fromEnv = env.GRAPHITE_CLI_PATH?.trim();
  const candidates: readonly string[] = fromEnv ? [path.resolve(fromEnv)] : [fallback];

  let failure: string | null = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      failure ??= `no file exists at "${candidate}"`;
      continue;
    }
    if (!statSync(candidate).isFile()) {
      failure ??= `"${candidate}" is not a regular file`;
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      failure ??= `"${candidate}" exists but is not executable (missing execute permission)`;
      continue;
    }
    return path.resolve(candidate);
  }

  const reason = fromEnv
    ? `GRAPHITE_CLI_PATH is set to "${fromEnv}" but it is unusable: ${failure ?? 'unknown reason'}`
    : `no graphene-cli binary found and GRAPHITE_CLI_PATH is not set: ${failure ?? 'unknown reason'}`;
  throw new CliNotFoundError({ searchedPaths: candidates, reason });
}