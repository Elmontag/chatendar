/**
 * Pflege der WhatsApp-Session: Verbindungsprotokoll, Keepalive-Fälligkeit und
 * Sicherungskopien von AUTH_DIR.
 *
 * Alles hier arbeitet auf Dateien im Session-Ordner bzw. im Sicherungsordner und
 * setzt voraus, dass der Aufrufer die Session-Sperre hält (siehe acquireSessionLock).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../logger.js';

export const SESSION_META_FILE = 'chatendar-session.json';

/** Nach einem Keepalive-Versuch (auch fehlgeschlagen) mindestens so lange nicht erneut verbinden. */
export const KEEPALIVE_RETRY_MS = 6 * 60 * 60 * 1000;

/** Höchstens eine automatische Sicherung pro Zeitraum. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^\d{8}-\d{6}(?:-\d+)?$/;

function toTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/** Vergangene Zeit seit `value`, oder null wenn unbekannt bzw. in der Zukunft (Uhr falsch gestellt). */
function elapsedSince(value, now) {
  const time = toTime(value);
  if (time === null) return null;
  const elapsed = now.getTime() - time;
  return elapsed >= 0 ? elapsed : null;
}

/** Zustandsdatei lesen. Fehlt sie oder ist sie beschädigt, gilt sie als leer. */
export function readSessionMeta(authDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(authDir, SESSION_META_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Felder in die Zustandsdatei mergen (atomar, damit sie nie halb geschrieben vorliegt). */
export function updateSessionMeta(authDir, patch) {
  fs.mkdirSync(authDir, { recursive: true });
  const file = path.join(authDir, SESSION_META_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  const next = { ...readSessionMeta(authDir), version: 1, ...patch };
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return next;
}

export function recordConnection(authDir, now = new Date()) {
  return updateSessionMeta(authDir, { lastConnectedAt: now.toISOString() });
}

export function recordKeepaliveAttempt(authDir, now = new Date()) {
  return updateSessionMeta(authDir, { lastKeepaliveAttemptAt: now.toISOString() });
}

/**
 * Ist ein Keepalive fällig?
 * Ja, wenn die letzte Verbindung länger als `keepaliveDays` zurückliegt (oder unbekannt ist)
 * und der letzte Keepalive-Versuch nicht in den letzten KEEPALIVE_RETRY_MS lag.
 */
export function isKeepaliveDue(meta, now, keepaliveDays) {
  if (!(keepaliveDays > 0)) return false;

  const sinceAttempt = elapsedSince(meta.lastKeepaliveAttemptAt, now);
  if (sinceAttempt !== null && sinceAttempt < KEEPALIVE_RETRY_MS) return false;

  const sinceConnected = elapsedSince(meta.lastConnectedAt, now);
  return sinceConnected === null || sinceConnected >= keepaliveDays * DAY_MS;
}

/** Ordner, in dem die Sicherungen genau dieser Session liegen. */
export function backupRootFor(authDir, backupDir) {
  const hash = crypto.createHash('sha1').update(path.resolve(authDir)).digest('hex').slice(0, 8);
  return path.join(backupDir, `${path.basename(path.resolve(authDir))}-${hash}`);
}

function timestampName(now) {
  return now.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
}

/** Fertige Sicherungen, neueste zuerst. */
export function listBackups(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function pruneBackups(root, keep) {
  for (const name of listBackups(root).slice(keep)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  // Angefangene Sicherungen können nur von einem abgebrochenen früheren Lauf stammen.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.partial')) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Sicherungskopie von AUTH_DIR anlegen.
 *
 * Es wird erst in "<name>.partial" kopiert und dann umbenannt, damit eine
 * unterbrochene Sicherung nie als gültig zählt. Lock- und Temp-Dateien bleiben draußen.
 *
 * @returns {string|null} Pfad der neuen Sicherung; null, wenn deaktiviert, noch nicht fällig
 *                        oder keine Session vorhanden ist
 */
export function backupSession(authDir, { backupDir, keep, now = new Date(), force = false } = {}) {
  if (!backupDir || !(keep > 0)) return null;
  if (!fs.existsSync(path.join(authDir, 'creds.json'))) return null;

  if (!force) {
    const sinceBackup = elapsedSince(readSessionMeta(authDir).lastBackupAt, now);
    if (sinceBackup !== null && sinceBackup < BACKUP_INTERVAL_MS) return null;
  }

  const root = backupRootFor(authDir, backupDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const baseName = timestampName(now);
  let name = baseName;
  for (let counter = 1; fs.existsSync(path.join(root, name)); counter += 1) name = `${baseName}-${counter}`;

  const target = path.join(root, name);
  const partial = `${target}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { mode: 0o700 });

  for (const entry of fs.readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === '.chatendar.lock' || entry.name.endsWith('.tmp')) continue;
    const copy = path.join(partial, entry.name);
    fs.copyFileSync(path.join(authDir, entry.name), copy);
    fs.chmodSync(copy, 0o600);
  }
  fs.renameSync(partial, target);

  updateSessionMeta(authDir, { lastBackupAt: now.toISOString() });
  pruneBackups(root, keep);
  return target;
}

/** Nachbereitung nach dem Schließen der Verbindung: bei Bedarf Sicherung anlegen. */
export function maintainSession(config, { force = false, now = new Date() } = {}) {
  const target = backupSession(config.authDir, {
    backupDir: config.sessionBackupDir,
    keep: config.sessionBackupKeep,
    now,
    force,
  });
  if (target) log.info(`WhatsApp-Session gesichert: ${target}`);
  return target;
}
