import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { parseArgs } from '../src/cli.js';
import { runKeepalives } from '../src/messaging/keepalive.js';
import { readSessionMeta, recordConnection } from '../src/messaging/sessionMaintenance.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-20T12:00:00Z');

const dirs = [];
function session({ paired = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-keepalive-'));
  dirs.push(dir);
  if (paired) fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
  return dir;
}

function fakeClientFactory({ failWith = null } = {}) {
  const calls = { created: [], synced: 0, closed: 0 };
  const createClient = async (profile) => {
    calls.created.push(profile.authDir);
    if (failWith) throw new Error(failWith);
    return {
      async waitUntilSynced() {
        calls.synced += 1;
        return true;
      },
      async close() {
        calls.closed += 1;
      },
    };
  };
  return { calls, createClient };
}

const profile = (authDir, extra = {}) => ({ authDir, dryRun: false, keepaliveDays: 7, ...extra });

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Keepalive', () => {
  it('verbindet, wenn lange keine Verbindung bestand, und schließt wieder', async () => {
    const authDir = session();
    recordConnection(authDir, new Date(NOW.getTime() - 8 * DAY));
    const { calls, createClient } = fakeClientFactory();

    const code = await runKeepalives([profile(authDir)], { now: NOW, createClient });

    assert.equal(code, 0);
    assert.deepEqual(calls.created, [authDir]);
    assert.equal(calls.synced, 1);
    assert.equal(calls.closed, 1);
    assert.equal(readSessionMeta(authDir).lastKeepaliveAttemptAt, NOW.toISOString());
  });

  it('verbindet nicht, wenn die letzte Verbindung jünger als keepaliveDays ist', async () => {
    const authDir = session();
    recordConnection(authDir, new Date(NOW.getTime() - 2 * DAY));
    const { calls, createClient } = fakeClientFactory();

    assert.equal(await runKeepalives([profile(authDir)], { now: NOW, createClient }), 0);
    assert.deepEqual(calls.created, []);
  });

  it('überspringt Dry-Run-Profile und abgeschaltetes Keepalive automatisch', async () => {
    const authDir = session();
    const { calls, createClient } = fakeClientFactory();

    await runKeepalives([profile(authDir, { dryRun: true }), profile(authDir, { keepaliveDays: 0 })], {
      now: NOW,
      createClient,
    });

    assert.deepEqual(calls.created, []);
  });

  it('verbindet eine gemeinsam genutzte Session nur einmal', async () => {
    const authDir = session();
    const { calls, createClient } = fakeClientFactory();

    await runKeepalives([profile(authDir, { dryRun: true }), profile(authDir), profile(authDir)], {
      now: NOW,
      createClient,
    });

    assert.deepEqual(calls.created, [authDir]);
  });

  it('erzwingt den Lauf mit force, auch bei Dry-Run, frischer Verbindung und aus', async () => {
    const authDir = session();
    recordConnection(authDir, NOW);
    const { calls, createClient } = fakeClientFactory();

    const code = await runKeepalives([profile(authDir, { dryRun: true, keepaliveDays: 0 })], {
      now: NOW,
      force: true,
      createClient,
    });

    assert.equal(code, 0);
    assert.deepEqual(calls.created, [authDir]);
  });

  it('meldet Fehler per Exit-Code, vermerkt den Versuch und sperrt Wiederholungen', async () => {
    const authDir = session();
    const { calls, createClient } = fakeClientFactory({ failWith: 'abgemeldet' });

    assert.equal(await runKeepalives([profile(authDir)], { now: NOW, createClient }), 1);
    assert.equal(calls.created.length, 1);
    assert.equal(readSessionMeta(authDir).lastKeepaliveAttemptAt, NOW.toISOString());

    const soonAfter = new Date(NOW.getTime() + 60 * 60 * 1000);
    assert.equal(await runKeepalives([profile(authDir)], { now: soonAfter, createClient }), 0);
    assert.equal(calls.created.length, 1, 'innerhalb der Sperrfrist kein weiterer Versuch');

    const muchLater = new Date(NOW.getTime() + 7 * 60 * 60 * 1000);
    assert.equal(await runKeepalives([profile(authDir)], { now: muchLater, createClient }), 1);
    assert.equal(calls.created.length, 2);
  });

  it('behandelt eine fehlende Session automatisch als Warnung, manuell als Fehler', async () => {
    const authDir = session({ paired: false });
    const { calls, createClient } = fakeClientFactory();

    assert.equal(await runKeepalives([profile(authDir)], { now: NOW, createClient }), 0);
    assert.equal(await runKeepalives([profile(authDir)], { now: NOW, force: true, createClient }), 1);
    assert.deepEqual(calls.created, []);
  });

  it('erkennt --keepalive auf der Kommandozeile', () => {
    assert.equal(parseArgs([]).keepalive, false);
    assert.equal(parseArgs(['--keepalive']).keepalive, true);
  });
});
