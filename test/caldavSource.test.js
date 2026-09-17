import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { fetchEvents } from '../src/calendar/caldavSource.js';
import { FIXTURES, testConfig } from './helpers.js';

const RANGE = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-12-01T00:00:00Z'),
};

function caldavConfig(overrides = {}) {
  return testConfig({
    ...overrides,
    env: {
      SOURCE: 'caldav',
      CALDAV_URL: 'https://cloud.example.test/remote.php/dav',
      CALDAV_USERNAME: 'user',
      CALDAV_PASSWORD: 'secret',
      CALDAV_CALENDAR: 'Familie',
      ...overrides.env,
    },
  });
}

function clientFactory({ calendars, objects, calls = [] }) {
  return async (params) => {
    calls.push({ method: 'createDAVClient', params });
    return {
      async fetchCalendars() {
        calls.push({ method: 'fetchCalendars' });
        return calendars;
      },
      async fetchCalendarObjects(params) {
        calls.push({ method: 'fetchCalendarObjects', params });
        return objects;
      },
    };
  };
}

describe('CalDAV-Quelle', () => {
  it('lädt Kalenderobjekte und mappt sie in interne Termine', async () => {
    const calls = [];
    const data = fs.readFileSync(path.join(FIXTURES, 'beispiel.ics'), 'utf8');
    const createClient = clientFactory({
      calls,
      calendars: [{ displayName: 'Familie', url: 'https://cloud.example.test/calendars/user/familie/' }],
      objects: [{ url: 'https://cloud.example.test/calendars/user/familie/a.ics', data }],
    });

    const events = await fetchEvents(caldavConfig(), RANGE, { createClient });

    assert.ok(events.some((event) => event.titel.includes('Elternabend')));
    assert.ok(events.some((event) => event.serie));
    assert.deepEqual(calls[0].params.credentials, { username: 'user', password: 'secret' });
    assert.deepEqual(calls.find((call) => call.method === 'fetchCalendarObjects').params.timeRange, {
      start: RANGE.from.toISOString(),
      end: RANGE.to.toISOString(),
    });
  });

  it('findet Kalender auch über die URL', async () => {
    const createClient = clientFactory({
      calendars: [{ displayName: 'Privat', url: 'https://cloud.example.test/calendars/user/familie/' }],
      objects: [],
    });
    const config = caldavConfig({ env: { CALDAV_CALENDAR: 'https://cloud.example.test/calendars/user/familie/' } });

    await assert.doesNotReject(() => fetchEvents(config, RANGE, { createClient }));
  });

  it('meldet unbekannte Kalender mit verfügbaren Namen', async () => {
    const createClient = clientFactory({
      calendars: [{ displayName: 'Privat', url: 'https://cloud.example.test/calendars/user/privat/' }],
      objects: [],
    });

    await assert.rejects(
      () => fetchEvents(caldavConfig(), RANGE, { createClient }),
      /CalDAV-Kalender "Familie" nicht gefunden.*Privat/,
    );
  });

  it('überspringt Kalenderobjekte ohne ICS-Daten', async () => {
    const createClient = clientFactory({
      calendars: [{ displayName: 'Familie' }],
      objects: [{ url: 'empty.ics' }],
    });

    const events = await fetchEvents(caldavConfig(), RANGE, { createClient });
    assert.deepEqual(events, []);
  });

  it('meldet Netzwerk- und Serverfehler mit Kontext', async () => {
    const createClient = async () => {
      throw new Error('ECONNREFUSED');
    };

    await assert.rejects(
      () => fetchEvents(caldavConfig(), RANGE, { createClient }),
      /CalDAV-Verbindung konnte nicht aufgebaut werden: ECONNREFUSED/,
    );
  });
});
