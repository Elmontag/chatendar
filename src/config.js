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

import {
  normalizePhoneNumber,
  targetJid,
  WHATSAPP_TARGET_TYPES,
} from './messaging/whatsappTarget.js';
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
  remindersEnabled: true,
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
    'Kurzer Reminder ({vorlauf} vorher): *{titel}*\n🗓 {tagesbereich_relativ}, {datumsbereich}{?termin_zeit} um {termin_zeit}{/termin_zeit}{?ort}\n📍 {ort}{/ort}\n\nKommt gut hin 🙂',
  templateCollection: 'Kurzer Reminder: {anzahl} Termine: {vorlauf} vorher\n\n{items}',
  templateCollectionItem:
    '• {tagesbereich_relativ}, {datumsbereich}{?termin_zeit} um {termin_zeit}{/termin_zeit}: *{titel}*{?ort}\n  📍 {ort}{/ort}',
  collectionSeparator: '\n\n',

  // Wochenübersicht
  digestEnabled: false,
  digestDay: 'fr',
  digestTime: '18:00',
  digestRange: '7d',
  digestSendWhenEmpty: false,
  templateDigest: 'Hier kommt der kurze Blick auf die Termine der kommenden Woche ({zeitraum}):\n\n{items}',
  templateDigestItem:
    '• {tagesbereich_relativ}, {datumsbereich}{?termin_zeit} um {termin_zeit}{/termin_zeit}: *{titel}*{?ort} (📍 {ort}){/ort}',
  templateDigestEmpty: 'Keine Termine für {zeitraum} im Kalender. Sieht entspannt aus 🙂',
  digestSeparator: '\n',

  // WhatsApp
  whatsappGroupId: '',
  whatsappPhone: '',
  authDir: './auth_session',
  dryRun: true,
  recordDryRun: false,
  antibanEnabled: true,
  connectTimeoutMs: 60000,
  sendDelayMs: 1500,
  sendDelayMaxMs: 7000,

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

function readConfigFile({ configFile, env, cwd }) {
  const filePath = configFile ?? env.CONFIG_FILE ?? path.resolve(cwd, 'config.json');
  let fileConfig = {};
  if (fs.existsSync(filePath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`config.json konnte nicht gelesen werden (${filePath}): ${error.message}`);
    }
  }
  return { filePath, fileConfig };
}

function normalizeGroup(group, fallbackName = '') {
  if (typeof group === 'string') {
    return { id: group, name: fallbackName || group, enabled: true };
  }
  return {
    id: String(group?.id ?? ''),
    name: String(group?.name ?? group?.id ?? fallbackName ?? ''),
    enabled: toBool(group?.enabled, true),
  };
}

function normalizeGroups(value, legacyGroupId) {
  const groups = Array.isArray(value)
    ? value
      .filter((group) => {
        if (typeof group === 'string') return group.trim() !== '';
        return String(group?.id ?? '').trim() !== '' || String(group?.name ?? '').trim() !== '';
      })
      .map((group, index) => normalizeGroup(group, `Gruppe ${index + 1}`))
    : [];
  if (groups.length > 0) return groups;
  return legacyGroupId ? [normalizeGroup({ id: legacyGroupId, name: 'WhatsApp-Gruppe' })] : [];
}

function normalizeTarget(target, fallbackName = '') {
  if (typeof target === 'string') {
    if (target.trim().endsWith('@g.us')) {
      return { type: WHATSAPP_TARGET_TYPES.GROUP, id: target, name: fallbackName || target, enabled: true };
    }
    return { type: WHATSAPP_TARGET_TYPES.PERSON, phone: target, name: fallbackName || target, enabled: true };
  }

  const type = target?.type ?? (
    target?.phone !== undefined ? WHATSAPP_TARGET_TYPES.PERSON : WHATSAPP_TARGET_TYPES.GROUP
  );
  const address = type === WHATSAPP_TARGET_TYPES.PERSON ? target?.phone : target?.id;
  return {
    type,
    ...(type === WHATSAPP_TARGET_TYPES.PERSON
      ? { phone: String(address ?? '').trim() }
      : { id: String(address ?? '').trim() }),
    name: String(target?.name ?? address ?? fallbackName ?? '').trim(),
    enabled: toBool(target?.enabled, true),
  };
}

function isEmptyTarget(target) {
  if (typeof target === 'string') return target.trim() === '';
  return (
    String(target?.id ?? '').trim() === '' &&
    String(target?.phone ?? '').trim() === '' &&
    String(target?.name ?? '').trim() === ''
  );
}

function normalizeTargets(value, legacyGroups, legacyPhone) {
  if (Array.isArray(value)) {
    return value
      .filter((target) => !isEmptyTarget(target))
      .map((target, index) => normalizeTarget(target, `Ziel ${index + 1}`));
  }

  const groups = legacyGroups.map((group) => ({
    type: WHATSAPP_TARGET_TYPES.GROUP,
    id: group.id,
    name: group.name,
    enabled: group.enabled,
  }));
  if (legacyPhone) {
    groups.push({
      type: WHATSAPP_TARGET_TYPES.PERSON,
      phone: String(legacyPhone),
      name: 'WhatsApp-Person',
      enabled: true,
    });
  }
  return groups;
}

function profileId(value, fallback = '') {
  const raw = String(value ?? '').trim();
  return raw || fallback;
}

function buildResolvedConfig(f, env, overrides, cwd, filePath) {
  const legacyGroupId = pick(overrides.whatsappGroupId, env.WHATSAPP_GROUP_ID, f.whatsappGroupId, '');
  const whatsappGroups = normalizeGroups(overrides.whatsappGroups ?? f.whatsappGroups, legacyGroupId);
  const whatsappPhone =
    pick(overrides.whatsappPhone, env.WHATSAPP_PHONE, f.whatsappPhone, DEFAULTS.whatsappPhone) ?? '';
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

    remindersEnabled: toBool(pick(env.REMINDERS_ENABLED, f.remindersEnabled), DEFAULTS.remindersEnabled),
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

    whatsappGroupId: legacyGroupId,
    whatsappPhone,
    whatsappGroups,
    whatsappTargets: normalizeTargets(overrides.whatsappTargets ?? f.whatsappTargets, whatsappGroups, whatsappPhone),
    authDir: pick(env.AUTH_DIR, f.authDir, DEFAULTS.authDir),
    dryRun: toBool(pick(env.DRY_RUN, f.dryRun), DEFAULTS.dryRun),
    recordDryRun: toBool(pick(env.RECORD_DRY_RUN, f.recordDryRun), DEFAULTS.recordDryRun),
    antibanEnabled: toBool(pick(env.ANTIBAN_ENABLED, f.antibanEnabled), DEFAULTS.antibanEnabled),
    connectTimeoutMs: toInt(pick(env.CONNECT_TIMEOUT_MS, f.connectTimeoutMs), DEFAULTS.connectTimeoutMs, 'CONNECT_TIMEOUT_MS'),
    sendDelayMs: toInt(pick(env.SEND_DELAY_MS, f.sendDelayMs), DEFAULTS.sendDelayMs, 'SEND_DELAY_MS'),
    sendDelayMaxMs: toInt(
      pick(env.SEND_DELAY_MAX_MS, f.sendDelayMaxMs),
      DEFAULTS.sendDelayMaxMs,
      'SEND_DELAY_MAX_MS',
    ),

    dbPath: pick(env.DB_PATH, f.dbPath, DEFAULTS.dbPath),
    pruneAfterDays: toInt(pick(env.PRUNE_AFTER_DAYS, f.pruneAfterDays), DEFAULTS.pruneAfterDays, 'PRUNE_AFTER_DAYS'),

    logLevel: pick(env.LOG_LEVEL, f.logLevel, DEFAULTS.logLevel),

    ...overrides,
  };

  resolved.whatsappGroups = resolved.whatsappTargets
    .filter((target) => target.type === WHATSAPP_TARGET_TYPES.GROUP)
    .map(({ id, name, enabled }) => ({ id, name, enabled }));
  if (!resolved.whatsappGroupId && resolved.whatsappGroups.length > 0) {
    resolved.whatsappGroupId = resolved.whatsappGroups.find((group) => group.enabled)?.id ?? resolved.whatsappGroups[0].id;
  }

  resolved.icsPath = path.resolve(cwd, resolved.icsPath);
  resolved.authDir = path.resolve(cwd, resolved.authDir);
  resolved.dbPath = path.resolve(cwd, resolved.dbPath);
  resolved.configFile = fs.existsSync(filePath) ? filePath : null;
  return resolved;
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

  const { filePath, fileConfig } = readConfigFile({ configFile, env, cwd });
  const resolved = buildResolvedConfig(fileConfig, env, overrides, cwd, filePath);

  validate(resolved);
  return resolved;
}

export function loadRuntimeConfig({ configFile, overrides = {}, env = process.env, cwd = process.cwd() } = {}) {
  dotenv.config({ path: path.resolve(cwd, '.env'), quiet: true });
  const { filePath, fileConfig } = readConfigFile({ configFile, env, cwd });
  const root = buildResolvedConfig(fileConfig, env, overrides, cwd, filePath);
  const explicitProfiles = Array.isArray(fileConfig.profiles) ? fileConfig.profiles : null;
  if (!explicitProfiles) validate(root);
  const profiles = explicitProfiles
    ? explicitProfiles.map((profile, index) => {
      const merged = buildResolvedConfig(profile, {}, overrides, cwd, filePath);
      merged.profileId = profileId(profile.id, `profile-${index + 1}`);
      merged.profileName = String(profile.name ?? merged.profileId);
      merged.enabled = toBool(profile.enabled, true);
      validate(merged);
      return merged;
    })
    : [{
      ...root,
      profileId: 'default',
      profileName: 'Standard',
      enabled: true,
    }];

  const runtime = {
    ...root,
    profiles,
    enabledProfiles: profiles.filter((profile) => profile.enabled),
  };
  validateRuntimeConfig(runtime);
  return runtime;
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
  if (config.source === 'caldav') {
    if (!config.caldav?.url) errors.push('CALDAV_URL muss gesetzt sein, wenn SOURCE=caldav');
    if (!config.caldav?.username) errors.push('CALDAV_USERNAME muss gesetzt sein, wenn SOURCE=caldav');
    if (!config.caldav?.password) errors.push('CALDAV_PASSWORD muss gesetzt sein, wenn SOURCE=caldav');
    if (!config.caldav?.calendar) errors.push('CALDAV_CALENDAR muss gesetzt sein, wenn SOURCE=caldav');
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

  const targetIds = new Set();
  for (const target of config.whatsappTargets ?? []) {
    let jid = '';
    if (target.type === WHATSAPP_TARGET_TYPES.GROUP) {
      target.id = String(target.id ?? '').trim();
      if (!target.id) {
        errors.push(`WhatsApp-Gruppe "${target.name || 'ohne Namen'}" braucht eine ID`);
        continue;
      }
      if (!target.id.endsWith('@g.us')) {
        errors.push(`WhatsApp-Gruppe "${target.name || target.id}" muss auf "@g.us" enden`);
        continue;
      }
      jid = target.id;
    } else if (target.type === WHATSAPP_TARGET_TYPES.PERSON) {
      try {
        target.phone = normalizePhoneNumber(target.phone);
        jid = targetJid(target);
      } catch (error) {
        errors.push(`WhatsApp-Person "${target.name || target.phone || 'ohne Namen'}": ${error.message}`);
        continue;
      }
    } else {
      errors.push(`Unbekannter WhatsApp-Zieltyp "${target.type}"`);
      continue;
    }
    if (targetIds.has(jid)) errors.push(`WhatsApp-Ziel "${jid}" ist doppelt`);
    targetIds.add(jid);
    target.jid = jid;
  }

  // Ziele sind nur im Echtbetrieb zwingend – Dry-Runs sollen ohne Kopplung laufen.
  if (!config.dryRun && config.enabled !== false) {
    const enabledTargets = (config.whatsappTargets ?? []).filter((target) => target.enabled);
    if (enabledTargets.length === 0) {
      errors.push('WHATSAPP_GROUP_ID oder WHATSAPP_PHONE muss gesetzt sein, wenn DRY_RUN=false');
    }
  }
  if (config.sendDelayMs < 0) errors.push('SEND_DELAY_MS darf nicht negativ sein');
  if (config.sendDelayMaxMs < config.sendDelayMs) {
    errors.push('SEND_DELAY_MAX_MS muss größer oder gleich SEND_DELAY_MS sein');
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

export function validateRuntimeConfig(runtime) {
  const errors = [];
  const ids = new Set();
  for (const profile of runtime.profiles ?? []) {
    if (!profile.profileId) {
      errors.push('Jedes Profil braucht eine id');
      continue;
    }
    if (ids.has(profile.profileId)) errors.push(`Profil-ID "${profile.profileId}" ist doppelt`);
    ids.add(profile.profileId);
    if (!/^[a-zA-Z0-9_.-]+$/.test(profile.profileId)) {
      errors.push(`Profil-ID "${profile.profileId}" darf nur Buchstaben, Zahlen, ".", "_" und "-" enthalten`);
    }
    const targetIds = new Set();
    for (const target of profile.whatsappTargets ?? []) {
      if (targetIds.has(target.jid)) {
        errors.push(`WhatsApp-Ziel "${target.jid}" ist in Profil "${profile.profileId}" doppelt`);
      }
      targetIds.add(target.jid);
    }
    const enabledTargets = (profile.whatsappTargets ?? []).filter((target) => target.enabled);
    if (profile.enabled && !profile.dryRun && enabledTargets.length === 0) {
      errors.push(`Profil "${profile.profileId}" braucht im Live-Modus mindestens ein aktives WhatsApp-Ziel`);
    }
  }
  if ((runtime.enabledProfiles ?? []).length === 0) {
    errors.push('Mindestens ein Profil muss aktiviert sein');
  }
  if (errors.length > 0) {
    throw new Error(`Konfigurationsfehler:\n  - ${errors.join('\n  - ')}`);
  }
  return runtime;
}

export { DEFAULTS };
