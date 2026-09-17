import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  createSettingsServer,
  parseSettingsServerArgs,
  SETTINGS_USAGE,
  startSettingsServer,
} from '../src/settings/server.js';
import { openDatabase, SENT_STATUS } from '../src/state/db.js';
import { buildReminders } from '../src/reminders/scheduler.js';
import { FIXTURES } from './helpers.js';

const tempDirs = [];
let server;
let baseUrl;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-settings-server-'));
  tempDirs.push(dir);
  return dir;
}

function listen(instance) {
  return new Promise((resolve) => {
    instance.listen(0, '127.0.0.1', () => resolve(instance.address()));
  });
}

async function request(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

describe('Settings server arguments', () => {
  it('verwendet standardmäßig ausschließlich den lokalen Listener', () => {
    assert.deepEqual(parseSettingsServerArgs([]), {
      host: '127.0.0.1',
      port: 3876,
      help: false,
    });
  });

  it('akzeptiert Host und Port getrennt oder mit Gleichheitszeichen', () => {
    assert.deepEqual(parseSettingsServerArgs(['--host', '192.168.1.50', '--port', '43876']), {
      host: '192.168.1.50',
      port: 43876,
      help: false,
    });
    assert.deepEqual(parseSettingsServerArgs(['--host=192.168.178.20', '--port=3877']), {
      host: '192.168.178.20',
      port: 3877,
      help: false,
    });
  });

  it('lehnt fehlende, ungültige und unbekannte Argumente ab', () => {
    assert.throws(() => parseSettingsServerArgs(['--host']), /--host.*erwartet einen Wert/);
    assert.throws(() => parseSettingsServerArgs(['--host', '-h']), /--host.*erwartet einen Wert/);
    assert.throws(() => parseSettingsServerArgs(['--host=']), /nicht leere Adresse/);
    assert.throws(() => parseSettingsServerArgs(['--port', 'abc']), /zwischen 1 und 65535/);
    assert.throws(() => parseSettingsServerArgs(['--port=0']), /zwischen 1 und 65535/);
    assert.throws(() => parseSettingsServerArgs(['--port=65536']), /zwischen 1 und 65535/);
    assert.throws(() => parseSettingsServerArgs(['--public']), /Unbekannte Option/);
  });

  it('stellt eine Hilfe bereit, ohne die sicheren Defaults zu verändern', () => {
    assert.deepEqual(parseSettingsServerArgs(['--help']), {
      host: '127.0.0.1',
      port: 3876,
      help: true,
    });
    assert.match(SETTINGS_USAGE, /--host <Adresse>/);
    assert.match(SETTINGS_USAGE, /Default: 127\.0\.0\.1/);
    assert.match(SETTINGS_USAGE, /Firewall/);
  });

  it('bindet den Server an die explizit übergebene Adresse', async () => {
    const instance = startSettingsServer({
      host: '127.0.0.1',
      port: 0,
      cwd: tempDir(),
    });
    if (!instance.listening) {
      await new Promise((resolve, reject) => {
        instance.once('listening', resolve);
        instance.once('error', reject);
      });
    }

    try {
      const address = instance.address();
      assert.equal(address.address, '127.0.0.1');
      assert.ok(address.port > 0);
    } finally {
      await new Promise((resolve) => instance.close(resolve));
    }
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Settings server', () => {
  before(async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({
        source: 'file',
        icsPath: path.join(FIXTURES, 'beispiel.ics'),
        dbPath: path.join(cwd, 'state.db'),
      }),
      'utf8',
    );
    server = createSettingsServer({ cwd });
    const address = await listen(server);
    baseUrl = `http://${address.address}:${address.port}`;
  });

  it('liefert die HTML-Oberfläche', async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /chatendar Einstellungen/);
    assert.match(html, /Nachrichten-Vorschau/);
    assert.match(html, /Vorschau Wochenübersicht/);
    assert.match(html, /parameterDialog/);
    assert.match(html, /Person hinzufügen/);
    assert.match(html, /Parameterübersicht/);
    assert.match(html, /id="profileDialog"/);
    assert.match(html, /id="manageProfiles"/);
    assert.match(html, /Profile verwalten/);
    assert.match(html, /id="profileDialogClose"/);
    assert.match(html, /id="profileSummary"/);
    assert.match(html, /id="profileTabs"/);
    assert.match(html, /id="addProfile"/);
    assert.match(html, /id="copyProfile"/);
    assert.match(html, /id="deleteProfile"/);
    assert.match(html, /id="addGroup"/);
    assert.match(html, /id="loadWhatsAppGroups"/);
    assert.match(html, /id="importWhatsAppGroups"/);
    assert.match(html, /id="whatsappGroupPicker"/);
    assert.match(html, /id="whatsappGroupStatus"/);
    assert.match(html, /id="clearProfileState"/);
    assert.match(html, /id="profileStateStatus"/);
    assert.match(html, /function renderWhatsAppGroups\(/);
    assert.match(html, /function existingGroupIds\(/);
    assert.match(html, /\/api\/whatsapp\/groups/);
    assert.match(html, /npm run pair/);
    assert.match(html, /Erweitert: technische Profil-ID/);
    assert.match(html, /function uniqueProfileId\(/);
    assert.match(html, /function syncSelectedProfile\(\)/);
    assert.match(html, /function renderProfileSummary\(\)/);
    assert.match(html, /class="profile-switcher"/);
    assert.match(html, /id="profileSelect"/);
    assert.match(html, /function renderProfileSelect\(\)/);
    assert.doesNotMatch(html, /<section class="profile-panel">/);
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
    assert.doesNotMatch(html, /templatePreview/);
    assert.doesNotMatch(html, /Einzeltermin:\\\\n/);
    assert.doesNotMatch(html, /Platzhalter: \{/);
  });

  it('liefert Metadaten und effektive Werte', async () => {
    const { response, payload } = await request('/api/config');

    assert.equal(response.status, 200);
    assert.ok(payload.metadata.some((group) => group.name === 'Nachrichtentexte'));
    assert.equal(payload.values.source, 'file');
  });

  it('markiert whatsappGroupId als versteckte Legacy-Einstellung und blendet sie im Profilformular aus', async () => {
    const { response, payload } = await request('/api/config');
    const whatsappGroup = payload.metadata
      .find((group) => group.name === 'WhatsApp & Sicherheit')
      .settings.find((setting) => setting.key === 'whatsappGroupId');

    assert.equal(response.status, 200);
    assert.equal(whatsappGroup.hidden, true);

    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /if \(setting\.hidden\) continue;/);
  });

  it('liefert kategorisierte Platzhalter mit Hover-Beispielen', async () => {
    const { response, payload } = await request('/api/config');
    const messageGroup = payload.metadata.find((group) => group.name === 'Nachrichtentexte');
    const templateSingle = messageGroup.settings.find((setting) => setting.key === 'templateSingle');

    assert.equal(response.status, 200);
    assert.ok(templateSingle.placeholderGroups.some((group) => group.name === 'Relative Tage'));
    assert.ok(templateSingle.placeholderGroups.some((group) => group.name === 'Datum & Zeitraum'));
    const dateRangeGroup = templateSingle.placeholderGroups.find((group) => group.name === 'Datum & Zeitraum');
    const dateRange = dateRangeGroup.placeholders.find((placeholder) => placeholder.key === 'datumsbereich');
    assert.equal(dateRange.example, '20.09.2026–22.09.2026');
    assert.match(dateRange.description, /ohne relativen Tag/);
  });

  it('validiert ungültige Eingaben mit Fehlerstatus', async () => {
    const { response, payload } = await request('/api/validate', {
      values: { defaultReminders: 'irgendwann' },
    });

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /DEFAULT_REMINDERS/);
  });

  it('speichert gültige config.json-Werte', async () => {
    const { response, payload } = await request('/api/config', {
      values: { selectByCategory: false, selectByPrefix: false, templateSingle: 'Hallo {titel}' },
    });

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.values.selectByCategory, false);
  });

  it('speichert Profile mit gemischten WhatsApp-Zielen', async () => {
    const { response, payload } = await request('/api/config', {
      profiles: [
        {
          id: 'schule',
          name: 'Schule',
          enabled: true,
          values: {
            source: 'file',
            icsPath: path.join(FIXTURES, 'beispiel.ics'),
            defaultReminders: '1d',
          },
          whatsappTargets: [
            { type: 'group', id: '120363000000000001@g.us', name: 'Klasse 3', enabled: true },
            { type: 'person', phone: '+4915112345678', name: 'Ada', enabled: true },
          ],
        },
      ],
    });

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.profiles[0].id, 'schule');
    assert.equal(payload.profiles[0].whatsappTargets.length, 2);
    assert.equal(payload.profiles[0].whatsappTargets[1].phone, '+4915112345678');
  });

  it('speichert ein neues Dry-Run-Profil mit generierter ID und leerem Gruppenplatzhalter', async () => {
    const { response, payload } = await request('/api/config', {
      profiles: [{
        name: 'Schule & Ferien',
        enabled: true,
        values: {
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          dryRun: true,
        },
        whatsappGroups: [{ id: '', name: '', enabled: true }],
      }],
    });

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.profiles[0].id, 'schule-ferien');
    assert.equal(payload.profiles[0].name, 'Schule & Ferien');
    assert.deepEqual(payload.profiles[0].whatsappTargets, []);
  });

  it('lehnt unvollständige Profile mit einem Fehlerstatus ab', async () => {
    const { response, payload } = await request('/api/config', {
      profiles: [{
        id: 'schule',
        name: '',
        values: {},
        whatsappGroups: [{ id: '', name: 'Klasse 3' }],
      }],
    });

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /braucht einen Namen/);
    assert.match(payload.error, /braucht eine Gruppen-ID/);
  });

  it('maskiert sensible Profilwerte beim Speichern und erneuten Laden', async () => {
    const profile = {
      id: 'kalender',
      name: 'Privat',
      enabled: true,
      values: {
        source: 'caldav',
        'caldav.url': 'https://cloud.example.test/dav',
        'caldav.username': 'user@example.test',
        'caldav.password': 'nicht-ausgeben',
        'caldav.calendar': 'Privat',
      },
      whatsappGroups: [],
    };
    const saved = await request('/api/config', { profiles: [profile] });
    const loaded = await request('/api/config');

    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.profiles[0].values['caldav.password'], '********');
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.payload.profiles[0].values['caldav.username'], '********');
    assert.equal(loaded.payload.profiles[0].values['caldav.password'], '********');
  });

  it('speichert ein kopiertes CalDAV-Profil trotz maskierter Secret-Felder', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
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
          dryRun: true,
          whatsappGroups: [],
        }],
      }),
      'utf8',
    );
    const instance = createSettingsServer({ cwd });
    const address = await listen(instance);

    const response = await fetch(`http://${address.address}:${address.port}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profiles: [
          {
            id: 'privat',
            originalId: 'privat',
            name: 'Privat',
            enabled: true,
            values: {
              source: 'caldav',
              'caldav.url': '********',
              'caldav.username': '********',
              'caldav.password': '********',
              'caldav.calendar': 'Familie',
              dryRun: true,
            },
            whatsappGroups: [],
          },
          {
            id: 'privat-kopie',
            originalId: 'privat',
            name: 'Privat Kopie',
            enabled: true,
            values: {
              source: 'caldav',
              'caldav.url': '********',
              'caldav.username': '********',
              'caldav.password': '********',
              'caldav.calendar': 'Familie',
              dryRun: true,
            },
            whatsappGroups: [],
          },
        ],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.profiles[1].caldav.password, 'secret');
  });

  it('löscht State nur für das ausgewählte Profil', async () => {
    const cwd = tempDir();
    const dbPath = path.join(cwd, 'state.db');
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({ source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics'), dbPath }),
      'utf8',
    );
    const db = openDatabase(dbPath);
    const reminder = buildReminders({
      id: 'event-1',
      uid: 'event-1',
      titel: 'Test',
      start: new Date('2026-01-02T12:00:00Z'),
      ende: new Date('2026-01-02T13:00:00Z'),
      ort: '',
      kategorien: [],
      props: {},
      allDay: false,
    }, { defaultReminders: '1d', maxReminders: 1, reminderProperty: 'X-WA-REMIND' })[0];
    db.markProcessed(reminder, SENT_STATUS.SENT, new Date(), { profileId: 'schule', targetId: 'gruppe-a' });
    db.markProcessed(reminder, SENT_STATUS.SENT, new Date(), { profileId: 'verein', targetId: 'gruppe-a' });
    db.close();

    const instance = createSettingsServer({ cwd });
    const address = await listen(instance);
    const response = await fetch(`http://${address.address}:${address.port}/api/state/profile/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selectedProfile: 0,
        profiles: [{
          id: 'schule',
          name: 'Schule',
          enabled: true,
          values: { source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics'), dbPath },
          whatsappGroups: [],
        }],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    const verify = openDatabase(dbPath);
    assert.equal(response.status, 200);
    assert.equal(payload.deleted, 1);
    assert.equal(verify.isSent('event-1', reminder.offsetMinutes, { profileId: 'schule', targetId: 'gruppe-a' }), false);
    assert.equal(verify.isSent('event-1', reminder.offsetMinutes, { profileId: 'verein', targetId: 'gruppe-a' }), true);
    verify.close();
  });

  it('rendert Template-Vorschauen aus ungespeicherten Werten', async () => {
    const { response, payload } = await request('/api/templates/preview', {
      values: {
        templateSingle: 'Test: {titel}',
        icsPath: path.join(FIXTURES, 'beispiel.ics'),
      },
    });

    assert.equal(response.status, 200);
    assert.match(payload.preview.single, /Test: Elternabend Klasse 4b/);
    assert.match(payload.preview.collection, /Vereinssitzung/);
  });

  it('rendert Template-Vorschauen mit dem ausgewählten ungespeicherten Profil', async () => {
    const { response, payload } = await request('/api/templates/preview', {
      selectedProfile: 0,
      profiles: [{
        id: 'schule',
        name: 'Schule',
        enabled: true,
        values: {
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          templateSingle: 'Profil: {titel}',
        },
        whatsappGroups: [],
      }],
    });

    assert.equal(response.status, 200);
    assert.match(payload.preview.single, /Profil: Elternabend Klasse 4b/);
  });

  it('führt CLI-Preview mit dem ausgewählten ungespeicherten Profil aus', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({
        profiles: [{
          id: 'standard',
          name: 'Standard',
          source: 'file',
          icsPath: path.join(FIXTURES, 'edge-cases.ics'),
          dryRun: true,
          whatsappGroups: [],
        }],
      }),
      'utf8',
    );
    const instance = createSettingsServer({ cwd });
    const address = await listen(instance);

    const response = await fetch(`http://${address.address}:${address.port}/api/run/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        days: 5,
        now: '2026-09-19T12:00:00Z',
        selectedProfile: 1,
        profiles: [
          {
            id: 'standard',
            name: 'Standard',
            enabled: true,
            values: { source: 'file', icsPath: path.join(FIXTURES, 'edge-cases.ics'), dryRun: true },
            whatsappGroups: [],
          },
          {
            id: 'schule',
            name: 'Schule',
            enabled: true,
            values: { source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics'), dryRun: true },
            whatsappGroups: [],
          },
        ],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    assert.equal(response.status, 200);
    assert.equal(payload.code, 0);
    assert.match(payload.output, /Profil "Schule"/);
    assert.match(payload.output, /Elternabend Klasse 4b/);
    assert.doesNotMatch(payload.output, /Profil "Standard"/);
  });

  it('führt Dry-Run mit profilspezifischen ungespeicherten Nachrichtentemplates aus', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({
        profiles: [{
          id: 'standard',
          name: 'Standard',
          source: 'file',
          icsPath: path.join(FIXTURES, 'edge-cases.ics'),
          dryRun: true,
          whatsappGroups: [],
        }],
      }),
      'utf8',
    );
    const instance = createSettingsServer({ cwd });
    const address = await listen(instance);

    const response = await fetch(`http://${address.address}:${address.port}/api/run/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        now: '2026-09-19T17:00:00Z',
        selectedProfile: 0,
        profiles: [{
          id: 'schule',
          name: 'Schule',
          enabled: true,
          values: {
            source: 'file',
            icsPath: path.join(FIXTURES, 'beispiel.ics'),
            dryRun: true,
            templateCollection: 'PROFIL-SAMMLUNG {anzahl}\n{items}',
            templateCollectionItem: 'PROFIL-ITEM {titel}',
          },
          whatsappGroups: [],
        }],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    assert.equal(response.status, 200);
    assert.equal(payload.code, 0);
    assert.match(payload.output, /Profil "Schule"/);
    assert.match(payload.output, /PROFIL-SAMMLUNG/);
    assert.match(payload.output, /PROFIL-ITEM Elternabend Klasse 4b/);
  });

  it('liefert WhatsApp-Gruppen des ausgewählten Profils sortiert und ohne Doppelverbindung', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({ source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics') }),
      'utf8',
    );
    const calls = { created: 0, closed: 0, authDirs: [] };
    const instance = createSettingsServer({
      cwd,
      hasWhatsAppSession: () => true,
      createWhatsAppClient: async (config, options) => {
        calls.created += 1;
        calls.authDirs.push(config.authDir);
        calls.allowQr = options.allowQr;
        return {
          async listGroups() {
            return [
              { id: '120363000000000002@g.us', subject: 'Orga' },
              { id: '120363000000000001@g.us', subject: 'Klasse 3' },
            ];
          },
          async close() {
            calls.closed += 1;
          },
        };
      },
    });
    const address = await listen(instance);
    const url = `http://${address.address}:${address.port}/api/whatsapp/groups`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selectedProfile: 0,
        profiles: [{
          id: 'schule',
          name: 'Schule',
          enabled: true,
          values: {
            source: 'file',
            icsPath: path.join(FIXTURES, 'beispiel.ics'),
            authDir: path.join(cwd, 'auth_schule'),
          },
          whatsappGroups: [],
        }],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.groups, [
      { id: '120363000000000001@g.us', name: 'Klasse 3' },
      { id: '120363000000000002@g.us', name: 'Orga' },
    ]);
    assert.match(payload.message, /2 Gruppe/);
    assert.equal(calls.created, 1);
    assert.equal(calls.closed, 1);
    assert.equal(calls.allowQr, false);
    assert.equal(calls.authDirs[0], path.join(cwd, 'auth_schule'));
  });

  it('meldet eine fehlende WhatsApp-Session mit Hinweis auf npm run pair', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({ source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics') }),
      'utf8',
    );
    let created = 0;
    const instance = createSettingsServer({
      cwd,
      hasWhatsAppSession: () => false,
      createWhatsAppClient: async () => {
        created += 1;
        return { async listGroups() { return []; }, async close() {} };
      },
    });
    const address = await listen(instance);

    const response = await fetch(`http://${address.address}:${address.port}/api/whatsapp/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selectedProfile: 0,
        profiles: [{
          id: 'schule',
          name: 'Schule',
          enabled: true,
          values: { source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics') },
          whatsappGroups: [],
        }],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /npm run pair/);
    assert.equal(created, 0);
  });

  it('gibt Verbindungsfehler als JSON zurück und schließt den Client trotzdem', async () => {
    const cwd = tempDir();
    fs.writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({ source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics') }),
      'utf8',
    );
    let closed = 0;
    const instance = createSettingsServer({
      cwd,
      hasWhatsAppSession: () => true,
      createWhatsAppClient: async () => ({
        async listGroups() {
          throw new Error('Zeitüberschreitung beim Verbindungsaufbau nach 30s');
        },
        async close() {
          closed += 1;
        },
      }),
    });
    const address = await listen(instance);

    const response = await fetch(`http://${address.address}:${address.port}/api/whatsapp/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selectedProfile: 0,
        profiles: [{
          id: 'schule',
          name: 'Schule',
          enabled: true,
          values: { source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics') },
          whatsappGroups: [],
        }],
      }),
    });
    const payload = await response.json();
    await new Promise((resolve) => instance.close(resolve));

    assert.equal(response.status, 502);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Zeitüberschreitung/);
    assert.equal(closed, 1);
  });

  it('lehnt einen ungültigen Profilindex für den Gruppenimport ab', async () => {
    const { response, payload } = await request('/api/whatsapp/groups', {
      selectedProfile: 5,
      profiles: [{
        id: 'schule',
        name: 'Schule',
        enabled: true,
        values: { source: 'file', icsPath: path.join(FIXTURES, 'beispiel.ics') },
        whatsappGroups: [],
      }],
    });

    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Profil ist ungültig/);
  });
});
