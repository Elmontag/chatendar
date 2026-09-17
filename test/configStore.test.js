import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildConfigJson,
  buildProfilesConfigJson,
  profileIdFromName,
  readConfigJson,
  validateProfiles,
  validateValues,
  valuesFromConfig,
  writeConfigJson,
} from '../src/settings/configStore.js';
import { SETTINGS } from '../src/settings/metadata.js';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { FIXTURES } from './helpers.js';

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-config-store-'));
  tempDirs.push(dir);
  return dir;
}

describe('Settings config store', () => {
  it('deckt alle GUI-relevanten Konfigurationswerte in den Metadaten ab', () => {
    const expected = Object.keys(DEFAULTS).flatMap((key) =>
      key === 'caldav' ? Object.keys(DEFAULTS.caldav).map((child) => `caldav.${child}`) : key,
    );
    const actual = new Set(SETTINGS.map((setting) => setting.key));

    for (const key of expected) {
      assert.ok(actual.has(key), `Setting fehlt in der GUI: ${key}`);
    }
  });

  it('liest fehlende config.json als leere Konfiguration', () => {
    assert.deepEqual(readConfigJson(path.join(tempDir(), 'config.json')), {});
  });

  it('schreibt verschachtelte config.json-Werte typisiert', () => {
    const cwd = tempDir();
    const filePath = path.join(cwd, 'config.json');

    const written = writeConfigJson(
      {
        source: 'file',
        icsPath: path.join(FIXTURES, 'beispiel.ics'),
        selectByCategory: false,
        selectByPrefix: false,
        maxReminders: '3',
        'caldav.url': 'https://example.test/dav',
        templateSingle: 'Zeile 1\nZeile 2',
      },
      { cwd, filePath },
    );

    assert.equal(written.selectByCategory, false);
    assert.equal(written.maxReminders, 3);
    assert.equal(written.caldav.url, 'https://example.test/dav');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).templateSingle, 'Zeile 1\nZeile 2');

    const config = loadConfig({ cwd, configFile: filePath, env: {} });
    assert.equal(config.templateSingle, 'Zeile 1\nZeile 2');
    assert.equal(config.selectByCategory, false);
  });

  it('validiert Kandidaten ohne sie zu speichern', () => {
    const cwd = tempDir();
    const filePath = path.join(cwd, 'config.json');

    const result = validateValues(
      {
        source: 'file',
        icsPath: path.join(FIXTURES, 'beispiel.ics'),
        defaultReminders: 'bald',
      },
      { cwd, filePath },
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /DEFAULT_REMINDERS/);
    assert.equal(fs.existsSync(filePath), false);
  });

  it('maskiert sensitive Werte in API-Ausgaben', () => {
    const values = valuesFromConfig({
      source: 'file',
      caldav: { password: 'geheim' },
    });

    assert.equal(values['caldav.password'], '********');
  });

  it('behält maskierte sensitive Werte beim Schreiben bei', () => {
    const config = buildConfigJson({ 'caldav.password': '********', 'caldav.username': 'user' }, {
      caldav: { password: 'alt' },
    });

    assert.equal(config.caldav.password, 'alt');
    assert.equal(config.caldav.username, 'user');
  });

  it('erhält maskierte sensitive Werte beim Kopieren eines Profils über originalId', () => {
    const config = buildProfilesConfigJson([{
      id: 'privat-kopie',
      originalId: 'privat',
      name: 'Privat Kopie',
      values: {
        source: 'caldav',
        'caldav.url': '********',
        'caldav.username': '********',
        'caldav.password': '********',
        'caldav.calendar': 'Familie',
      },
      whatsappGroups: [],
    }], {
      profiles: [{
        id: 'privat',
        name: 'Privat',
        source: 'caldav',
        caldav: {
          url: 'https://cloud.example.test/dav',
          username: 'user@example.test',
          password: 'secret',
          calendar: 'Familie',
        },
      }],
    });

    assert.equal(config.profiles[0].caldav.url, 'https://cloud.example.test/dav');
    assert.equal(config.profiles[0].caldav.username, 'user@example.test');
    assert.equal(config.profiles[0].caldav.password, 'secret');
  });

  it('lehnt unvollständige Profile und Ziele vor dem Speichern ab', () => {
    const result = validateProfiles([{
      id: 'schule',
      name: '',
      values: {},
      whatsappGroups: [{ id: '', name: 'Klasse 3' }],
    }], { cwd: tempDir() });

    assert.equal(result.ok, false);
    assert.match(result.error, /Profil 1 braucht einen Namen/);
    assert.match(result.error, /WhatsApp-Ziel 1 in Profil 1 braucht eine Gruppen-ID/);
  });

  it('erzeugt sichere Profil-IDs und ignoriert leere Gruppenplatzhalter im Dry-Run', () => {
    const cwd = tempDir();
    const result = validateProfiles([{
      name: 'Schule & Ferien',
      enabled: true,
      values: {
        source: 'file',
        icsPath: path.join(FIXTURES, 'beispiel.ics'),
        dryRun: true,
      },
      whatsappGroups: [{ id: '', name: '', enabled: true }],
    }], { cwd });

    assert.equal(result.ok, true);
    assert.equal(result.config.profiles[0].id, 'schule-ferien');
    assert.deepEqual(result.config.profiles[0].whatsappTargets, []);
    assert.equal(profileIdFromName('Straße / Café'), 'strasse-cafe');
  });

  it('lehnt unsichere und doppelte Profil-IDs weiterhin ab', () => {
    const cwd = tempDir();
    const unsafe = validateProfiles([{
      id: 'schule/ferien',
      name: 'Schule',
      values: {},
      whatsappGroups: [],
    }], { cwd });
    const duplicate = validateProfiles([
      { id: 'schule', name: 'Schule', values: {}, whatsappGroups: [] },
      { id: 'schule', name: 'Ferien', values: {}, whatsappGroups: [] },
    ], { cwd });

    assert.equal(unsafe.ok, false);
    assert.match(unsafe.error, /darf nur Buchstaben/);
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /ist doppelt/);
  });

  it('behält leere Zielplatzhalter nicht in der gespeicherten Konfiguration', () => {
    const config = buildProfilesConfigJson([{
      name: 'Privat',
      values: {},
      whatsappGroups: [{ id: '', name: '' }],
    }]);

    assert.equal(config.profiles[0].id, 'privat');
    assert.deepEqual(config.profiles[0].whatsappTargets, []);
  });

  it('migriert whatsappGroups[] beim Speichern in whatsappTargets[]', () => {
    const config = buildProfilesConfigJson([{
      id: 'schule',
      name: 'Schule',
      values: { source: 'file' },
      whatsappGroups: [{ id: '120363000000000001@g.us', name: 'Klasse 3', enabled: true }],
    }]);

    assert.ok(!('whatsappGroupId' in config.profiles[0]));
    assert.ok(!('whatsappGroups' in config.profiles[0]));
    assert.deepEqual(config.profiles[0].whatsappTargets[0], {
      type: 'group',
      id: '120363000000000001@g.us',
      name: 'Klasse 3',
      enabled: true,
    });
  });

  it('speichert gemischte Ziele und entfernt alte Gruppenfelder', () => {
    const config = buildProfilesConfigJson([{
      id: 'schule',
      name: 'Schule',
      values: {},
      whatsappTargets: [
        { type: 'group', id: '120363000000000002@g.us', name: 'Orga', enabled: true },
        { type: 'person', phone: '+4915112345678', name: 'Ada', enabled: true },
      ],
    }], {
      profiles: [{
        id: 'schule',
        name: 'Schule',
        whatsappGroupId: '120363000000000009@g.us',
        whatsappGroups: [{ id: '120363000000000009@g.us', name: 'Alt', enabled: true }],
      }],
    });

    assert.ok(!('whatsappGroupId' in config.profiles[0]));
    assert.ok(!('whatsappGroups' in config.profiles[0]));
    assert.deepEqual(config.profiles[0].whatsappTargets, [
      { type: 'group', id: '120363000000000002@g.us', name: 'Orga', enabled: true },
      { type: 'person', phone: '+4915112345678', name: 'Ada', enabled: true },
    ]);
  });

  it('markiert whatsappGroupId in den Metadaten als versteckt (Legacy-only)', () => {
    const setting = SETTINGS.find((item) => item.key === 'whatsappGroupId');

    assert.ok(setting.hidden, 'whatsappGroupId sollte in Profil-Formularen nicht angezeigt werden');
  });
});
