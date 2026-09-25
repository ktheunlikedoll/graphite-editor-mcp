/**
 * The builder: template id + params → complete .graphite document, plus
 * deterministic serialization and file writing.
 *
 * Doctrine (brief): agents author documents as data; every call returns a
 * validated artifact or a precise error. All parameter validation lives in the
 * template factories (src/templates.ts); this module adds the boundary checks
 * (unknown template id, serialization stability) and reuses the Phase-2 error
 * taxonomy (`SpecInvalidError`) — no duplicated error classes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SpecInvalidError } from './errors.js';
import {
  DEFAULT_PARAMS,
  TEMPLATES,
  TEMPLATE_IDS,
  TemplateId,
  TemplateParams,
} from './templates.js';
import { GraphiteDocument } from './values.js';

/** The result of a successful build: the document plus its provenance. */
export interface BuiltDocument {
  templateId: TemplateId;
  /** The parameters EXACTLY as passed (defaults applied inside the document). */
  params: TemplateParams;
  document: GraphiteDocument;
}

/**
 * Builds a complete .graphite document from a template id and parameters.
 *
 * Throws SpecInvalidError (code "SPEC_INVALID") for:
 *  - an unknown template id (message lists every known id), or
 *  - any invalid parameter (each factory validates its own fields precisely).
 */
export function buildDocument(templateId: string, params: unknown): BuiltDocument {
  const definition = (TEMPLATES as Record<string, (typeof TEMPLATES)[TemplateId]>)[templateId];
  if (definition === undefined) {
    throw new SpecInvalidError(
      `unknown template id "${templateId}" — known templates: ${TEMPLATE_IDS.join(', ')}`,
    );
  }
  const document = definition.build(params as never);
  return {
    templateId: templateId as TemplateId,
    params: params as TemplateParams,
    document,
  };
}

/**
 * Builds a document from a template's DEFAULT parameters (the committed sample
 * outputs in templates/ are exactly these).
 */
export function buildDefaultDocument(templateId: string): BuiltDocument {
  const defaults = (DEFAULT_PARAMS as Record<string, TemplateParams | undefined>)[templateId];
  if (defaults === undefined) {
    throw new SpecInvalidError(
      `unknown template id "${templateId}" — known templates: ${TEMPLATE_IDS.join(', ')}`,
    );
  }
  return buildDocument(templateId, defaults);
}

/**
 * Deterministic serialization: pretty JSON with 2-space indent and a trailing
 * newline (the convention of every proven .graphite file). Key order is fixed
 * by the template factories' construction order, so the same document object
 * always serializes to the same bytes.
 */
export function serializeDocument(document: GraphiteDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Writes a document as a .graphite file (creating parent directories as
 * needed). Resolves with the absolute path written.
 */
export async function writeDocument(filePath: string, document: GraphiteDocument): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new SpecInvalidError(`filePath must be a non-empty string (got ${describe(filePath)})`);
  }
  if (!filePath.toLowerCase().endsWith('.graphite')) {
    throw new SpecInvalidError(
      `filePath must end in .graphite (got "${filePath}") — this is the engine's document format`,
    );
  }
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, serializeDocument(document), 'utf8');
  return resolved;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return typeof value;
}
