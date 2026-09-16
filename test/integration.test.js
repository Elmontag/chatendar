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
function lauf({ now = '2026-09-19T17:00:00Z', dbPath, env = {}, args = [] } = {}) {
  const ergebnis = spawnSync(
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
