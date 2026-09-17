/**
 * End-to-End-Test: kompletter Dry-Run-Durchlauf als eigener Prozess,
 * genau so, wie ihn später der systemd-Timer/Cronjob startet.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { FIXTURES, REPO_ROOT } from './helpers.js';

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function neuerStatePfad() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-e2e-'));
  tempDirs.push(dir);
  return path.join(dir, 'state.db');
}

function neueConfigDatei(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-config-e2e-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { dir, file };
}

/**
 * Leeres Arbeitsverzeichnis für die Testläufe.
 *
 * Wichtig: NICHT das Projektverzeichnis verwenden – sonst würde eine lokal
 * vorhandene .env/config.json in die Tests hineinwirken und sie je nach
 * Entwicklerrechner unterschiedlich ausfallen lassen.
 */
const SAUBERES_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-cwd-'));
tempDirs.push(SAUBERES_CWD);

/**
 * Einen Durchlauf starten und stdout UND stderr zurückgeben.
 * Warnungen landen auf stderr – die Tests sollen sie sehen.
 */
function starteLauf({ now = '2026-09-19T17:00:00Z', dbPath, env = {}, args = [] } = {}) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'src', 'index.js'), `--now=${now}`, '--dry-run', ...args],
    {
      cwd: SAUBERES_CWD,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ICS_PATH: path.join(FIXTURES, 'beispiel.ics'),
        SOURCE: 'file',
        TIMEZONE: 'Europe/Berlin',
        LOCALE: 'de-DE',
        DEFAULT_REMINDERS: '1d,2h',
        CHECK_WINDOW_MINUTES: '60',
        DB_PATH: dbPath ?? neuerStatePfad(),
        ...env,
      },
    },
  );
}

function lauf(options = {}) {
  const ergebnis = starteLauf(options);

  if (ergebnis.status !== 0) {
    throw new Error(`Lauf endete mit Code ${ergebnis.status}:\n${ergebnis.stderr}`);
  }
  return `${ergebnis.stdout}${ergebnis.stderr}`;
}

describe('Kompletter Dry-Run gegen beispiel.ics', () => {
  const ausgabe = lauf();

  it('läuft ohne Fehler durch und sendet nichts', () => {
    assert.match(ausgabe, /DRY-RUN \(es wird nichts gesendet\)/);
    assert.match(ausgabe, /Lauf beendet/);
  });

  it('selektiert nur markierte Termine', () => {
    assert.match(ausgabe, /6 Termin\(e\) für WhatsApp markiert/);
    assert.doesNotMatch(ausgabe, /Zahnarzt/);
  });

  it('bündelt zwei gleichzeitig fällige Termine zu einer Sammelnachricht', () => {
    assert.match(ausgabe, /2 Termine:/);
    assert.match(ausgabe, /Elternabend Klasse 4b/);
    assert.match(ausgabe, /Vereinssitzung/);
  });

  it('entfernt das Titel-Präfix aus der Nachricht', () => {
    assert.doesNotMatch(ausgabe, /\[WA\] Elternabend/);
  });

  it('nutzt für einen einzelnen Termin das Einzel-Template', () => {
    assert.match(ausgabe, /\(2 Stunden vorher\)/);
    assert.match(ausgabe, /Chorprobe/);
  });

  it('respektiert die Vorlaufzeit-Overrides aus dem ICS', () => {
    // Chorprobe hat X-WA-REMIND:2h und ist deshalb genau jetzt fällig.
    assert.match(ausgabe, /2 Sammelnachricht\(en\) aus 3 Erinnerung\(en\)/);
  });

  it('verändert den State im Dry-Run nicht', () => {
    assert.match(ausgabe, /State wurde NICHT verändert/);
  });
});

describe('Duplikatsvermeidung über mehrere Läufe', () => {
  it('sendet dieselbe Erinnerung kein zweites Mal', () => {
    const dbPath = neuerStatePfad();
    const ersterLauf = lauf({ dbPath, env: { RECORD_DRY_RUN: 'true' } });
    assert.match(ersterLauf, /3 Erinnerung\(en\) fällig/);

    const zweiterLauf = lauf({ dbPath, env: { RECORD_DRY_RUN: 'true' } });
    assert.match(zweiterLauf, /0 Erinnerung\(en\) fällig/);
    assert.match(zweiterLauf, /bereits-versendet: 3/);
    assert.match(zweiterLauf, /Nichts zu senden/);
  });
});

describe('Prüffenster', () => {
  it('holt Erinnerungen vor dem Fenster nicht nach', () => {
    const ausgabe = lauf({ now: '2026-09-19T23:00:00Z' });
    assert.match(ausgabe, /prueffenster-verpasst/);
    assert.match(ausgabe, /lagen vor dem Prüffenster \(60 min\)/);
    assert.match(ausgabe, /Dry-Run: State bleibt unverändert/);
    assert.match(ausgabe, /CATCH_UP=true/);
    assert.doesNotMatch(ausgabe, /Elternabend/);
  });

  it('holt sie mit CATCH_UP=true nach', () => {
    const ausgabe = lauf({ now: '2026-09-19T23:00:00Z', env: { CATCH_UP: 'true' } });
    assert.match(ausgabe, /Elternabend/);
  });
});

describe('Wochenübersicht', () => {
  const digestEnv = { DIGEST_ENABLED: 'true', DIGEST_DAY: 'fr', DIGEST_TIME: '18:00' };

  it('verschickt am Versandzeitpunkt eine Liste der kommenden Woche', () => {
    // Freitag, 18.09.2026, 18:00 Berlin
    const ausgabe = lauf({ now: '2026-09-18T16:00:00Z', env: digestEnv });

    assert.match(ausgabe, /Wochenübersicht fällig/);
    assert.match(ausgabe, /Termine der kommenden Woche/);
    assert.match(ausgabe, /Vereinssitzung/);
  });

  it('läuft nicht an einem anderen Wochentag', () => {
    const ausgabe = lauf({ now: '2026-09-16T16:00:00Z', env: digestEnv }); // Mittwoch
    assert.doesNotMatch(ausgabe, /Termine der kommenden Woche/);
  });

  it('verschickt sie pro Woche nur einmal', () => {
    const dbPath = neuerStatePfad();
    const env = { ...digestEnv, RECORD_DRY_RUN: 'true' };

    const ersterLauf = lauf({ now: '2026-09-18T16:00:00Z', dbPath, env });
    assert.match(ersterLauf, /Wochenübersicht fällig/);

    // Zweiter Lauf 10 Minuten später – die Übersicht darf nicht erneut raus.
    const zweiterLauf = lauf({ now: '2026-09-18T16:10:00Z', dbPath, env });
    assert.doesNotMatch(zweiterLauf, /Termine der kommenden Woche/);
  });

  it('beachtet DIGEST_RANGE=next-week', () => {
    const ausgabe = lauf({
      now: '2026-09-18T16:00:00Z',
      env: { ...digestEnv, DIGEST_RANGE: 'next-week' },
    });
    // Kalenderwoche ab Montag, 21.09. – die Vereinssitzung am 20.09. fällt raus.
    assert.match(ausgabe, /Wochenübersicht 21\.09\. – 27\.09\.2026/);
  });

  it('überspringt eine leere Übersicht', () => {
    const ausgabe = lauf({ now: '2026-11-20T17:00:00Z', env: digestEnv });
    assert.match(ausgabe, /keine Termine.*übersprungen|Nichts zu senden/s);
  });

  it('verschickt sie leer, wenn DIGEST_SEND_WHEN_EMPTY=true', () => {
    const ausgabe = lauf({
      now: '2026-11-20T17:00:00Z',
      env: { ...digestEnv, DIGEST_SEND_WHEN_EMPTY: 'true' },
    });
    assert.match(ausgabe, /Keine Termine/);
  });
});

describe('Vorschau-Modus', () => {
  it('zeigt geplante Erinnerungen, ohne zu senden', () => {
    const ausgabe = lauf({ now: '2026-09-16T21:00:00Z', args: ['--preview', '30'] });

    assert.match(ausgabe, /Vorschau: die nächsten 30 Tage/);
    assert.match(ausgabe, /Elternabend/);
    assert.match(ausgabe, /vorher →/);
    assert.match(ausgabe, /geplant/);
    assert.doesNotMatch(ausgabe, /DRY-RUN\] Nachricht/);
  });

  it('markiert eine gerade fällige Erinnerung', () => {
    const ausgabe = lauf({ now: '2026-09-19T17:00:00Z', args: ['--preview'] });
    assert.match(ausgabe, />>> JETZT fällig/);
  });

  it('nennt den nächsten Versand der Wochenübersicht', () => {
    const ausgabe = lauf({
      now: '2026-09-16T21:00:00Z',
      args: ['--preview'],
      env: { DIGEST_ENABLED: 'true', DIGEST_DAY: 'fr', DIGEST_TIME: '18:00' },
    });
    assert.match(ausgabe, /Wochenübersicht: nächster Versand 2026-09-18 18:00/);
  });

  it('weist darauf hin, wenn kein Termin markiert ist', () => {
    const ausgabe = lauf({
      now: '2026-09-16T21:00:00Z',
      args: ['--preview'],
      env: { SELECT_CATEGORY: 'GibtEsNicht', SELECT_PREFIX: '[XX]' },
    });
    assert.match(ausgabe, /keiner ist markiert/);
    assert.match(ausgabe, /nicht markiert: "Zahnarzt"/);
  });
});

describe('Selektion abschaltbar', () => {
  it('nimmt ohne Filter alle Termine, auch unmarkierte', () => {
    const ausgabe = lauf({
      now: '2026-09-20T07:15:00Z', // 1 Tag vor dem Zahnarzttermin
      env: { SELECT_BY_CATEGORY: 'false', SELECT_BY_PREFIX: 'false' },
    });

    assert.match(ausgabe, /Selektion ist deaktiviert – ALLE Termine/);
    assert.match(ausgabe, /Zahnarzt/);
  });
});

describe('Mehrere Profile und Gruppen', () => {
  it('sendet im Dry-Run dieselbe Profilnachricht an mehrere Gruppen', () => {
    const dbPath = neuerStatePfad();
    const { file } = neueConfigDatei({
      profiles: [
        {
          id: 'schule',
          name: 'Schule',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          dbPath,
          defaultReminders: '1d',
          templateSingle: 'Schule: {titel}',
          templateCollection: 'Schule: {anzahl} Termine\n{items}',
          templateCollectionItem: '- {titel}',
          whatsappGroups: [
            { id: '120363000000000001@g.us', name: 'Klasse 3' },
            { id: '120363000000000002@g.us', name: 'Orga' },
          ],
        },
      ],
    });

    const ausgabe = lauf({ now: '2026-09-19T17:00:00Z', args: ['--config', file] });

    assert.match(ausgabe, /Profil "Schule" gestartet/);
    assert.match(ausgabe, /Nachricht an Klasse 3 \(120363000000000001@g\.us\)/);
    assert.match(ausgabe, /Nachricht an Orga \(120363000000000002@g\.us\)/);
    assert.equal((ausgabe.match(/Schule: 2 Termine/g) ?? []).length, 2);
  });

  it('führt mehrere Profile mit eigenem Einstellungsstack aus', () => {
    const { file } = neueConfigDatei({
      profiles: [
        {
          id: 'schule',
          name: 'Schule',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          defaultReminders: '1d',
          templateSingle: 'Schulprofil: {titel}',
          templateCollection: 'Schulprofil: {anzahl}\n{items}',
          templateCollectionItem: '- {titel}',
          whatsappGroups: ['120363000000000001@g.us'],
        },
        {
          id: 'alle',
          name: 'Alle Termine',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          selectByCategory: false,
          selectByPrefix: false,
          defaultReminders: '1d',
          templateSingle: 'Alle: {titel}',
          templateCollection: 'Alle: {anzahl}\n{items}',
          templateCollectionItem: '- {titel}',
          whatsappGroups: ['120363000000000002@g.us'],
        },
      ],
    });

    const ausgabe = lauf({ now: '2026-09-19T17:00:00Z', args: ['--config', file] });

    assert.match(ausgabe, /Profil "Schule" gestartet/);
    assert.match(ausgabe, /Profil "Alle Termine" gestartet/);
    assert.match(ausgabe, /Schulprofil:/);
    assert.match(ausgabe, /Alle:/);
    assert.match(ausgabe, /Elternabend Klasse 4b/);
  });

  it('haelt Profile mit gemeinsamer State-Datenbank strikt auseinander', () => {
    const dbPath = neuerStatePfad();
    const { file } = neueConfigDatei({
      profiles: [
        {
          id: 'schule',
          name: 'Schule',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          dbPath,
          recordDryRun: true,
          defaultReminders: '1d',
          templateSingle: 'Schulprofil: {titel}',
          templateCollection: 'Schulprofil: {anzahl}\n{items}',
          templateCollectionItem: '- {titel}',
          whatsappGroups: ['120363000000000001@g.us'],
        },
        {
          id: 'alle',
          name: 'Alle Termine',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          dbPath,
          recordDryRun: true,
          selectByCategory: false,
          selectByPrefix: false,
          defaultReminders: '1d',
          templateSingle: 'Alleprofil: {titel}',
          templateCollection: 'Alleprofil: {anzahl}\n{items}',
          templateCollectionItem: '- {titel}',
          whatsappGroups: ['120363000000000002@g.us'],
        },
      ],
    });

    // Beide Profile teilen sich dieselbe State-Datenbank UND denselben
    // Kalender-Event ("Elternabend"), damit ein fehlender profile_id-Scope
    // sofort auffaellt: ohne Scope wuerde das zweite Profil die Erinnerung
    // faelschlich als "bereits versendet" ueberspringen.
    const ausgabe = lauf({ now: '2026-09-19T17:00:00Z', args: ['--config', file] });

    assert.match(ausgabe, /Schulprofil: 2[\s\S]*?- Elternabend Klasse 4b/);
    assert.match(ausgabe, /Alleprofil: 2[\s\S]*?- \[WA\] Elternabend Klasse 4b/);
    assert.doesNotMatch(ausgabe, /bereits-versendet/);

    // Zweiter Lauf mit derselben State-Datenbank: jetzt muss JEDES Profil
    // seine eigene Erinnerung als bereits versendet erkennen (kein
    // Cross-Profile-Leck in die andere Richtung).
    const zweiterLauf = lauf({ now: '2026-09-19T17:05:00Z', dbPath, args: ['--config', file] });
    assert.match(zweiterLauf, /Profil "Schule" gestartet[\s\S]*?bereits-versendet: 3/);
    assert.match(zweiterLauf, /Profil "Alle Termine" gestartet[\s\S]*?bereits-versendet: 3/);
  });

  it('führt nach einem fehlgeschlagenen Profil weitere Profile aus', () => {
    const { file } = neueConfigDatei({
      profiles: [
        {
          id: 'kaputt',
          name: 'Fehlerprofil',
          source: 'file',
          icsPath: path.join(FIXTURES, 'nicht-vorhanden.ics'),
        },
        {
          id: 'gesund',
          name: 'Gesundes Profil',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          defaultReminders: '1d',
          templateSingle: 'Gesund: {titel}',
          templateCollection: 'Gesund: {anzahl}\n{items}',
          templateCollectionItem: '- {titel}',
        },
      ],
    });

    const ergebnis = starteLauf({ args: ['--config', file] });
    const ausgabe = `${ergebnis.stdout}${ergebnis.stderr}`;

    assert.equal(ergebnis.status, 1);
    assert.match(ausgabe, /Profil "Fehlerprofil" gestartet/);
    assert.match(ausgabe, /Profil "Fehlerprofil" fehlgeschlagen:.*ICS-Datei nicht gefunden/);
    assert.match(ausgabe, /Profil "Gesundes Profil" gestartet/);
    assert.match(ausgabe, /Gesund: 2/);
  });

  it('sendet nur an aktivierte Gruppen, nicht an deaktivierte Gruppen', () => {
    const { file } = neueConfigDatei({
      profiles: [
        {
          id: 'schule',
          name: 'Schule',
          source: 'file',
          icsPath: path.join(FIXTURES, 'beispiel.ics'),
          defaultReminders: '1d',
          templateSingle: 'Schule: {titel}',
          templateCollection: 'Schule: {anzahl} Termine\n{items}',
          templateCollectionItem: '- {titel}',
          whatsappGroups: [
            { id: '120363000000000001@g.us', name: 'Klasse 3', enabled: true },
            { id: '120363000000000002@g.us', name: 'Orga', enabled: false },
          ],
        },
      ],
    });

    const ausgabe = lauf({ now: '2026-09-19T17:00:00Z', args: ['--config', file] });

    assert.match(ausgabe, /Profil "Schule" gestartet/);
    assert.match(ausgabe, /Nachricht an Klasse 3 \(120363000000000001@g\.us\)/);
    assert.doesNotMatch(ausgabe, /Nachricht an Orga \(120363000000000002@g\.us\)/);
    assert.equal((ausgabe.match(/Schule: 2 Termine/g) ?? []).length, 1);
  });
});

describe('Fehlerbehandlung', () => {
  it('bricht bei fehlender ICS-Datei mit Exit-Code 1 ab', () => {
    assert.throws(
      () => lauf({ env: { ICS_PATH: '/gibt/es/nicht.ics' } }),
      (error) => {
        assert.match(error.message, /endete mit Code 1/);
        assert.match(error.message, /ICS-Datei nicht gefunden/);
        return true;
      },
    );
  });

  it('bricht bei fehlender Gruppen-ID im Live-Modus ab', () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [path.join(REPO_ROOT, 'src', 'index.js'), '--live'], {
          cwd: SAUBERES_CWD,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DB_PATH: neuerStatePfad(), WHATSAPP_GROUP_ID: '' },
        }),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /WHATSAPP_GROUP_ID muss gesetzt sein/);
        return true;
      },
    );
  });

  it('meldet eine ungültige Gruppen-ID', () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [path.join(REPO_ROOT, 'src', 'index.js'), '--live'], {
          cwd: SAUBERES_CWD,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DB_PATH: neuerStatePfad(), WHATSAPP_GROUP_ID: '4915112345678@s.whatsapp.net' },
        }),
      (error) => {
        assert.match(error.stderr, /muss auf "@g\.us" enden/);
        return true;
      },
    );
  });
});
