import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  BACKUP_INTERVAL_MS,
  KEEPALIVE_RETRY_MS,
  backupRootFor,
  backupSession,
  isKeepaliveDue,
  listBackups,
  maintainSession,
  readSessionMeta,
  recordConnection,
  recordKeepaliveAttempt,
} from '../src/messaging/sessionMaintenance.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-20T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-maint-'));
  dirs.push(dir);
  return dir;
}

function makeSession() {
  const authDir = path.join(tempDir(), 'auth_session');
  fs.mkdirSync(authDir);
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{"noiseKey":{}}');
  fs.writeFileSync(path.join(authDir, 'session-1.0.json'), '{"a":1}');
  fs.writeFileSync(path.join(authDir, '.chatendar.lock'), '123\n');
  fs.writeFileSync(path.join(authDir, 'creds.json.99.tmp'), 'halb');
  fs.mkdirSync(path.join(authDir, 'unterordner'));
  return authDir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Session-Zustandsdatei', () => {
  it('liefert bei fehlender oder beschädigter Datei ein leeres Objekt', () => {
    const authDir = makeSession();
    assert.deepEqual(readSessionMeta(authDir), {});
    fs.writeFileSync(path.join(authDir, 'chatendar-session.json'), '{kaputt');
    assert.deepEqual(readSessionMeta(authDir), {});
    fs.writeFileSync(path.join(authDir, 'chatendar-session.json'), '[1,2]');
    assert.deepEqual(readSessionMeta(authDir), {});
  });

  it('speichert Verbindung und Keepalive-Versuch, ohne sich gegenseitig zu überschreiben', () => {
    const authDir = makeSession();
    recordConnection(authDir, NOW);
    recordKeepaliveAttempt(authDir, new Date(NOW.getTime() + 1000));

    const meta = readSessionMeta(authDir);
    assert.equal(meta.lastConnectedAt, NOW.toISOString());
    assert.equal(meta.lastKeepaliveAttemptAt, '2026-09-20T12:00:01.000Z');
    assert.equal(meta.version, 1);
    assert.deepEqual(fs.readdirSync(authDir).filter((name) => name.endsWith('.tmp') && name.startsWith('chatendar')), []);
  });
});

describe('Keepalive-Fälligkeit', () => {
  it('ist ohne bekannte Verbindung fällig', () => {
    assert.equal(isKeepaliveDue({}, NOW, 7), true);
  });

  it('ist nach keepaliveDays fällig, davor nicht', () => {
    assert.equal(isKeepaliveDue({ lastConnectedAt: ago(6 * DAY) }, NOW, 7), false);
    assert.equal(isKeepaliveDue({ lastConnectedAt: ago(7 * DAY) }, NOW, 7), true);
  });

  it('sperrt Wiederholungen nach einem Versuch für sechs Stunden', () => {
    const old = ago(30 * DAY);
    assert.equal(isKeepaliveDue({ lastConnectedAt: old, lastKeepaliveAttemptAt: ago(KEEPALIVE_RETRY_MS - 1000) }, NOW, 7), false);
    assert.equal(isKeepaliveDue({ lastConnectedAt: old, lastKeepaliveAttemptAt: ago(KEEPALIVE_RETRY_MS) }, NOW, 7), true);
  });

  it('ist bei 0 Tagen abgeschaltet', () => {
    assert.equal(isKeepaliveDue({}, NOW, 0), false);
  });

  it('ignoriert Zeitstempel aus der Zukunft und Unsinn', () => {
    const future = new Date(NOW.getTime() + DAY).toISOString();
    assert.equal(isKeepaliveDue({ lastConnectedAt: future }, NOW, 7), true);
    assert.equal(isKeepaliveDue({ lastConnectedAt: 'gestern', lastKeepaliveAttemptAt: 42 }, NOW, 7), true);
  });
});

describe('Session-Sicherung', () => {
  it('kopiert die Session ohne Lock-, Temp-Dateien und Unterordner und setzt sichere Rechte', () => {
    const authDir = makeSession();
    const backupDir = path.join(tempDir(), 'backups');

    const target = backupSession(authDir, { backupDir, keep: 7, now: NOW });

    assert.ok(target);
    assert.ok(target.startsWith(backupRootFor(authDir, backupDir)));
    assert.equal(path.basename(target), '20260920-120000');
    assert.deepEqual(fs.readdirSync(target).sort(), ['creds.json', 'session-1.0.json']);
    assert.equal(fs.readFileSync(path.join(target, 'session-1.0.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.statSync(path.join(target, 'creds.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(readSessionMeta(authDir).lastBackupAt, NOW.toISOString());
  });

  it('sichert höchstens einmal pro 24 Stunden, außer erzwungen', () => {
    const authDir = makeSession();
    const backupDir = path.join(tempDir(), 'backups');

    assert.ok(backupSession(authDir, { backupDir, keep: 7, now: NOW }));
    const later = new Date(NOW.getTime() + BACKUP_INTERVAL_MS - 1000);
    assert.equal(backupSession(authDir, { backupDir, keep: 7, now: later }), null);
    assert.ok(backupSession(authDir, { backupDir, keep: 7, now: later, force: true }));
    assert.ok(backupSession(authDir, { backupDir, keep: 7, now: new Date(NOW.getTime() + 2 * DAY) }));
    assert.equal(listBackups(backupRootFor(authDir, backupDir)).length, 3);
  });

  it('vergibt bei gleicher Sekunde eindeutige Namen', () => {
    const authDir = makeSession();
    const backupDir = path.join(tempDir(), 'backups');

    const first = backupSession(authDir, { backupDir, keep: 7, now: NOW, force: true });
    const second = backupSession(authDir, { backupDir, keep: 7, now: NOW, force: true });

    assert.notEqual(first, second);
    assert.equal(listBackups(backupRootFor(authDir, backupDir)).length, 2);
  });

  it('behält nur die neuesten und räumt angefangene Sicherungen weg', () => {
    const authDir = makeSession();
    const backupDir = path.join(tempDir(), 'backups');
    const root = backupRootFor(authDir, backupDir);
    fs.mkdirSync(path.join(root, '20260101-000000.partial'), { recursive: true });

    for (let day = 0; day < 4; day += 1) {
      backupSession(authDir, { backupDir, keep: 2, now: new Date(NOW.getTime() + day * 2 * DAY) });
    }

    assert.deepEqual(listBackups(root), ['20260926-120000', '20260924-120000']);
    assert.equal(fs.existsSync(path.join(root, '20260101-000000.partial')), false);
  });

  it('tut nichts, wenn deaktiviert oder keine Session vorhanden ist', () => {
    const authDir = makeSession();
    const backupDir = path.join(tempDir(), 'backups');

    assert.equal(backupSession(authDir, { backupDir, keep: 0, now: NOW }), null);
    assert.equal(backupSession(authDir, { keep: 7, now: NOW }), null);
    assert.equal(fs.existsSync(backupDir), false);

    fs.rmSync(path.join(authDir, 'creds.json'));
    assert.equal(backupSession(authDir, { backupDir, keep: 7, now: NOW }), null);
    assert.equal(fs.existsSync(backupDir), false);
  });

  it('trennt Sicherungen verschiedener Session-Ordner mit gleichem Namen', () => {
    const backupDir = path.join(tempDir(), 'backups');
    const one = makeSession();
    const two = makeSession();

    assert.notEqual(backupRootFor(one, backupDir), backupRootFor(two, backupDir));
  });

  it('maintainSession nutzt die Konfiguration und ist ohne Einstellung wirkungslos', () => {
    const authDir = makeSession();
    const backupDir = path.join(tempDir(), 'backups');

    assert.equal(maintainSession({ authDir }), null);
    assert.ok(maintainSession({ authDir, sessionBackupDir: backupDir, sessionBackupKeep: 3 }, { now: NOW }));
  });
});
