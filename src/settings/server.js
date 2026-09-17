#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { groupReminders } from '../reminders/batching.js';
import { buildReminders } from '../reminders/scheduler.js';
import { buildDigestMessage, buildGroupMessage } from '../messaging/templateRenderer.js';
import { createWhatsAppClient, hasSession } from '../messaging/whatsappClient.js';
import { createEvent } from '../calendar/calendarSource.js';
import { openDatabase } from '../state/db.js';
import {
  configPath,
  loadEffectiveConfig,
  loadEffectiveRuntimeConfig,
  profilesFromRuntimeConfig,
  validateProfiles,
  validateValues,
  valuesFromConfig,
  writeConfigJson,
  writeProfilesConfigJson,
} from './configStore.js';
import { groupedSettings } from './metadata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body ist zu groß'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Ungültiges JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sampleEvents() {
  return [
    createEvent({
      id: 'sample-1',
      uid: 'sample-1',
      titel: 'Elternabend Klasse 4b',
      start: new Date('2026-09-20T16:30:00Z'),
      ende: new Date('2026-09-20T18:00:00Z'),
      ort: 'Aula der Grundschule',
      kategorien: ['WhatsApp'],
    }),
    createEvent({
      id: 'sample-2',
      uid: 'sample-2',
      titel: 'Vereinssitzung',
      start: new Date('2026-09-20T17:00:00Z'),
      ende: new Date('2026-09-20T18:30:00Z'),
      ort: 'Clubheim',
      kategorien: ['WhatsApp'],
    }),
  ];
}

function previewTemplates(config) {
  const events = sampleEvents();
  const reminders = events.flatMap((event) => buildReminders(event, config));
  const groups = groupReminders(reminders);
  const referenceDate = new Date('2026-09-19T12:00:00Z');
  const single = buildGroupMessage({ ...groups[0], reminders: [groups[0].reminders[0]] }, config, referenceDate);
  const collection = buildGroupMessage(groups[0], config, referenceDate);
  const digestRange = { from: events[0].start, to: new Date(events[0].start.getTime() + 7 * 24 * 60 * 60 * 1000) };
  const digest = buildDigestMessage(events, digestRange, config, referenceDate);
  const digestEmpty = buildDigestMessage([], digestRange, config, referenceDate);
  return { single, collection, digest, digestEmpty };
}

function runCommand(args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...args], {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

async function runSettingsCommand(body, baseArgs, { cwd }) {
  const args = [...baseArgs];
  if (body.now) args.push('--now', String(body.now));

  if (!body.profiles) {
    return runCommand(['--config', configPath(cwd), ...args], { cwd });
  }

  const validation = validateProfiles(body.profiles, { cwd });
  if (!validation.ok) {
    return { code: 1, signal: null, stdout: '', stderr: validation.error, output: validation.error };
  }
  const selectedProfile = Number.parseInt(String(body.selectedProfile), 10);
  const profileConfig = validation.config.profiles[selectedProfile];
  if (!Number.isInteger(selectedProfile) || !profileConfig) {
    const error = 'Ausgewähltes Profil ist ungültig';
    return { code: 1, signal: null, stdout: '', stderr: error, output: error };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-settings-run-'));
  const tempConfig = path.join(tempDir, 'config.json');
  try {
    fs.writeFileSync(
      tempConfig,
      `${JSON.stringify({ profiles: [{ ...profileConfig, enabled: true }] }, null, 2)}\n`,
      'utf8',
    );
    return await runCommand(['--config', tempConfig, ...args], { cwd });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Gruppen der gekoppelten WhatsApp-Session auslesen.
 *
 * Sendet nichts und schließt die Verbindung immer wieder – die Session bleibt erhalten.
 */
async function listWhatsAppGroups(config, { createClient, hasWhatsAppSession }) {
  if (!hasWhatsAppSession(config.authDir)) {
    return {
      status: 400,
      payload: {
        ok: false,
        error:
          'Keine WhatsApp-Session für dieses Profil gefunden. ' +
          'Bitte einmalig "npm run pair" im Terminal ausführen und den QR-Code scannen.',
      },
    };
  }

  let client = null;
  try {
    client = await createClient(config, { allowQr: false });
    const groups = await client.listGroups();
    const normalized = groups
      .map((group) => ({ id: group.id, name: group.subject ?? group.name ?? '' }))
      .filter((group) => Boolean(group.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return {
      status: 200,
      payload: {
        ok: true,
        groups: normalized,
        message:
          normalized.length === 0
            ? 'Die gekoppelte WhatsApp-Session ist in keiner Gruppe Mitglied.'
            : `${normalized.length} Gruppe(n) gefunden.`,
      },
    };
  } catch (error) {
    return { status: 502, payload: { ok: false, error: error.message } };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Verbindung war bereits geschlossen – nicht weiter tragisch.
      }
    }
  }
}

function page() {
  return String.raw`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>chatendar Einstellungen</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f1e8;
      --panel: #fffaf0;
      --ink: #263238;
      --muted: #65706f;
      --line: #eadfca;
      --brand: #2f6f5e;
      --brand-2: #f6b756;
      --danger: #b3261e;
      --shadow: 0 18px 45px rgba(67, 54, 32, .12);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(246, 183, 86, .35), transparent 30rem),
        linear-gradient(135deg, #f9f3e6 0%, #eef7f2 100%);
    }
    .shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
    aside {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 1.5rem;
      background: rgba(255, 250, 240, .78);
      backdrop-filter: blur(14px);
      border-right: 1px solid var(--line);
    }
    main { padding: 2rem; max-width: 1180px; width: 100%; }
    h1 { margin: 0; font-size: clamp(2rem, 5vw, 3.4rem); letter-spacing: -.05em; }
    h2 { margin-top: 2rem; }
    .subtitle { max-width: 65ch; color: var(--muted); line-height: 1.5; }
    .brand { display: grid; gap: .25rem; margin-bottom: 1.5rem; }
    .brand strong { font-size: 1.35rem; }
    .profile-switcher {
      display: grid;
      gap: .5rem;
      margin-bottom: 1.5rem;
      padding: .9rem;
      border: 1px solid var(--line);
      border-radius: 1rem;
      background: rgba(255, 250, 240, .9);
    }
    .profile-switcher label { font-size: .8rem; }
    .profile-switcher select { padding: .5rem .6rem; }
    .profile-switcher button { padding: .5rem .6rem; font-size: .85rem; }
    nav { display: grid; gap: .4rem; }
    nav a { color: var(--ink); text-decoration: none; padding: .55rem .7rem; border-radius: 999px; }
    nav a:hover { background: #e9f4ee; color: var(--brand); }
    .hero {
      border: 1px solid var(--line);
      border-radius: 1.5rem;
      padding: 1.5rem;
      background: rgba(255, 250, 240, .82);
      box-shadow: var(--shadow);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: .45rem;
      margin-top: 1rem;
      padding: .45rem .75rem;
      border-radius: 999px;
      background: #eef7f2;
      color: var(--brand);
      font-weight: 700;
    }
    .profile-summary-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: .75rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--line);
    }
    .profile-summary-bar button { width: auto; }
    fieldset {
      border: 1px solid var(--line);
      border-radius: 1.25rem;
      margin: 1.25rem 0;
      padding: 1.1rem;
      background: rgba(255, 250, 240, .9);
      box-shadow: 0 10px 25px rgba(67, 54, 32, .08);
    }
    .profile-dialog-body { display: grid; gap: 1rem; }
    .profile-actions, .group-list {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
      margin-top: .75rem;
    }
    .profile-actions button, .group-list button {
      width: auto;
      padding: .45rem .7rem;
      box-shadow: none;
    }
    .group-card {
      display: grid;
      grid-template-columns: 1.4rem minmax(7rem, .6fr) minmax(10rem, 1fr) minmax(14rem, 1.2fr) auto;
      gap: .45rem;
      align-items: center;
      width: 100%;
      padding: .55rem;
      border: 1px solid #efe3ce;
      border-radius: .9rem;
      background: #fffdf8;
    }
    .whatsapp-import { display: grid; gap: .5rem; margin-top: 1.25rem; }
    .whatsapp-import h4 { margin: 0; color: var(--brand); }
    .whatsapp-group-card {
      grid-template-columns: 1.4rem minmax(10rem, 1fr) minmax(12rem, 1.2fr) auto;
    }
    legend { padding: 0 .5rem; font-weight: 800; font-size: 1.15rem; color: var(--brand); }
    label { display: grid; gap: .35rem; margin: 0; font-weight: 700; }
    input, select, textarea, button {
      width: 100%;
      border: 1px solid #d8cbb6;
      border-radius: .85rem;
      font: inherit;
      padding: .7rem .85rem;
      background: #fffdf8;
      color: var(--ink);
    }
    input[type="checkbox"] { width: 1.25rem; height: 1.25rem; accent-color: var(--brand); }
    .boolean { grid-template-columns: 1.25rem minmax(0, 1fr); align-items: center; }
    .boolean .label-text { grid-column: 2; grid-row: 1; }
    .boolean input { grid-column: 1; grid-row: 1; }
    .boolean .help { grid-column: 1 / -1; }
    textarea { min-height: 9rem; line-height: 1.45; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 1rem; }
    .template { grid-column: 1 / -1; }
    .help { color: var(--muted); font-size: .88rem; font-weight: 500; line-height: 1.35; }
    .template-tools {
      display: flex;
      justify-content: flex-end;
      margin-top: .2rem;
    }
    .parameter-button {
      width: auto;
      padding: .45rem .7rem;
      border: 1px solid #c7dfd3;
      background: #eef7f2;
      color: var(--brand);
      box-shadow: none;
      font-size: .88rem;
    }
    dialog {
      width: min(900px, calc(100vw - 2rem));
      max-height: min(760px, calc(100vh - 2rem));
      border: 1px solid var(--line);
      border-radius: 1.35rem;
      padding: 0;
      background: #fffaf0;
      color: var(--ink);
      box-shadow: 0 30px 80px rgba(31, 41, 39, .28);
    }
    dialog::backdrop { background: rgba(31, 41, 39, .42); backdrop-filter: blur(4px); }
    .parameter-dialog-inner { display: grid; max-height: inherit; }
    .parameter-dialog-header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 1rem;
      padding: 1rem 1.1rem;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 250, 240, .95);
      backdrop-filter: blur(10px);
    }
    .parameter-dialog-header h2 { margin: 0 0 .2rem; }
    .parameter-dialog-close {
      width: auto;
      min-width: 2.4rem;
      padding: .45rem .65rem;
      background: #e9f4ee;
      color: var(--brand);
    }
    .parameter-dialog-body {
      display: grid;
      gap: 1rem;
      padding: 1rem 1.1rem 1.2rem;
      overflow: auto;
    }
    .placeholder-help { display: grid; gap: .85rem; }
    .placeholder-group { display: grid; gap: .45rem; }
    .placeholder-group-title {
      color: var(--muted);
      font-size: .78rem;
      font-weight: 800;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .placeholder-chips {
      display: flex;
      flex-wrap: wrap;
      gap: .35rem;
    }
    .placeholder-chip {
      position: relative;
      display: inline-flex;
      width: auto;
      padding: .25rem .5rem;
      border: 1px solid #c7dfd3;
      border-radius: 999px;
      background: #eef7f2;
      color: var(--brand);
      font: 700 .82rem ui-monospace, SFMono-Regular, Consolas, monospace;
      cursor: help;
    }
    .placeholder-chip::after {
      content: attr(data-tooltip);
      position: absolute;
      left: 50%;
      bottom: calc(100% + .55rem);
      transform: translateX(-50%);
      z-index: 5;
      width: max-content;
      max-width: min(24rem, 80vw);
      padding: .55rem .65rem;
      border-radius: .7rem;
      background: #1f2927;
      color: #f5f1e8;
      font: 600 .82rem Inter, ui-sans-serif, system-ui, sans-serif;
      line-height: 1.35;
      white-space: normal;
      box-shadow: 0 10px 25px rgba(31, 41, 39, .22);
      opacity: 0;
      pointer-events: none;
      transition: opacity .12s ease, transform .12s ease;
    }
    .placeholder-chip:hover::after,
    .placeholder-chip:focus-visible::after {
      opacity: 1;
      transform: translateX(-50%) translateY(-.15rem);
    }
    .category-preview {
      grid-column: 1 / -1;
      margin-top: 1rem;
      padding: 1rem;
      border: 1px solid #d8eadf;
      border-radius: 1.15rem;
      background: linear-gradient(135deg, #eef7f2, #fffaf0);
    }
    .category-preview header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: .85rem;
    }
    .category-preview h3 { margin: 0 0 .2rem; color: var(--brand); }
    .preview-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: .45rem;
    }
    .preview-tabs button {
      width: auto;
      padding: .45rem .7rem;
      border: 1px solid #c7dfd3;
      background: #fffdf8;
      color: var(--brand);
      box-shadow: none;
    }
    .preview-tabs button.active {
      border-color: var(--brand);
      background: var(--brand);
      color: white;
    }
    .phone-preview {
      max-width: 580px;
      padding: 1rem;
      border-radius: 1.15rem;
      background:
        radial-gradient(circle at 20% 20%, rgba(47, 111, 94, .08), transparent 16rem),
        #e4f1ea;
      border: 1px solid #c7dfd3;
    }
    .message-bubble {
      position: relative;
      width: fit-content;
      max-width: 100%;
      margin-left: auto;
      padding: .8rem .95rem;
      border-radius: 1rem 1rem .25rem 1rem;
      background: #d9fdd3;
      color: #18342c;
      white-space: pre-wrap;
      line-height: 1.45;
      box-shadow: 0 8px 18px rgba(31, 41, 39, .12);
    }
    .message-bubble.error {
      margin-left: 0;
      background: #fff1ed;
      color: var(--danger);
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: .6rem;
      position: sticky;
      bottom: 1rem;
      z-index: 2;
      margin: 1.25rem 0;
      padding: .75rem;
      border: 1px solid var(--line);
      border-radius: 1.2rem;
      background: rgba(255, 250, 240, .92);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    button { cursor: pointer; border: 0; background: var(--brand); color: white; font-weight: 800; }
    button.secondary { background: #e9f4ee; color: var(--brand); }
    button.warm { background: var(--brand-2); color: #3a2a09; }
    .panels { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    pre {
      white-space: pre-wrap;
      min-height: 14rem;
      border: 1px solid var(--line);
      border-radius: 1.2rem;
      padding: 1rem;
      overflow: auto;
      background: #1f2927;
      color: #f5f1e8;
      box-shadow: var(--shadow);
    }
    .ok { color: var(--brand); }
    .error { color: var(--danger); }
    @media (max-width: 850px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; height: auto; }
      .panels { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <strong>chatendar</strong>
        <span class="help">Kalender → WhatsApp, entspannt konfiguriert.</span>
      </div>
      <div class="profile-switcher">
        <label for="profileSelect"><span class="label-text">Aktives Profil</span></label>
        <select id="profileSelect"></select>
      </div>
      <nav id="nav"></nav>
    </aside>
    <main>
      <section class="hero">
        <h1>Einstellungen</h1>
        <p class="subtitle">Speichert normale Werte in <code>config.json</code>. <code>.env</code> bleibt für lokale Secrets und überschreibt bewusst die JSON-Konfiguration.</p>
        <span id="status" class="status">wird geladen …</span>
        <div class="profile-summary-bar">
          <span id="profileSummary" class="help"></span>
          <button id="manageProfiles" class="secondary" type="button">Profile verwalten</button>
        </div>
      </section>
      <form id="settings"></form>
      <dialog id="profileDialog" aria-labelledby="profileDialogTitle">
        <div class="parameter-dialog-inner">
          <header class="parameter-dialog-header">
            <div>
              <h2 id="profileDialogTitle">Kalenderprofile verwalten</h2>
              <p class="help">Jedes Profil hat einen eigenen Einstellungsstack. Alle aktivierten Gruppen und Personen im Profil erhalten dieselbe Nachricht. Änderungen wirken sich erst nach „Speichern“ auf <code>config.json</code> aus.</p>
            </div>
            <button id="profileDialogClose" class="parameter-dialog-close" type="button" aria-label="Profilverwaltung schließen">×</button>
          </header>
          <div class="parameter-dialog-body">
            <div id="profileTabs" class="profile-tabs"></div>
            <div class="profile-actions">
              <button id="addProfile" class="secondary" type="button">Profil hinzufügen</button>
              <button id="copyProfile" class="secondary" type="button">Profil kopieren</button>
              <button id="deleteProfile" class="secondary" type="button">Profil löschen</button>
            </div>
            <div class="grid" style="margin-top:1rem">
              <label><span class="label-text">Profilname</span><input id="profileName" type="text"></label>
              <label class="boolean"><span class="label-text">Profil aktiv</span><input id="profileEnabled" type="checkbox"></label>
              <details>
                <summary>Erweitert: technische Profil-ID</summary>
                <label><span class="label-text">Profil-ID</span><input id="profileId" type="text"></label>
              </details>
            </div>
            <h3>WhatsApp-Ziele</h3>
            <div id="groupList" class="group-list"></div>
            <div class="profile-actions">
              <button id="addGroup" class="secondary" type="button">Gruppe hinzufügen</button>
              <button id="addPerson" class="secondary" type="button">Person hinzufügen</button>
            </div>
            <div class="whatsapp-import">
              <h4>Gruppen aus WhatsApp übernehmen</h4>
              <p class="help">Liest die Gruppen der gekoppelten WhatsApp-Session dieses Profils (Ordner aus <code>AUTH_DIR</code>). Es werden keine Nachrichten gesendet. Das Koppeln selbst läuft weiterhin über <code>npm run pair</code> im Terminal.</p>
              <div class="profile-actions">
                <button id="loadWhatsAppGroups" class="secondary" type="button">WhatsApp-Gruppen laden</button>
                <button id="importWhatsAppGroups" class="secondary" type="button">Ausgewählte übernehmen</button>
              </div>
              <span id="whatsappGroupStatus" class="help"></span>
              <div id="whatsappGroupPicker" class="group-list"></div>
            </div>
            <div class="whatsapp-import">
              <h4>State dieses Profils</h4>
              <p class="help">Löscht nur die gespeicherten Versandmarker des aktuell ausgewählten Profils. Sinnvoll nach Testläufen oder beim Wechsel von Test- auf Produktivgruppen. Kalenderdaten und Einstellungen bleiben unverändert.</p>
              <button id="clearProfileState" class="secondary" type="button">State dieses Profils leeren</button>
              <span id="profileStateStatus" class="help"></span>
            </div>
          </div>
        </div>
      </dialog>
      <dialog id="parameterDialog">
        <div class="parameter-dialog-inner">
          <header class="parameter-dialog-header">
            <div>
              <h2 id="parameterDialogTitle">Parameterübersicht</h2>
              <p id="parameterDialogHelp" class="help"></p>
            </div>
            <button id="parameterDialogClose" class="parameter-dialog-close" type="button" aria-label="Parameterübersicht schließen">×</button>
          </header>
          <div id="parameterDialogBody" class="parameter-dialog-body"></div>
        </div>
      </dialog>
      <div class="actions">
        <button id="save" type="button">Speichern</button>
        <button id="validate" class="secondary" type="button">Validieren</button>
        <button id="preview" class="warm" type="button">CLI-Preview</button>
        <button id="dryrun" class="warm" type="button">Dry-Run</button>
        <button id="reload" class="secondary" type="button">Neu laden</button>
      </div>
      <div class="panels">
        <section>
          <h2>Ausgabe</h2>
          <pre id="output"></pre>
        </section>
      </div>
      <section class="hero">
        <h2>WhatsApp-Pairing</h2>
        <p>Zum Koppeln und zum Ermitteln der Gruppen-ID im Terminal ausführen: <code>npm run pair</code>.</p>
      </section>
    </main>
  </div>
  <script>
    let metadata = [];
    let values = {};
    let profiles = [];
    let selectedProfile = 0;
    const form = document.querySelector('#settings');
    const nav = document.querySelector('#nav');
    const profileSelect = document.querySelector('#profileSelect');
    const profileTabs = document.querySelector('#profileTabs');
    const groupList = document.querySelector('#groupList');
    const profileId = document.querySelector('#profileId');
    const profileName = document.querySelector('#profileName');
    const profileEnabled = document.querySelector('#profileEnabled');
    const profileDialog = document.querySelector('#profileDialog');
    const profileSummary = document.querySelector('#profileSummary');
    const status = document.querySelector('#status');
    const output = document.querySelector('#output');
    const parameterDialog = document.querySelector('#parameterDialog');
    const parameterDialogTitle = document.querySelector('#parameterDialogTitle');
    const parameterDialogHelp = document.querySelector('#parameterDialogHelp');
    const parameterDialogBody = document.querySelector('#parameterDialogBody');
    const previewState = { reminder: 'single', digest: 'digest' };
    const previewTitles = {
      reminder: {
        single: 'Einzeltermin',
        collection: 'Sammelnachricht',
      },
      digest: {
        digest: 'Wochenübersicht',
        digestEmpty: 'Leere Wochenübersicht',
      },
    };

    function setStatus(text, cls = '') {
      status.className = ['status', cls].filter(Boolean).join(' ');
      status.textContent = text;
    }

    function currentValues() {
      const data = {};
      for (const setting of metadata.flatMap(group => group.settings)) {
        const el = form.elements[setting.key];
        if (!el) continue;
        data[setting.key] = setting.type === 'boolean' ? el.checked : el.value;
      }
      return data;
    }

    function generatedProfileId(name, fallback = 'profil') {
      const normalized = String(name ?? '')
        .trim()
        .toLowerCase()
        .replaceAll('ß', 'ss')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '');
      return normalized || fallback;
    }

    function uniqueProfileId(name, currentIndex = -1) {
      const base = generatedProfileId(name);
      const used = new Set(profiles
        .filter((profile, index) => index !== currentIndex)
        .map(profile => profile.id));
      let candidate = base;
      let suffix = 2;
      while (used.has(candidate)) candidate = base + '-' + suffix++;
      return candidate;
    }

    function syncSelectedProfile() {
      if (!profiles[selectedProfile]) return;
      const profile = profiles[selectedProfile];
      profile.values = currentValues();
      profile.name = profileName.value.trim();
      const enteredId = profileId.value.trim();
      profile.id = profile.generatedId || !enteredId
        ? uniqueProfileId(profile.name, selectedProfile)
        : enteredId;
      profileId.value = profile.id;
      profile.enabled = profileEnabled.checked;
      profile.whatsappTargets = [...groupList.querySelectorAll('.group-card')].map((card) => {
        const type = card.querySelector('[data-target-type]').value;
        const address = card.querySelector('[data-target-address]').value;
        return {
          type,
          enabled: card.querySelector('[data-target-enabled]').checked,
          name: card.querySelector('[data-target-name]').value,
          ...(type === 'person' ? { phone: address } : { id: address }),
        };
      });
    }

    function activeProfile() {
      return profiles[selectedProfile] ?? { id: 'default', name: 'Standard', enabled: true, values, whatsappTargets: [] };
    }

    function render() {
      form.innerHTML = '';
      nav.innerHTML = '';
      values = activeProfile().values ?? {};
      renderProfiles();
      for (const group of metadata) {
        const fieldset = document.createElement('fieldset');
        fieldset.id = 'group-' + group.name.toLowerCase().replaceAll(' ', '-').replace(/[^\w-]/g, '');
        const link = document.createElement('a');
        link.href = '#' + fieldset.id;
        link.textContent = group.name;
        nav.append(link);
        const legend = document.createElement('legend');
        legend.textContent = group.name;
        fieldset.append(legend);
        const grid = document.createElement('div');
        grid.className = 'grid';
        for (const setting of group.settings) {
          if (setting.hidden) continue;
          const label = document.createElement('label');
          if (setting.type === 'template') label.className = 'template';
          if (setting.type === 'boolean') label.classList.add('boolean');
          const labelText = document.createElement('span');
          labelText.className = 'label-text';
          labelText.textContent = setting.label;
          label.append(labelText);
          let input;
          if (setting.type === 'select') {
            input = document.createElement('select');
            for (const option of setting.options) {
              const item = document.createElement('option');
              item.value = option;
              item.textContent = option;
              input.append(item);
            }
          } else if (setting.type === 'template') {
            input = document.createElement('textarea');
          } else {
            input = document.createElement('input');
            input.type = setting.type === 'boolean' ? 'checkbox' : setting.type === 'password' ? 'password' : setting.type === 'number' ? 'number' : setting.type === 'time' ? 'time' : 'text';
          }
          input.name = setting.key;
          if (setting.type === 'boolean') input.checked = Boolean(values[setting.key]);
          else input.value = values[setting.key] ?? '';
          input.addEventListener('input', refreshTemplatePreview);
          label.append(input);
          if (setting.help) {
            const help = document.createElement('div');
            help.className = 'help';
            help.textContent = setting.help;
            label.append(help);
          }
          grid.append(label);
        }
        fieldset.append(grid);
        const tools = templateToolsForGroup(group);
        if (tools) fieldset.append(tools);
        const preview = previewForGroup(group.name);
        if (preview) fieldset.append(preview);
        form.append(fieldset);
      }
    }

    function switchToProfile(index) {
      syncSelectedProfile();
      selectedProfile = index;
      render();
      refreshTemplatePreview();
    }

    function renderProfileSelect() {
      profileSelect.innerHTML = '';
      profiles.forEach((profile, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = profile.name || profile.id || 'Profil';
        profileSelect.append(option);
      });
      profileSelect.value = String(selectedProfile);
    }

    function renderProfiles() {
      profileTabs.innerHTML = '';
      profiles.forEach((profile, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = profile.name || profile.id || 'Profil';
        button.classList.toggle('active', index === selectedProfile);
        button.addEventListener('click', () => switchToProfile(index));
        profileTabs.append(button);
      });
      renderProfileSelect();
      const profile = activeProfile();
      profileId.value = profile.id ?? 'default';
      profileName.value = profile.name ?? profile.id ?? 'Standard';
      profileEnabled.checked = profile.enabled !== false;
      renderTargets(profile.whatsappTargets ?? []);
      renderProfileSummary();
    }

    profileSelect.addEventListener('change', () => {
      const index = Number.parseInt(profileSelect.value, 10);
      if (Number.isInteger(index) && index !== selectedProfile) switchToProfile(index);
    });

    function renderProfileSummary() {
      if (!profileSummary) return;
      const profile = activeProfile();
      const targets = profile.whatsappTargets ?? [];
      const groupCount = targets.filter(target => target.type !== 'person').length;
      const personCount = targets.filter(target => target.type === 'person').length;
      const targetLabel = groupCount + ' Gruppe(n), ' + personCount + ' Person(en)';
      const activeLabel = profile.enabled === false ? 'inaktiv' : 'aktiv';
      profileSummary.textContent = (profile.name || profile.id || 'Profil') + ' \u2013 ' + activeLabel + ', ' + targetLabel + ' (' + profiles.length + ' Profil(e) insgesamt)';
    }

    function renderTargets(targets) {
      groupList.innerHTML = '';
      for (const target of targets) addTargetRow(target);
    }

    function addTargetRow(target = {}) {
      const card = document.createElement('div');
      card.className = 'group-card';
      const type = document.createElement('select');
      type.dataset.targetType = '1';
      for (const [value, label] of [['group', 'Gruppe'], ['person', 'Person']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        type.append(option);
      }
      type.value = target.type === 'person' ? 'person' : 'group';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = target.enabled !== false;
      enabled.dataset.targetEnabled = '1';
      const name = document.createElement('input');
      name.type = 'text';
      name.placeholder = 'Anzeigename';
      name.value = target.name ?? '';
      name.dataset.targetName = '1';
      const address = document.createElement('input');
      address.type = 'text';
      address.value = type.value === 'person' ? (target.phone ?? '') : (target.id ?? '');
      address.dataset.targetAddress = '1';
      const updatePlaceholder = () => {
        address.placeholder = type.value === 'person' ? '+4915112345678' : '120363…@g.us';
      };
      type.addEventListener('change', updatePlaceholder);
      updatePlaceholder();
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Entfernen';
      remove.addEventListener('click', () => card.remove());
      card.append(enabled, type, name, address, remove);
      groupList.append(card);
    }

    function templateToolsForGroup(group) {
      const templateSettings = group.settings.filter(setting => setting.placeholderGroups);
      if (templateSettings.length === 0) return null;
      const groups = mergePlaceholderGroups(templateSettings);
      const wrapper = document.createElement('div');
      wrapper.className = 'template-tools';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'parameter-button';
      button.textContent = 'Parameterübersicht';
      button.addEventListener('click', () => openParameterDialog(group.name, groups));
      wrapper.append(button);
      return wrapper;
    }

    function mergePlaceholderGroups(settings) {
      const byName = new Map();
      for (const setting of settings) {
        for (const group of setting.placeholderGroups) {
          if (!byName.has(group.name)) byName.set(group.name, new Map());
          const placeholders = byName.get(group.name);
          for (const placeholder of group.placeholders) {
            if (!placeholders.has(placeholder.key)) placeholders.set(placeholder.key, placeholder);
          }
        }
      }
      return Array.from(byName, ([name, placeholders]) => ({ name, placeholders: Array.from(placeholders.values()) }));
    }

    function openParameterDialog(groupName, groups) {
      parameterDialogTitle.textContent = 'Parameterübersicht: ' + groupName;
      parameterDialogHelp.textContent = 'Hover oder Fokus zeigt pro Parameter ein konkretes Beispiel. Die Übersicht gilt für die Templates in dieser Kategorie.';
      parameterDialogBody.replaceChildren(createPlaceholderHelp(groups));
      parameterDialog.showModal();
    }

    function createPlaceholderHelp(groups) {
      const wrapper = document.createElement('div');
      wrapper.className = 'placeholder-help';
      for (const group of groups) {
        const section = document.createElement('section');
        section.className = 'placeholder-group';
        const title = document.createElement('div');
        title.className = 'placeholder-group-title';
        title.textContent = group.name;
        const chips = document.createElement('div');
        chips.className = 'placeholder-chips';
        for (const placeholder of group.placeholders) {
          const chip = document.createElement('span');
          chip.className = 'placeholder-chip';
          chip.tabIndex = 0;
          chip.textContent = '{' + placeholder.key + '}';
          chip.title = placeholder.description + ' Beispiel: ' + placeholder.example;
          chip.dataset.tooltip = placeholder.description + ' Beispiel: ' + placeholder.example;
          chips.append(chip);
        }
        section.append(title, chips);
        wrapper.append(section);
      }
      return wrapper;
    }

    document.querySelector('#parameterDialogClose').onclick = () => parameterDialog.close();
    parameterDialog.addEventListener('click', (event) => {
      if (event.target === parameterDialog) parameterDialog.close();
    });

    document.querySelector('#manageProfiles').onclick = () => {
      renderProfiles();
      profileDialog.showModal();
    };
    document.querySelector('#profileDialogClose').onclick = () => {
      syncSelectedProfile();
      profileDialog.close();
    };
    profileDialog.addEventListener('close', () => {
      syncSelectedProfile();
      renderProfileSummary();
    });
    profileDialog.addEventListener('click', (event) => {
      if (event.target === profileDialog) profileDialog.close();
    });

    function previewForGroup(groupName) {
      if (groupName === 'Nachrichtentexte') {
        return createPreviewPanel({
          id: 'reminderPreview',
          kind: 'reminder',
          title: 'Nachrichten-Vorschau',
          help: 'So sehen Einzel- und Sammelerinnerungen mit den aktuellen Templates aus.',
          options: [
            ['single', 'Einzeltermin'],
            ['collection', 'Sammelnachricht'],
          ],
        });
      }
      if (groupName === 'Wochenübersicht') {
        return createPreviewPanel({
          id: 'digestPreview',
          kind: 'digest',
          title: 'Vorschau Wochenübersicht',
          help: 'Prüft die normalen und leeren Wochenübersichts-Templates direkt hier.',
          options: [
            ['digest', 'Mit Terminen'],
            ['digestEmpty', 'Ohne Termine'],
          ],
        });
      }
      return null;
    }

    function createPreviewPanel({ id, kind, title, help, options }) {
      const section = document.createElement('section');
      section.className = 'category-preview';
      const header = document.createElement('header');
      const intro = document.createElement('div');
      const heading = document.createElement('h3');
      heading.textContent = title;
      const description = document.createElement('p');
      description.className = 'help';
      description.textContent = help;
      intro.append(heading, description);
      const tabs = document.createElement('div');
      tabs.className = 'preview-tabs';
      for (const [key, label] of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.previewKind = kind;
        button.dataset.previewKey = key;
        button.textContent = label;
        if (previewState[kind] === key) button.classList.add('active');
        button.addEventListener('click', () => {
          previewState[kind] = key;
          updateActivePreviewTabs(kind);
          refreshTemplatePreview();
        });
        tabs.append(button);
      }
      header.append(intro, tabs);
      const phone = document.createElement('div');
      phone.className = 'phone-preview';
      const bubble = document.createElement('div');
      bubble.id = id;
      bubble.className = 'message-bubble';
      bubble.textContent = 'Vorschau wird geladen …';
      phone.append(bubble);
      section.append(header, phone);
      return section;
    }

    function updateActivePreviewTabs(kind) {
      for (const button of form.querySelectorAll('[data-preview-kind="' + kind + '"]')) {
        button.classList.toggle('active', button.dataset.previewKey === previewState[kind]);
      }
    }

    function setPreviewBubble(id, text, error = false) {
      const bubble = document.querySelector('#' + id);
      if (!bubble) return;
      bubble.classList.toggle('error', error);
      bubble.textContent = text;
    }

    async function api(path, body, options = {}) {
      const res = await fetch(path, body === undefined ? undefined : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok && !options.allowError) throw new Error(data.error || 'Request fehlgeschlagen');
      return data;
    }

    async function load() {
      const data = await api('/api/config');
      metadata = data.metadata;
      profiles = data.profiles?.length ? data.profiles : [{ id: 'default', name: 'Standard', enabled: true, values: data.values, whatsappTargets: [] }];
      selectedProfile = Math.min(selectedProfile, profiles.length - 1);
      values = activeProfile().values;
      render();
      setStatus('geladen aus ' + data.configPath, 'ok');
      await refreshTemplatePreview();
    }

    async function refreshTemplatePreview() {
      try {
        syncSelectedProfile();
        const data = await api('/api/templates/preview', { profiles, selectedProfile });
        const reminderKey = previewState.reminder;
        const digestKey = previewState.digest;
        setPreviewBubble(
          'reminderPreview',
          previewTitles.reminder[reminderKey] + '\n\n' + data.preview[reminderKey],
        );
        setPreviewBubble(
          'digestPreview',
          previewTitles.digest[digestKey] + '\n\n' + data.preview[digestKey],
        );
      } catch (error) {
        setPreviewBubble('reminderPreview', error.message, true);
        setPreviewBubble('digestPreview', error.message, true);
      }
    }

    document.querySelector('#save').onclick = async () => {
      try {
        syncSelectedProfile();
        const data = await api('/api/config', { profiles });
        profiles = data.profiles;
        values = activeProfile().values;
        setStatus('gespeichert', 'ok');
        output.textContent = 'Gespeichert und validiert.';
      } catch (error) {
        setStatus('Speichern fehlgeschlagen', 'error');
        output.textContent = error.message;
      }
    };
    document.querySelector('#validate').onclick = async () => {
      syncSelectedProfile();
      const data = await api('/api/validate', { profiles }, { allowError: true });
      setStatus(data.ok ? 'gültig' : 'ungültig', data.ok ? 'ok' : 'error');
      output.textContent = data.ok ? 'Konfiguration ist gültig.' : data.error;
    };
    profileName.addEventListener('input', () => {
      const profile = activeProfile();
      if (!profile.generatedId) return;
      profileId.value = uniqueProfileId(profileName.value, selectedProfile);
    });
    profileId.addEventListener('input', () => {
      activeProfile().generatedId = false;
    });
    document.querySelector('#addProfile').onclick = () => {
      syncSelectedProfile();
      const base = activeProfile();
      const name = 'Neues Profil';
      profiles.push({
        id: uniqueProfileId(name),
        name,
        originalId: base.id,
        generatedId: true,
        enabled: true,
        values: { ...(base.values ?? values) },
        whatsappTargets: [],
      });
      selectedProfile = profiles.length - 1;
      render();
      refreshTemplatePreview();
    };
    document.querySelector('#copyProfile').onclick = () => {
      syncSelectedProfile();
      const base = activeProfile();
      const name = (base.name || base.id || 'Profil') + ' Kopie';
      profiles.push({
        id: uniqueProfileId((base.id || 'profil') + '-kopie'),
        originalId: base.id,
        name,
        enabled: base.enabled !== false,
        values: { ...base.values },
        whatsappTargets: (base.whatsappTargets ?? []).map(target => ({ ...target })),
      });
      selectedProfile = profiles.length - 1;
      render();
      refreshTemplatePreview();
    };
    document.querySelector('#deleteProfile').onclick = () => {
      if (profiles.length <= 1) return;
      profiles.splice(selectedProfile, 1);
      selectedProfile = Math.max(0, selectedProfile - 1);
      render();
      refreshTemplatePreview();
    };
    document.querySelector('#addGroup').onclick = () => addTargetRow({ type: 'group', enabled: true });
    document.querySelector('#addPerson').onclick = () => addTargetRow({ type: 'person', enabled: true });

    const whatsappGroupPicker = document.querySelector('#whatsappGroupPicker');
    const whatsappGroupStatus = document.querySelector('#whatsappGroupStatus');
    const profileStateStatus = document.querySelector('#profileStateStatus');

    function existingGroupIds() {
      return new Set([...groupList.querySelectorAll('.group-card')]
        .filter(card => card.querySelector('[data-target-type]').value === 'group')
        .map(card => card.querySelector('[data-target-address]').value.trim())
        .filter(Boolean));
    }

    function renderWhatsAppGroups(groups) {
      whatsappGroupPicker.innerHTML = '';
      const existing = existingGroupIds();
      for (const group of groups) {
        const known = existing.has(group.id);
        const card = document.createElement('div');
        card.className = 'group-card whatsapp-group-card';
        card.dataset.waId = group.id;
        card.dataset.waName = group.name || '';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.whatsappGroup = '1';
        checkbox.checked = !known;
        checkbox.disabled = known;
        const name = document.createElement('span');
        name.textContent = group.name || '(ohne Namen)';
        const id = document.createElement('span');
        id.className = 'help';
        id.textContent = group.id;
        const state = document.createElement('span');
        state.className = 'help';
        state.textContent = known ? 'bereits im Profil' : 'neu';
        card.append(checkbox, name, id, state);
        whatsappGroupPicker.append(card);
      }
    }

    document.querySelector('#loadWhatsAppGroups').onclick = async () => {
      whatsappGroupPicker.innerHTML = '';
      whatsappGroupStatus.textContent = 'WhatsApp-Gruppen werden geladen …';
      try {
        syncSelectedProfile();
        const data = await api('/api/whatsapp/groups', { profiles, selectedProfile });
        const groups = data.groups ?? [];
        renderWhatsAppGroups(groups);
        whatsappGroupStatus.textContent = data.message || (groups.length + ' Gruppe(n) gefunden.');
      } catch (error) {
        whatsappGroupStatus.textContent = error.message + ' Tipp: Kopplung mit "npm run pair" im Terminal prüfen.';
      }
    };

    document.querySelector('#importWhatsAppGroups').onclick = () => {
      const existing = existingGroupIds();
      const cards = [...whatsappGroupPicker.querySelectorAll('.whatsapp-group-card')];
      let added = 0;
      for (const card of cards) {
        const checkbox = card.querySelector('[data-whatsapp-group]');
        const id = card.dataset.waId;
        if (!checkbox || !checkbox.checked || !id || existing.has(id)) continue;
        addTargetRow({ type: 'group', id, name: card.dataset.waName, enabled: true });
        existing.add(id);
        added += 1;
      }
      syncSelectedProfile();
      renderProfileSummary();
      renderWhatsAppGroups(cards.map(card => ({ id: card.dataset.waId, name: card.dataset.waName })));
      whatsappGroupStatus.textContent = added === 0
        ? 'Keine neuen Gruppen übernommen.'
        : added + ' Gruppe(n) in das Profil übernommen. Zum Sichern noch "Speichern" klicken.';
    };

    document.querySelector('#clearProfileState').onclick = async () => {
      syncSelectedProfile();
      const profile = activeProfile();
      const label = profile.name || profile.id || 'dieses Profil';
      if (!confirm('State für "' + label + '" wirklich leeren? Bereits gesendete Erinnerungen dieses Profils können danach erneut fällig werden.')) {
        return;
      }
      profileStateStatus.textContent = 'State wird geleert …';
      try {
        const data = await api('/api/state/profile/clear', { profiles, selectedProfile });
        profileStateStatus.textContent = data.message;
      } catch (error) {
        profileStateStatus.textContent = error.message;
      }
    };
    document.querySelector('#preview').onclick = async () => {
      setStatus('Preview läuft …');
      syncSelectedProfile();
      const data = await api('/api/run/preview', { days: 30, profiles, selectedProfile });
      setStatus(data.code === 0 ? 'Preview fertig' : 'Preview mit Fehlern', data.code === 0 ? 'ok' : 'error');
      output.textContent = data.output;
    };
    document.querySelector('#dryrun').onclick = async () => {
      setStatus('Dry-Run läuft …');
      syncSelectedProfile();
      const data = await api('/api/run/dry-run', { profiles, selectedProfile });
      setStatus(data.code === 0 ? 'Dry-Run fertig' : 'Dry-Run mit Fehlern', data.code === 0 ? 'ok' : 'error');
      output.textContent = data.output;
    };
    document.querySelector('#reload').onclick = load;
    load().catch(error => setStatus(error.message, 'error'));
  </script>
</body>
</html>`;
}

export function createSettingsServer({
  cwd = ROOT,
  createWhatsAppClient: createClient = createWhatsAppClient,
  hasWhatsAppSession = hasSession,
} = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        return text(res, 200, page(), 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const effective = loadEffectiveConfig({ cwd });
        const runtime = loadEffectiveRuntimeConfig({ cwd });
        return json(res, 200, {
          configPath: configPath(cwd),
          metadata: groupedSettings(),
          values: valuesFromConfig(effective),
          profiles: profilesFromRuntimeConfig(runtime),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/validate') {
        const body = await readBody(req);
        if (body.profiles) {
          const result = validateProfiles(body.profiles, { cwd });
          return json(res, result.ok ? 200 : 400, result);
        }
        const result = validateValues(body.values, { cwd });
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        if (body.profiles) {
          const validation = validateProfiles(body.profiles, { cwd });
          if (!validation.ok) return json(res, 400, validation);
          writeProfilesConfigJson(body.profiles, { cwd });
          const runtime = loadEffectiveRuntimeConfig({ cwd });
          return json(res, 200, { ok: true, validation, profiles: profilesFromRuntimeConfig(runtime) });
        }
        const validation = validateValues(body.values, { cwd });
        if (!validation.ok) return json(res, 400, validation);
        writeConfigJson(body.values, { cwd });
        const effective = loadEffectiveConfig({ cwd });
        return json(res, 200, { ok: true, validation, values: valuesFromConfig(effective) });
      }

      if (req.method === 'POST' && url.pathname === '/api/templates/preview') {
        const body = await readBody(req);
        if (body.profiles) {
          const validation = validateProfiles(body.profiles, { cwd });
          if (!validation.ok) return json(res, 400, validation);
          const selectedProfile = Number.parseInt(String(body.selectedProfile), 10);
          if (!Number.isInteger(selectedProfile) || !body.profiles[selectedProfile]) {
            return json(res, 400, { ok: false, error: 'Ausgewähltes Profil ist ungültig' });
          }
          const profileConfig = validation.config.profiles[selectedProfile];
          const config = loadEffectiveConfig({
            cwd,
            configFile: configPath(cwd),
            overrides: profileConfig,
          });
          return json(res, 200, { preview: previewTemplates(config) });
        }
        const validation = validateValues(body.values, { cwd });
        if (!validation.ok) return json(res, 400, validation);
        const config = loadEffectiveConfig({ cwd, configFile: configPath(cwd), overrides: validation.config });
        return json(res, 200, { preview: previewTemplates(config) });
      }

      if (req.method === 'POST' && url.pathname === '/api/whatsapp/groups') {
        const body = await readBody(req);
        let config;
        if (body.profiles) {
          const validation = validateProfiles(body.profiles, { cwd });
          if (!validation.ok) return json(res, 400, validation);
          const selectedProfile = Number.parseInt(String(body.selectedProfile), 10);
          if (!Number.isInteger(selectedProfile) || !body.profiles[selectedProfile]) {
            return json(res, 400, { ok: false, error: 'Ausgewähltes Profil ist ungültig' });
          }
          config = loadEffectiveConfig({
            cwd,
            configFile: configPath(cwd),
            overrides: validation.config.profiles[selectedProfile],
          });
        } else {
          const validation = validateValues(body.values, { cwd });
          if (!validation.ok) return json(res, 400, validation);
          config = loadEffectiveConfig({ cwd, configFile: configPath(cwd), overrides: validation.config });
        }
        const result = await listWhatsAppGroups(config, { createClient, hasWhatsAppSession });
        return json(res, result.status, result.payload);
      }

      if (req.method === 'POST' && url.pathname === '/api/state/profile/clear') {
        const body = await readBody(req);
        const validation = validateProfiles(body.profiles, { cwd });
        if (!validation.ok) return json(res, 400, validation);
        const selectedProfile = Number.parseInt(String(body.selectedProfile), 10);
        const profileConfig = validation.config.profiles[selectedProfile];
        if (!Number.isInteger(selectedProfile) || !profileConfig) {
          return json(res, 400, { ok: false, error: 'Ausgewähltes Profil ist ungültig' });
        }
        const config = loadEffectiveConfig({
          cwd,
          configFile: configPath(cwd),
          overrides: profileConfig,
        });
        const db = openDatabase(config.dbPath);
        try {
          const deleted = db.clearProfile(profileConfig.id);
          return json(res, 200, {
            ok: true,
            deleted,
            message: `${deleted} State-Eintrag/Einträge für Profil "${profileConfig.name || profileConfig.id}" gelöscht.`,
          });
        } finally {
          db.close();
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/run/preview') {
        const body = await readBody(req);
        const days = Number.parseInt(String(body.days ?? 30), 10);
        const result = await runSettingsCommand(body, ['--preview', String(Number.isFinite(days) ? days : 30)], { cwd });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/run/dry-run') {
        const body = await readBody(req);
        const result = await runSettingsCommand(body, ['--dry-run'], { cwd });
        return json(res, 200, result);
      }

      return json(res, 404, { error: 'Nicht gefunden' });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
}

export const SETTINGS_USAGE = `
chatendar Einstellungen

Aufruf:
  npm run settings -- [Optionen]

Optionen:
  --host <Adresse>  Listener-Adresse (Default: 127.0.0.1)
  --port <Port>     Listener-Port (Default: 3876)
  --help, -h        Diese Hilfe

Beispiel für ein privates LAN:
  npm run settings -- --host 192.168.1.50 --port 3876

Eine LAN-Bindung muss zusätzlich per Firewall auf das vertrauenswürdige
lokale Netz beschränkt werden.
`.trim();

export function parseSettingsServerArgs(argv) {
  const result = { host: '127.0.0.1', port: 3876, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const separator = arg.indexOf('=');
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const inlineValue = separator === -1 ? null : arg.slice(separator + 1);
    const nextValue = () => {
      if (inlineValue !== null) return inlineValue;
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Option ${flag} erwartet einen Wert`);
      }
      i += 1;
      return value;
    };

    switch (flag) {
      case '--host': {
        const value = nextValue().trim();
        if (!value) throw new Error('--host erwartet eine nicht leere Adresse');
        result.host = value;
        break;
      }
      case '--port': {
        const value = nextValue();
        if (!/^\d+$/.test(value)) {
          throw new Error(`--port erwartet eine ganze Zahl zwischen 1 und 65535 (ist: "${value}")`);
        }
        const port = Number.parseInt(value, 10);
        if (port < 1 || port > 65535) {
          throw new Error(`--port erwartet eine ganze Zahl zwischen 1 und 65535 (ist: "${value}")`);
        }
        result.port = port;
        break;
      }
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`Unbekannte Option: ${arg}\n\n${SETTINGS_USAGE}`);
    }
  }

  return result;
}

export function startSettingsServer({ host = '127.0.0.1', port = 3876, cwd = ROOT } = {}) {
  const server = createSettingsServer({ cwd });
  server.listen(port, host, () => {
    const address = server.address();
    const displayAddress = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    console.log(`chatendar Einstellungen: http://${displayAddress}:${address.port}`);
  });
  return server;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseSettingsServerArgs(process.argv.slice(2));
    if (options.help) {
      console.log(SETTINGS_USAGE);
    } else {
      startSettingsServer(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
