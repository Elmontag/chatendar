import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadRuntimeConfig } from '../config.js';
import { SETTINGS, SETTINGS_BY_KEY } from './metadata.js';

const SENSITIVE_MASK = '********';

function getNested(object, key) {
  return key.split('.').reduce((current, part) => current?.[part], object);
}

function setNested(object, key, value) {
  const parts = key.split('.');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function coerceForJson(setting, value) {
  if (value === SENSITIVE_MASK && setting.sensitive) return undefined;
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (setting.type === 'boolean') return Boolean(value);
  if (setting.type === 'number') {
    if (value === '') return '';
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return String(value);
}

export function configPath(cwd = process.cwd(), file = 'config.json') {
  return path.resolve(cwd, file);
}

export function readConfigJson(filePath = configPath()) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`config.json konnte nicht gelesen werden (${filePath}): ${error.message}`);
  }
}

export function valuesFromConfig(config, { includeSensitive = false } = {}) {
  const values = {};
  for (const setting of SETTINGS) {
    const value = getNested(config, setting.key);
    values[setting.key] = setting.sensitive && !includeSensitive && value ? SENSITIVE_MASK : value;
  }
  return values;
}

export function profilesFromRuntimeConfig(runtime, { includeSensitive = false } = {}) {
  return runtime.profiles.map((profile) => ({
    id: profile.profileId,
    originalId: profile.profileId,
    name: profile.profileName,
    enabled: profile.enabled,
    values: valuesFromConfig(profile, { includeSensitive }),
    whatsappGroups: (profile.whatsappGroups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      enabled: group.enabled,
    })),
  }));
}

export function buildConfigJson(values, existing = {}) {
  const next = structuredClone(existing);
  for (const [key, value] of Object.entries(values ?? {})) {
    const setting = SETTINGS_BY_KEY.get(key);
    if (!setting) continue;
    const coerced = coerceForJson(setting, value);
    if (coerced === undefined) continue;
    setNested(next, key, coerced);
  }
  return next;
}

export function writeConfigJson(values, { cwd = process.cwd(), filePath = configPath(cwd) } = {}) {
  const existing = readConfigJson(filePath);
  const next = buildConfigJson(values, existing);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function profileIdFromName(name, fallback = 'profile') {
  const normalized = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized || fallback;
}

function isEmptyGroup(group) {
  if (typeof group === 'string') return group.trim() === '';
  return String(group?.id ?? '').trim() === '' && String(group?.name ?? '').trim() === '';
}

export function buildProfilesConfigJson(profiles, existing = {}) {
  const existingProfiles = new Map((existing.profiles ?? []).map((profile) => [String(profile.id), profile]));
  return {
    ...existing,
    profiles: (profiles ?? []).map((profile, index) => {
      const suppliedId = String(profile.id ?? '').trim();
      const id = suppliedId || profileIdFromName(profile.name, `profile-${index + 1}`);
      const existingProfile = existingProfiles.get(id) ?? existingProfiles.get(String(profile.originalId ?? ''));
      const base = buildConfigJson(profile.values, existingProfile ?? {});
      // Profile sind das massgebliche Modell fuer whatsappGroups[]; ein redundantes/stale
      // top-level whatsappGroupId (Legacy-Kompatibilitaet) wird hier nicht mitgeschrieben.
      delete base.whatsappGroupId;
      return {
        ...base,
        id,
        name: String(profile.name ?? '').trim(),
        enabled: profile.enabled !== false,
        whatsappGroups: (profile.whatsappGroups ?? []).filter((group) => !isEmptyGroup(group)).map((group, groupIndex) => ({
          id: String(group.id ?? '').trim(),
          name: String(group.name ?? '').trim() || String(group.id ?? '').trim() || `Gruppe ${groupIndex + 1}`,
          enabled: group.enabled !== false,
        })),
      };
    }),
  };
}

export function writeProfilesConfigJson(profiles, { cwd = process.cwd(), filePath = configPath(cwd) } = {}) {
  const existing = readConfigJson(filePath);
  const next = buildProfilesConfigJson(profiles, existing);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function loadEffectiveConfig({ cwd = process.cwd(), configFile = configPath(cwd), overrides = {} } = {}) {
  return loadConfig({ cwd, configFile, overrides });
}

export function loadEffectiveRuntimeConfig({ cwd = process.cwd(), configFile = configPath(cwd), overrides = {} } = {}) {
  return loadRuntimeConfig({ cwd, configFile, overrides });
}

export function validateValues(values, { cwd = process.cwd(), filePath = configPath(cwd) } = {}) {
  const existing = readConfigJson(filePath);
  const candidate = buildConfigJson(values, existing);
  const tempDir = fs.mkdtempSync(path.join(path.dirname(filePath), '.chatendar-config-'));
  const tempFile = path.join(tempDir, 'config.json');
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    loadConfig({ cwd, configFile: tempFile, env: process.env });
    return { ok: true, config: candidate };
  } catch (error) {
    return { ok: false, error: error.message, config: candidate };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function validateProfiles(profiles, { cwd = process.cwd(), filePath = configPath(cwd) } = {}) {
  if (!Array.isArray(profiles)) {
    return { ok: false, error: 'PROFILEs müssen als Liste übergeben werden' };
  }
  const shapeErrors = [];
  for (const [index, profile] of profiles.entries()) {
    const label = `Profil ${index + 1}`;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      shapeErrors.push(`${label} ist ungültig`);
      continue;
    }
    if (!String(profile.name ?? '').trim()) shapeErrors.push(`${label} braucht einen Namen`);
    if (!profile.values || typeof profile.values !== 'object' || Array.isArray(profile.values)) {
      shapeErrors.push(`${label} braucht Einstellungswerte`);
    }
    if (!Array.isArray(profile.whatsappGroups)) {
      shapeErrors.push(`${label} braucht eine Liste von WhatsApp-Gruppen`);
      continue;
    }
    for (const [groupIndex, group] of profile.whatsappGroups.entries()) {
      const groupLabel = `WhatsApp-Gruppe ${groupIndex + 1} in ${label}`;
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        shapeErrors.push(`${groupLabel} ist ungültig`);
        continue;
      }
      if (isEmptyGroup(group)) continue;
      if (!String(group.id ?? '').trim()) shapeErrors.push(`${groupLabel} braucht eine ID`);
    }
  }
  if (shapeErrors.length > 0) {
    return { ok: false, error: `Konfigurationsfehler:\n  - ${shapeErrors.join('\n  - ')}` };
  }

  const existing = readConfigJson(filePath);
  const candidate = buildProfilesConfigJson(profiles, existing);
  const tempDir = fs.mkdtempSync(path.join(path.dirname(filePath), '.chatendar-config-'));
  const tempFile = path.join(tempDir, 'config.json');
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    loadRuntimeConfig({ cwd, configFile: tempFile, env: process.env });
    return { ok: true, config: candidate };
  } catch (error) {
    return { ok: false, error: error.message, config: candidate };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function sampleConfigValues() {
  return Object.fromEntries(SETTINGS.map((setting) => [setting.key, setting.default]));
}
