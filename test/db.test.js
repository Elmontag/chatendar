import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { openDatabase, SENT_STATUS } from '../src/state/db.js';
import { buildReminders } from '../src/reminders/scheduler.js';
import { makeEvent, testConfig } from './helpers.js';

const config = testConfig();
const tempDirs = [];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-test-'));
  tempDirs.push(dir);
  return openDatabase(path.join(dir, 'state.db'));
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('State-Datenbank', () => {
  it('meldet unbekannte Kombinationen als nicht versendet', () => {
    const db = tempDb();
    assert.equal(db.isSent('event-1', 1440), false);
    db.close();
  });

  it('merkt sich versendete Erinnerungen', () => {
    const db = tempDb();
    const [reminder] = buildReminders(makeEvent({ id: 'event-1' }), config);

    db.markProcessed(reminder, SENT_STATUS.SENT);
    assert.equal(db.isSent('event-1', reminder.offsetMinutes), true);
    db.close();
  });

  it('unterscheidet die Vorlaufzeit-Stufen', () => {
    const db = tempDb();
    const [eineTag, zweiStunden] = buildReminders(makeEvent({ id: 'event-1' }), config);

    db.markProcessed(eineTag, SENT_STATUS.SENT);
    assert.equal(db.isSent('event-1', eineTag.offsetMinutes), true);
    assert.equal(db.isSent('event-1', zweiStunden.offsetMinutes), false);
    db.close();
  });

  it('trennt denselben Termin nach Profil und Zielgruppe', () => {
    const db = tempDb();
    const [reminder] = buildReminders(makeEvent({ id: 'event-1' }), config);

    db.markProcessed(reminder, SENT_STATUS.SENT, new Date(), { profileId: 'schule', targetId: 'gruppe-a' });

    assert.equal(db.isSent('event-1', reminder.offsetMinutes, { profileId: 'schule', targetId: 'gruppe-a' }), true);
    assert.equal(db.isSent('event-1', reminder.offsetMinutes, { profileId: 'schule', targetId: 'gruppe-b' }), false);
    assert.equal(db.isSent('event-1', reminder.offsetMinutes, { profileId: 'verein', targetId: 'gruppe-a' }), false);
    db.close();
  });

  it('löscht State gezielt für ein Profil', () => {
    const db = tempDb();
    const [reminder] = buildReminders(makeEvent({ id: 'event-1' }), config);

    db.markProcessed(reminder, SENT_STATUS.SENT, new Date(), { profileId: 'schule', targetId: 'gruppe-a' });
    db.markProcessed(reminder, SENT_STATUS.SENT, new Date(), { profileId: 'schule', targetId: 'gruppe-b' });
    db.markProcessed(reminder, SENT_STATUS.SENT, new Date(), { profileId: 'verein', targetId: 'gruppe-a' });

    assert.equal(db.clearProfile('schule'), 2);
    assert.equal(db.isSent('event-1', reminder.offsetMinutes, { profileId: 'schule', targetId: 'gruppe-a' }), false);
    assert.equal(db.isSent('event-1', reminder.offsetMinutes, { profileId: 'schule', targetId: 'gruppe-b' }), false);
    assert.equal(db.isSent('event-1', reminder.offsetMinutes, { profileId: 'verein', targetId: 'gruppe-a' }), true);
    db.close();
  });

  it('ist idempotent – doppeltes Vermerken wirft nicht', () => {
    const db = tempDb();
    const [reminder] = buildReminders(makeEvent(), config);

    db.markProcessed(reminder, SENT_STATUS.SENT);
    db.markProcessed(reminder, SENT_STATUS.SENT);
    assert.equal(db.count(), 1);
    db.close();
  });

  it('schreibt mehrere Einträge in einer Transaktion', () => {
    const db = tempDb();
    const reminders = [
      ...buildReminders(makeEvent({ id: 'a' }), config),
      ...buildReminders(makeEvent({ id: 'b' }), config),
    ];

    db.markManyProcessed(reminders, SENT_STATUS.SENT);
    assert.equal(db.count(), 4);
    db.close();
  });

  it('übersteht einen Neustart (Persistenz)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const [reminder] = buildReminders(makeEvent({ id: 'event-1' }), config);

    const erste = openDatabase(dbPath);
    erste.markProcessed(reminder, SENT_STATUS.SENT);
    erste.close();

    const zweite = openDatabase(dbPath);
    assert.equal(zweite.isSent('event-1', reminder.offsetMinutes), true);
    zweite.close();
  });

  it('migriert alte State-Datenbanken auf Profil- und Zielgruppen-Scope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sent_reminders (
        event_id TEXT NOT NULL,
        offset_minutes INTEGER NOT NULL,
        status TEXT NOT NULL,
        event_title TEXT,
        event_start TEXT,
        send_at TEXT,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (event_id, offset_minutes)
      );
      INSERT INTO sent_reminders
        (event_id, offset_minutes, status, event_title, event_start, send_at, processed_at)
      VALUES
        ('legacy-event', 1440, 'sent', 'Alt', '2026-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z', '2025-12-31T00:00:00.000Z');
    `);
    legacy.close();

    const db = openDatabase(dbPath);
    assert.equal(db.isSent('legacy-event', 1440), true);
    assert.equal(db.isSent('legacy-event', 1440, { profileId: 'anderes', targetId: 'default' }), false);
    db.close();
  });

  it('räumt alte Einträge auf', () => {
    const db = tempDb();
    const [reminder] = buildReminders(makeEvent(), config);
    const vorEinemJahr = new Date('2025-01-01T00:00:00Z');

    db.markProcessed(reminder, SENT_STATUS.SENT, vorEinemJahr);
    assert.equal(db.count(), 1);

    db.prune(30, new Date('2026-01-01T00:00:00Z'));
    assert.equal(db.count(), 0);
    db.close();
  });

  it('behält Einträge innerhalb der Aufbewahrungsfrist', () => {
    const db = tempDb();
    const [reminder] = buildReminders(makeEvent(), config);

    db.markProcessed(reminder, SENT_STATUS.SENT, new Date('2025-12-25T00:00:00Z'));
    db.prune(30, new Date('2026-01-01T00:00:00Z'));
    assert.equal(db.count(), 1);
    db.close();
  });
});
