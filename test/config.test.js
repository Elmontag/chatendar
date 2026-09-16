import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { FIXTURES, REPO_ROOT, testConfig } from './helpers.js';

const KEINE_CONFIG = path.join(FIXTURES, 'keine-config.json');

function lade(env = {}) {
  return loadConfig({ configFile: KEINE_CONFIG, env, cwd: REPO_ROOT });
}

describe('Konfiguration', () => {
  it('liefert sinnvolle Defaults', () => {
    const config = lade();
    assert.equal(config.source, 'file');
    assert.equal(config.dryRun, true, 'Dry-Run muss der sichere Default sein');
    assert.equal(config.defaultReminders, '1d,2h');
    assert.equal(config.maxReminders, 2);
  });

  it('löst Pfade absolut auf', () => {
    const config = lade({ DB_PATH: './data/test.db' });
    assert.ok(path.isAbsolute(config.dbPath));
  });

  it('parst Boolean-Werte großzügig', () => {
    const gruppe = { WHATSAPP_GROUP_ID: '120363000000000000@g.us' };
    assert.equal(lade({ DRY_RUN: 'false', ...gruppe }).dryRun, false);
    assert.equal(lade({ DRY_RUN: 'nein', ...gruppe }).dryRun, false);
    assert.equal(lade({ DRY_RUN: '1' }).dryRun, true);
    assert.throws(() => lade({ DRY_RUN: 'vielleicht' }), /Ungültiger Boolean-Wert/);
  });

  it('wandelt \\n in Templates in echte Zeilenumbrüche', () => {
    const config = lade({ TEMPLATE_SINGLE: 'A\\nB' });
    assert.equal(config.templateSingle, 'A\nB');
  });

  it('lässt CLI-Overrides gewinnen', () => {
    const config = loadConfig({
      configFile: KEINE_CONFIG,
      env: { DRY_RUN: 'true' },
      overrides: { dryRun: false, whatsappGroupId: '120363000000000000@g.us' },
      cwd: REPO_ROOT,
    });
    assert.equal(config.dryRun, false);
  });

  it('liest eine config.json', () => {
    const config = loadConfig({
      configFile: path.join(FIXTURES, 'config-beispiel.json'),
      env: {},
      cwd: REPO_ROOT,
    });
    assert.equal(config.defaultReminders, '3d,45m');
    assert.equal(config.selectCategory, 'Aushang');
  });

  it('lässt Umgebungsvariablen vor config.json gewinnen', () => {
    const config = loadConfig({
      configFile: path.join(FIXTURES, 'config-beispiel.json'),
      env: { DEFAULT_REMINDERS: '1h' },
      cwd: REPO_ROOT,
    });
    assert.equal(config.defaultReminders, '1h');
  });
});

describe('Validierung', () => {
  it('lehnt eine unbekannte Quelle ab', () => {
    assert.throws(() => lade({ SOURCE: 'google' }), /SOURCE muss "file" oder "caldav" sein/);
  });

  it('verlangt mindestens einen Selektionsweg', () => {
    assert.throws(
      () => lade({ SELECT_BY_CATEGORY: 'false', SELECT_BY_PREFIX: 'false' }),
      /Mindestens eine Selektionsmethode/,
    );
  });

  it('lehnt ungültige Default-Vorlaufzeiten ab', () => {
    assert.throws(() => lade({ DEFAULT_REMINDERS: 'bald' }), /DEFAULT_REMINDERS ist ungültig/);
  });

  it('verlangt die Gruppen-ID nur im Live-Modus', () => {
    assert.doesNotThrow(() => lade({ DRY_RUN: 'true', WHATSAPP_GROUP_ID: '' }));
    assert.throws(() => lade({ DRY_RUN: 'false', WHATSAPP_GROUP_ID: '' }), /WHATSAPP_GROUP_ID muss gesetzt sein/);
  });

  it('lehnt eine ungültige Zeitzone ab', () => {
    assert.throws(() => lade({ TIMEZONE: 'Mittelerde/Auenland' }), /TIMEZONE\/LOCALE ungültig/);
  });

  it('sammelt mehrere Fehler in einer Meldung', () => {
    try {
      lade({ SOURCE: 'google', DEFAULT_REMINDERS: 'bald' });
      assert.fail('hätte werfen müssen');
    } catch (error) {
      assert.match(error.message, /SOURCE muss/);
      assert.match(error.message, /DEFAULT_REMINDERS/);
    }
  });
});

describe('testConfig-Helfer', () => {
  it('liefert eine gültige Konfiguration für die Unit-Tests', () => {
    const config = testConfig();
    assert.equal(config.timezone, 'Europe/Berlin');
    assert.equal(config.dryRun, true);
  });
});
