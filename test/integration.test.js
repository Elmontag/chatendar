/**
 * End-to-End-Test: kompletter Dry-Run-Durchlauf als eigener Prozess,
 * genau so, wie ihn später der systemd-Timer/Cronjob startet.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

/** Einen Durchlauf starten und stdout+stderr zurückgeben. */
function lauf({ now = '2026-09-19T17:00:00Z', dbPath, env = {}, args = [] } = {}) {
  return execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'src', 'index.js'), `--now=${now}`, '--dry-run', ...args],
    {
      cwd: REPO_ROOT,
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

describe('Fehlerbehandlung', () => {
  it('bricht bei fehlender ICS-Datei mit Exit-Code 1 ab', () => {
    assert.throws(
      () => lauf({ env: { ICS_PATH: '/gibt/es/nicht.ics' } }),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /ICS-Datei nicht gefunden/);
        return true;
      },
    );
  });

  it('bricht bei fehlender Gruppen-ID im Live-Modus ab', () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [path.join(REPO_ROOT, 'src', 'index.js'), '--live'], {
          cwd: REPO_ROOT,
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
          cwd: REPO_ROOT,
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
