/**
 * Konfiguration.
 *
 * Auflösungsreihenfolge (später schlägt früher):
 *   1. eingebaute Defaults
 *   2. config.json (Pfad via --config oder CONFIG_FILE, sonst ./config.json falls vorhanden)
 *   3. Umgebungsvariablen aus .env bzw. dem Prozess-Environment
 *   4. CLI-Overrides (z. B. --dry-run)
 *
 * Alle Werte werden an genau einer Stelle geparst und validiert, damit der
 * restliche Code mit fertig typisierten Werten arbeiten kann.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { parseDurationToMinutes } from './reminders/duration.js';
import { parseTimeOfDay, parseWeekday } from './reminders/digest.js';

/** Eingebaute Defaults. */
const DEFAULTS = {
  // Kalenderquelle
  source: 'file',
  icsPath: './test/fixtures/beispiel.ics',
  caldav: { url: '', username: '', password: '', calendar: '' },
  lookaheadDays: 90,

  // Terminselektion
  selectByCategory: true,
  selectCategory: 'WhatsApp',
  selectByPrefix: true,
  selectPrefix: '[WA]',
  stripPrefix: true,

  // Vorlaufzeiten
  defaultReminders: '1d,2h',
  maxReminders: 2,
  reminderProperty: 'X-WA-REMIND',
  checkWindowMinutes: 60,
  catchUp: false,

  // Darstellung
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  locationFallback: '',

  // Templates (\n in .env wird zu echten Zeilenumbrüchen)
  templateSingle:
    '🔔 *Erinnerung* ({vorlauf} vorher)\n\n*{titel}*\n🗓 {datum}{?uhrzeit}, {uhrzeit} Uhr{/uhrzeit}{?ganztag} (ganztägig){/ganztag}{?ort}\n📍 {ort}{/ort}',
  templateCollection: '🔔 *Erinnerung* ({vorlauf} vorher) – {anzahl} Termine:\n\n{items}',
  templateCollectionItem:
    '• *{titel}*\n  🗓 {datum}{?uhrzeit}, {uhrzeit} Uhr{/uhrzeit}{?ganztag} (ganztägig){/ganztag}{?ort}\n  📍 {ort}{/ort}',
  collectionSeparator: '\n\n',

  // Wochenübersicht
  digestEnabled: false,
  digestDay: 'fr',
  digestTime: '18:00',
  digestRange: '7d',
  digestSendWhenEmpty: false,
  templateDigest: '🗓 *Termine der kommenden Woche* ({zeitraum})\n\n{items}',
  templateDigestItem:
    '• *{wochentag}, {datum_kurz}*{?uhrzeit} – {uhrzeit} Uhr{/uhrzeit}{?ganztag} – ganztägig{/ganztag}\n  {titel}{?ort} (📍 {ort}){/ort}',
  templateDigestEmpty: '🗓 *Termine der kommenden Woche* ({zeitraum})\n\nKeine Termine.',
  digestSeparator: '\n',

  // WhatsApp
  whatsappGroupId: '',
  authDir: './auth_session',
  dryRun: true,
  recordDryRun: false,
  connectTimeoutMs: 60000,
  sendDelayMs: 1500,

  // State
  dbPath: './data/reminders.db',
  pruneAfterDays: 365,

  // Sonstiges
  logLevel: 'info',
};

/** '.env'-Style-Strings in Boolean wandeln. */
function toBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'ja', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nein', 'off'].includes(normalized)) return false;
  throw new Error(`Ungültiger Boolean-Wert: "${value}"`);
}

function toInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new Error(`Ungültige Zahl für ${name}: "${value}"`);
  return parsed;
}

/** Literale "\n"/"\t" aus .env-Werten in echte Steuerzeichen wandeln. */
function unescape(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function pick(...candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
  }
  return undefined;
}

/**
 * Konfiguration laden.
 *
 * @param {object} [options]
 * @param {string} [options.configFile] Pfad zu einer config.json
 * @param {object} [options.overrides]  CLI-Overrides (bereits typisiert)
 * @param {object} [options.env]        Environment (Default: process.env)
 * @param {string} [options.cwd]        Basisverzeichnis für relative Pfade
 */
export function loadConfig({ configFile, overrides = {}, env = process.env, cwd = process.cwd() } = {}) {
  // .env einlesen, ohne bereits gesetzte Prozess-Variablen zu überschreiben.
  dotenv.config({ path: path.resolve(cwd, '.env'), quiet: true });

  const filePath = configFile ?? env.CONFIG_FILE ?? path.resolve(cwd, 'config.json');
  let fileConfig = {};
  if (fs.existsSync(filePath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`config.json konnte nicht gelesen werden (${filePath}): ${error.message}`);
    }
  }

  const f = fileConfig;
  const resolved = {
    source: String(pick(env.SOURCE, f.source, DEFAULTS.source)).toLowerCase(),
    icsPath: pick(env.ICS_PATH, f.icsPath, DEFAULTS.icsPath),
    caldav: {
      url: pick(env.CALDAV_URL, f.caldav?.url, DEFAULTS.caldav.url) ?? '',
      username: pick(env.CALDAV_USERNAME, f.caldav?.username, DEFAULTS.caldav.username) ?? '',
      password: pick(env.CALDAV_PASSWORD, f.caldav?.password, DEFAULTS.caldav.password) ?? '',
      calendar: pick(env.CALDAV_CALENDAR, f.caldav?.calendar, DEFAULTS.caldav.calendar) ?? '',
    },
    lookaheadDays: toInt(pick(env.LOOKAHEAD_DAYS, f.lookaheadDays), DEFAULTS.lookaheadDays, 'LOOKAHEAD_DAYS'),

    selectByCategory: toBool(pick(env.SELECT_BY_CATEGORY, f.selectByCategory), DEFAULTS.selectByCategory),
    selectCategory: pick(env.SELECT_CATEGORY, f.selectCategory, DEFAULTS.selectCategory),
    selectByPrefix: toBool(pick(env.SELECT_BY_PREFIX, f.selectByPrefix), DEFAULTS.selectByPrefix),
    selectPrefix: pick(env.SELECT_PREFIX, f.selectPrefix, DEFAULTS.selectPrefix),
    stripPrefix: toBool(pick(env.STRIP_PREFIX, f.stripPrefix), DEFAULTS.stripPrefix),

    defaultReminders: pick(env.DEFAULT_REMINDERS, f.defaultReminders, DEFAULTS.defaultReminders),
    maxReminders: toInt(pick(env.MAX_REMINDERS, f.maxReminders), DEFAULTS.maxReminders, 'MAX_REMINDERS'),
    reminderProperty: pick(env.REMINDER_PROPERTY, f.reminderProperty, DEFAULTS.reminderProperty),
    checkWindowMinutes: toInt(
      pick(env.CHECK_WINDOW_MINUTES, f.checkWindowMinutes),
      DEFAULTS.checkWindowMinutes,
      'CHECK_WINDOW_MINUTES',
    ),
    catchUp: toBool(pick(env.CATCH_UP, f.catchUp), DEFAULTS.catchUp),

    timezone: pick(env.TIMEZONE, f.timezone, DEFAULTS.timezone),
    locale: pick(env.LOCALE, f.locale, DEFAULTS.locale),
    locationFallback: unescape(pick(env.LOCATION_FALLBACK, f.locationFallback) ?? DEFAULTS.locationFallback),

    templateSingle: unescape(pick(env.TEMPLATE_SINGLE, f.templateSingle, DEFAULTS.templateSingle)),
    templateCollection: unescape(pick(env.TEMPLATE_COLLECTION, f.templateCollection, DEFAULTS.templateCollection)),
    templateCollectionItem: unescape(
      pick(env.TEMPLATE_COLLECTION_ITEM, f.templateCollectionItem, DEFAULTS.templateCollectionItem),
    ),
    collectionSeparator: unescape(
      pick(env.COLLECTION_SEPARATOR, f.collectionSeparator) ?? DEFAULTS.collectionSeparator,
    ),

    digestEnabled: toBool(pick(env.DIGEST_ENABLED, f.digestEnabled), DEFAULTS.digestEnabled),
    digestDay: pick(env.DIGEST_DAY, f.digestDay, DEFAULTS.digestDay),
    digestTime: pick(env.DIGEST_TIME, f.digestTime, DEFAULTS.digestTime),
    digestRange: pick(env.DIGEST_RANGE, f.digestRange, DEFAULTS.digestRange),
    digestSendWhenEmpty: toBool(pick(env.DIGEST_SEND_WHEN_EMPTY, f.digestSendWhenEmpty), DEFAULTS.digestSendWhenEmpty),
    templateDigest: unescape(pick(env.TEMPLATE_DIGEST, f.templateDigest, DEFAULTS.templateDigest)),
    templateDigestItem: unescape(pick(env.TEMPLATE_DIGEST_ITEM, f.templateDigestItem, DEFAULTS.templateDigestItem)),
    templateDigestEmpty: unescape(pick(env.TEMPLATE_DIGEST_EMPTY, f.templateDigestEmpty, DEFAULTS.templateDigestEmpty)),
    digestSeparator: unescape(pick(env.DIGEST_SEPARATOR, f.digestSeparator) ?? DEFAULTS.digestSeparator),

    whatsappGroupId: pick(env.WHATSAPP_GROUP_ID, f.whatsappGroupId, DEFAULTS.whatsappGroupId) ?? '',
    authDir: pick(env.AUTH_DIR, f.authDir, DEFAULTS.authDir),
    dryRun: toBool(pick(env.DRY_RUN, f.dryRun), DEFAULTS.dryRun),
    recordDryRun: toBool(pick(env.RECORD_DRY_RUN, f.recordDryRun), DEFAULTS.recordDryRun),
    connectTimeoutMs: toInt(pick(env.CONNECT_TIMEOUT_MS, f.connectTimeoutMs), DEFAULTS.connectTimeoutMs, 'CONNECT_TIMEOUT_MS'),
    sendDelayMs: toInt(pick(env.SEND_DELAY_MS, f.sendDelayMs), DEFAULTS.sendDelayMs, 'SEND_DELAY_MS'),

    dbPath: pick(env.DB_PATH, f.dbPath, DEFAULTS.dbPath),
    pruneAfterDays: toInt(pick(env.PRUNE_AFTER_DAYS, f.pruneAfterDays), DEFAULTS.pruneAfterDays, 'PRUNE_AFTER_DAYS'),

    logLevel: pick(env.LOG_LEVEL, f.logLevel, DEFAULTS.logLevel),

    ...overrides,
  };

  // Relative Pfade gegen das Arbeitsverzeichnis auflösen.
  resolved.icsPath = path.resolve(cwd, resolved.icsPath);
  resolved.authDir = path.resolve(cwd, resolved.authDir);
  resolved.dbPath = path.resolve(cwd, resolved.dbPath);
  resolved.configFile = fs.existsSync(filePath) ? filePath : null;

  validate(resolved);
  return resolved;
}

/** Konfiguration prüfen – lieber früh und laut scheitern als still falsch senden. */
export function validate(config) {
  const errors = [];

  if (!['file', 'caldav'].includes(config.source)) {
    errors.push(`SOURCE muss "file" oder "caldav" sein (ist: "${config.source}")`);
  }
  if (config.source === 'file' && !config.icsPath) {
    errors.push('ICS_PATH muss gesetzt sein, wenn SOURCE=file');
  }
  if (config.selectByCategory && !config.selectCategory) {
    errors.push('SELECT_CATEGORY muss gesetzt sein, wenn SELECT_BY_CATEGORY=true');
  }
  if (config.selectByPrefix && !config.selectPrefix) {
    errors.push('SELECT_PREFIX muss gesetzt sein, wenn SELECT_BY_PREFIX=true');
  }
  if (config.maxReminders < 1) {
    errors.push('MAX_REMINDERS muss mindestens 1 sein');
  }
  if (config.checkWindowMinutes < 1) {
    errors.push('CHECK_WINDOW_MINUTES muss mindestens 1 sein');
  }
  if (config.lookaheadDays < 1) {
    errors.push('LOOKAHEAD_DAYS muss mindestens 1 sein');
  }

  // Default-Vorlaufzeiten müssen parsebar sein.
  try {
    const parsed = String(config.defaultReminders)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parsed.length === 0) errors.push('DEFAULT_REMINDERS darf nicht leer sein');
    for (const part of parsed) parseDurationToMinutes(part);
  } catch (error) {
    errors.push(`DEFAULT_REMINDERS ist ungültig: ${error.message}`);
  }

  // Wochenübersicht: Tag, Uhrzeit und Zeitraum müssen parsebar sein.
  if (config.digestEnabled) {
    try {
      parseWeekday(config.digestDay);
    } catch (error) {
      errors.push(`DIGEST_DAY ist ungültig: ${error.message}`);
    }
    try {
      parseTimeOfDay(config.digestTime);
    } catch (error) {
      errors.push(`DIGEST_TIME ist ungültig: ${error.message}`);
    }
    const range = String(config.digestRange).trim().toLowerCase();
    if (range !== 'next-week' && range !== 'kalenderwoche') {
      try {
        parseDurationToMinutes(range);
      } catch (error) {
        errors.push(`DIGEST_RANGE ist ungültig: ${error.message} (oder "next-week")`);
      }
    }
  }

  // Gruppen-ID nur im Echtbetrieb zwingend – Dry-Runs sollen ohne Kopplung laufen.
  if (!config.dryRun) {
    if (!config.whatsappGroupId) {
      errors.push('WHATSAPP_GROUP_ID muss gesetzt sein, wenn DRY_RUN=false');
    } else if (!config.whatsappGroupId.endsWith('@g.us')) {
      errors.push(`WHATSAPP_GROUP_ID muss auf "@g.us" enden (ist: "${config.whatsappGroupId}")`);
    }
  }

  try {
    new Intl.DateTimeFormat(config.locale, { timeZone: config.timezone });
  } catch {
    errors.push(`TIMEZONE/LOCALE ungültig: "${config.timezone}" / "${config.locale}"`);
  }

  if (errors.length > 0) {
    throw new Error(`Konfigurationsfehler:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}

export { DEFAULTS };
