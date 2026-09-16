/**
 * Gemeinsame Test-Helfer.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');

/**
 * Konfiguration für Tests – isoliert von einer lokal vorhandenen .env/config.json,
 * weil ein eigenes env-Objekt übergeben wird.
 */
export function testConfig(overrides = {}) {
  return loadConfig({
    configFile: path.join(FIXTURES, 'keine-config.json'), // existiert bewusst nicht
    env: {
      SOURCE: 'file',
      ICS_PATH: path.join(FIXTURES, 'beispiel.ics'),
      TIMEZONE: 'Europe/Berlin',
      LOCALE: 'de-DE',
      DRY_RUN: 'true',
      ...Object.fromEntries(Object.entries(overrides.env ?? {})),
    },
    overrides: { ...overrides, env: undefined },
    cwd: REPO_ROOT,
  });
}

/** Termin-Objekt für Unit-Tests, ohne ICS-Datei. */
export function makeEvent(partial = {}) {
  return {
    id: 'test-1',
    uid: 'test-1',
    titel: 'Testtermin',
    start: new Date('2026-09-20T16:30:00Z'),
    ende: new Date('2026-09-20T18:00:00Z'),
    ort: null,
    kategorien: [],
    customProps: {},
    ganztags: false,
    serie: false,
    ...partial,
  };
}
