import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import fs from 'node:fs';
import os from 'node:os';

import { loadConfig, loadRuntimeConfig } from '../src/config.js';
import { FIXTURES, REPO_ROOT, testConfig } from './helpers.js';

const KEINE_CONFIG = path.join(FIXTURES, 'keine-config.json');

function lade(env = {}) {
  return loadConfig({ configFile: KEINE_CONFIG, env, cwd: REPO_ROOT });
}

function writeTempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-config-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { dir, file };
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

  it('normalisiert legacy config als Standardprofil', () => {
    const runtime = loadRuntimeConfig({ configFile: KEINE_CONFIG, env: { WHATSAPP_GROUP_ID: '120363000000000000@g.us' }, cwd: REPO_ROOT });
    assert.equal(runtime.enabledProfiles.length, 1);
    assert.equal(runtime.enabledProfiles[0].profileId, 'default');
    assert.equal(runtime.enabledProfiles[0].whatsappGroups[0].id, '120363000000000000@g.us');
  });

  it('leitet whatsappGroupId (Legacy) aus der ersten aktiven Gruppe eines Profils ab', () => {
    const { dir, file } = writeTempConfig({
      profiles: [{
        id: 'schule',
        name: 'Schule',
        dryRun: true,
        whatsappGroups: [
          { id: '120363000000000001@g.us', name: 'Deaktiviert', enabled: false },
          { id: '120363000000000002@g.us', name: 'Aktiv', enabled: true },
        ],
      }],
    });
    try {
      const runtime = loadRuntimeConfig({ configFile: file, env: {}, cwd: dir });
      assert.equal(runtime.profiles[0].whatsappGroupId, '120363000000000002@g.us');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('liest mehrere Profile mit eigenen vollständigen Einstellungen', () => {
    const { dir, file } = writeTempConfig({
      profiles: [
        {
          id: 'schule',
          name: 'Schule',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          defaultReminders: '1d',
          whatsappGroups: [
            { id: '120363000000000001@g.us', name: 'Klasse 3' },
            { id: '120363000000000002@g.us', name: 'Orga' },
          ],
        },
        {
          id: 'verein',
          name: 'Verein',
          source: 'file',
          icsPath: path.join(FIXTURES, 'edge-cases.ics'),
          selectByCategory: false,
          selectByPrefix: false,
          enabled: false,
          whatsappGroups: ['120363000000000003@g.us'],
        },
      ],
    });
    try {
      const runtime = loadRuntimeConfig({ configFile: file, env: {}, cwd: dir });
      assert.equal(runtime.profiles.length, 2);
      assert.equal(runtime.enabledProfiles.length, 1);
      assert.equal(runtime.profiles[0].profileId, 'schule');
      assert.equal(runtime.profiles[0].defaultReminders, '1d');
      assert.equal(runtime.profiles[0].whatsappGroups.length, 2);
      assert.equal(runtime.profiles[1].selectByCategory, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Validierung', () => {
  it('lehnt eine unbekannte Quelle ab', () => {
    assert.throws(() => lade({ SOURCE: 'google' }), /SOURCE muss "file" oder "caldav" sein/);
  });

  it('verlangt CalDAV-Zugangsdaten nur für SOURCE=caldav', () => {
    assert.doesNotThrow(() => lade({ SOURCE: 'file' }));
    assert.throws(() => lade({ SOURCE: 'caldav' }), /CALDAV_URL muss gesetzt sein/);
    assert.doesNotThrow(() =>
      lade({
        SOURCE: 'caldav',
        CALDAV_URL: 'https://cloud.example.test/remote.php/dav',
        CALDAV_USERNAME: 'user',
        CALDAV_PASSWORD: 'secret',
        CALDAV_CALENDAR: 'Familie',
      }),
    );
  });

  it('erlaubt das Abschalten beider Selektionswege (= kein Filter)', () => {
    const config = lade({ SELECT_BY_CATEGORY: 'false', SELECT_BY_PREFIX: 'false' });
    assert.equal(config.selectByCategory, false);
    assert.equal(config.selectByPrefix, false);
  });

  it('prüft die Einstellungen der Wochenübersicht', () => {
    assert.throws(() => lade({ DIGEST_ENABLED: 'true', DIGEST_DAY: 'Freitagabend' }), /DIGEST_DAY ist ungültig/);
    assert.throws(() => lade({ DIGEST_ENABLED: 'true', DIGEST_TIME: '25:00' }), /DIGEST_TIME ist ungültig/);
    assert.throws(() => lade({ DIGEST_ENABLED: 'true', DIGEST_RANGE: 'bald' }), /DIGEST_RANGE ist ungültig/);
    assert.doesNotThrow(() => lade({ DIGEST_ENABLED: 'true', DIGEST_RANGE: 'next-week' }));
    // Ungültige Werte stören nicht, solange die Übersicht aus ist.
    assert.doesNotThrow(() => lade({ DIGEST_ENABLED: 'false', DIGEST_DAY: 'Unsinn' }));
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

  it('lehnt doppelte Profil-IDs ab', () => {
    const { dir, file } = writeTempConfig({
      profiles: [
        { id: 'schule', icsPath: path.join(FIXTURES, 'beispiel.ics') },
        { id: 'schule', icsPath: path.join(FIXTURES, 'beispiel.ics') },
      ],
    });
    try {
      assert.throws(() => loadRuntimeConfig({ configFile: file, env: {}, cwd: dir }), /Profil-ID "schule" ist doppelt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lehnt unsichere Profil-IDs ab, statt sie still umzuschreiben', () => {
    const { dir, file } = writeTempConfig({
      profiles: [{ id: 'schule/ferien', icsPath: path.join(FIXTURES, 'beispiel.ics') }],
    });
    try {
      assert.throws(
        () => loadRuntimeConfig({ configFile: file, env: {}, cwd: dir }),
        /Profil-ID "schule\/ferien" darf nur Buchstaben/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verlangt ein aktiviertes Profil und eindeutige Gruppen-IDs', () => {
    const { dir, file } = writeTempConfig({
      profiles: [
        {
          id: 'schule',
          enabled: false,
          whatsappGroups: ['120363000000000001@g.us', '120363000000000001@g.us'],
        },
      ],
    });
    try {
      assert.throws(
        () => loadRuntimeConfig({ configFile: file, env: {}, cwd: dir }),
        /WhatsApp-Gruppen-ID .* doppelt.*Mindestens ein Profil muss aktiviert sein/s,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validiert aktive Gruppen im Live-Modus', () => {
    const { dir, file } = writeTempConfig({
      profiles: [
        {
          id: 'schule',
          dryRun: false,
          whatsappGroups: [{ id: 'keine-gueltige-gruppe', enabled: true }],
        },
      ],
    });
    try {
      assert.throws(
        () => loadRuntimeConfig({ configFile: file, env: {}, cwd: dir }),
        /muss auf "@g\.us" enden/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignoriert leere Gruppenplatzhalter im Dry-Run', () => {
    const { dir, file } = writeTempConfig({
      profiles: [{
        id: 'schule',
        name: 'Schule',
        dryRun: true,
        whatsappGroups: [{ id: '', name: '', enabled: true }],
      }],
    });
    try {
      const runtime = loadRuntimeConfig({ configFile: file, env: {}, cwd: dir });
      assert.deepEqual(runtime.profiles[0].whatsappGroups, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lehnt leere oder ungültige Gruppen im Live-Modus weiterhin ab', () => {
    const empty = writeTempConfig({
      profiles: [{
        id: 'schule',
        name: 'Schule',
        dryRun: false,
        whatsappGroups: [{ id: '', name: '', enabled: true }],
      }],
    });
    const invalid = writeTempConfig({
      profiles: [{
        id: 'verein',
        name: 'Verein',
        dryRun: false,
        whatsappGroups: [{ id: 'keine-gruppe', name: 'Orga', enabled: true }],
      }],
    });
    try {
      assert.throws(
        () => loadRuntimeConfig({ configFile: empty.file, env: {}, cwd: empty.dir }),
        /WHATSAPP_GROUP_ID muss gesetzt sein|braucht im Live-Modus mindestens eine aktive WhatsApp-Gruppe/,
      );
      assert.throws(
        () => loadRuntimeConfig({ configFile: invalid.file, env: {}, cwd: invalid.dir }),
        /muss auf "@g\.us" enden/,
      );
    } finally {
      fs.rmSync(empty.dir, { recursive: true, force: true });
      fs.rmSync(invalid.dir, { recursive: true, force: true });
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
