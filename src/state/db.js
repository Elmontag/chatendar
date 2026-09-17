/**
 * State-Persistenz (SQLite).
 *
 * Das Tool wird extern getriggert und läuft pro Aufruf genau einmal durch.
 * Damit eine Erinnerung nicht bei jedem Lauf erneut rausgeht, wird jede
 * Kombination aus (Termin-ID + Vorlaufzeit-Stufe) dauerhaft gespeichert.
 *
 * SQLite statt JSON, weil better-sqlite3 die Schreibzugriffe transaktional
 * absichert – falls sich zwei Läufe überschneiden, entsteht kein kaputter State.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { log } from '../logger.js';

/** Status-Werte in der Tabelle sent_reminders. */
export const SENT_STATUS = {
  SENT: 'sent',
  DRY_RUN: 'dry-run',
  MISSED: 'missed', // Prüffenster verpasst – zählt als erledigt, damit es nicht ewig nachhallt
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sent_reminders (
  profile_id     TEXT    NOT NULL DEFAULT 'default',
  target_id      TEXT    NOT NULL DEFAULT 'default',
  event_id       TEXT    NOT NULL,
  offset_minutes INTEGER NOT NULL,
  status         TEXT    NOT NULL,
  event_title    TEXT,
  event_start    TEXT,
  send_at        TEXT,
  processed_at   TEXT    NOT NULL,
  PRIMARY KEY (profile_id, target_id, event_id, offset_minutes)
);

CREATE INDEX IF NOT EXISTS idx_sent_reminders_processed_at
  ON sent_reminders (processed_at);
`;

function migrateSchema(db) {
  const columns = db.prepare('PRAGMA table_info(sent_reminders)').all().map((column) => column.name);
  if (columns.length === 0 || columns.includes('profile_id')) return;

  db.exec(`
    ALTER TABLE sent_reminders RENAME TO sent_reminders_legacy;
    CREATE TABLE sent_reminders (
      profile_id     TEXT    NOT NULL DEFAULT 'default',
      target_id      TEXT    NOT NULL DEFAULT 'default',
      event_id       TEXT    NOT NULL,
      offset_minutes INTEGER NOT NULL,
      status         TEXT    NOT NULL,
      event_title    TEXT,
      event_start    TEXT,
      send_at        TEXT,
      processed_at   TEXT    NOT NULL,
      PRIMARY KEY (profile_id, target_id, event_id, offset_minutes)
    );
    INSERT OR IGNORE INTO sent_reminders
      (profile_id, target_id, event_id, offset_minutes, status, event_title, event_start, send_at, processed_at)
    SELECT
      'default', 'default', event_id, offset_minutes, status, event_title, event_start, send_at, processed_at
    FROM sent_reminders_legacy;
    DROP TABLE sent_reminders_legacy;
  `);
}

function scopeOf(scope = {}) {
  return {
    profileId: String(scope.profileId ?? scope.profile_id ?? 'default'),
    targetId: String(scope.targetId ?? scope.target_id ?? 'default'),
  };
}

function entryScope(reminder, fallback) {
  return scopeOf({
    profileId: reminder.profileId ?? fallback.profileId,
    targetId: reminder.targetId ?? fallback.targetId,
  });
}

/**
 * Datenbank öffnen (und bei Bedarf anlegen).
 *
 * @param {string} dbPath
 * @returns {object} State-Handle
 */
export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db;
  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new Error(`SQLite-Datenbank konnte nicht geöffnet werden (${dbPath}): ${error.message}`);
  }

  // WAL + NORMAL: robust gegenüber parallelen Zugriffen, ohne jedes Mal zu fsyncen.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  migrateSchema(db);
  db.exec(SCHEMA);

  const statements = {
    isSent: db.prepare('SELECT 1 FROM sent_reminders WHERE profile_id = ? AND target_id = ? AND event_id = ? AND offset_minutes = ?'),
    insert: db.prepare(`
      INSERT INTO sent_reminders
        (profile_id, target_id, event_id, offset_minutes, status, event_title, event_start, send_at, processed_at)
      VALUES
        (@profile_id, @target_id, @event_id, @offset_minutes, @status, @event_title, @event_start, @send_at, @processed_at)
      ON CONFLICT(profile_id, target_id, event_id, offset_minutes) DO NOTHING
    `),
    prune: db.prepare('DELETE FROM sent_reminders WHERE processed_at < ?'),
    clearProfile: db.prepare('DELETE FROM sent_reminders WHERE profile_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS anzahl FROM sent_reminders'),
  };

  return {
    /**
     * Wurde diese (Termin + Vorlaufzeit)-Kombination bereits verarbeitet?
     * @param {string} eventId
     * @param {number} offsetMinutes
     */
    isSent(eventId, offsetMinutes, scope = {}) {
      const { profileId, targetId } = scopeOf(scope);
      return statements.isSent.get(profileId, targetId, eventId, offsetMinutes) !== undefined;
    },

    /**
     * Erinnerung als erledigt vermerken.
     * @param {object} reminder Eintrag aus evaluateReminders()
     * @param {string} status   siehe SENT_STATUS
     * @param {Date} [now]
     */
    markProcessed(reminder, status, now = new Date(), scope = {}) {
      const { profileId, targetId } = entryScope(reminder, scopeOf(scope));
      statements.insert.run({
        profile_id: profileId,
        target_id: targetId,
        event_id: reminder.eventId,
        offset_minutes: reminder.offsetMinutes,
        status,
        event_title: reminder.event?.titel ?? null,
        event_start: reminder.event?.start?.toISOString() ?? null,
        send_at: reminder.sendAt?.toISOString() ?? null,
        processed_at: now.toISOString(),
      });
    },

    /** Mehrere Erinnerungen in einer Transaktion vermerken. */
    markManyProcessed(reminders, status, now = new Date(), scope = {}) {
      const transaction = db.transaction((entries) => {
        for (const reminder of entries) this.markProcessed(reminder, status, now, scope);
      });
      transaction(reminders);
    },

    /**
     * Alte Einträge entfernen – der State muss nicht ewig wachsen.
     * @param {number} days
     */
    prune(days, now = new Date()) {
      if (!days || days <= 0) return 0;
      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
      const result = statements.prune.run(cutoff);
      if (result.changes > 0) {
        log.debug(`State aufgeräumt: ${result.changes} Eintrag/Einträge älter als ${days} Tage entfernt`);
      }
      return result.changes;
    },

    /** Anzahl gespeicherter Einträge (für das Lauf-Log). */
    count() {
      return statements.count.get().anzahl;
    },

    /** Alle State-Einträge eines Profils entfernen. */
    clearProfile(profileId = 'default') {
      return statements.clearProfile.run(String(profileId)).changes;
    },

    close() {
      db.close();
    },
  };
}

/**
 * In-Memory-Variante für Tests – gleiche Schnittstelle, keine Datei auf der Platte.
 */
export function openInMemoryDatabase() {
  return openDatabase(':memory:');
}
