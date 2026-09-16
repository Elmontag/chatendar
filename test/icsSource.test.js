import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { fetchEvents } from '../src/calendar/calendarSource.js';
import { FIXTURES, testConfig } from './helpers.js';

const WEITES_FENSTER = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-12-01T00:00:00Z'),
};

async function ladeFixture(datei, range = WEITES_FENSTER, overrides = {}) {
  const config = testConfig({ env: { ICS_PATH: path.join(FIXTURES, datei), ...overrides } });
  return fetchEvents(config, range);
}

describe('ICS-Quelle: beispiel.ics', () => {
  it('liest alle Termine inklusive expandierter Serie', async () => {
    const events = await ladeFixture('beispiel.ics');
    const titel = events.map((e) => e.titel);
    assert.ok(titel.includes('[WA] Elternabend Klasse 4b'));
    assert.ok(titel.includes('Vereinssitzung'));
    assert.ok(titel.includes('Zahnarzt'));
  });

  it('liefert Termine chronologisch sortiert', async () => {
    const events = await ladeFixture('beispiel.ics');
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i - 1].start <= events[i].start, 'Termine sind nicht chronologisch sortiert');
    }
  });

  it('übernimmt Kategorien und Ort', async () => {
    const events = await ladeFixture('beispiel.ics');
    const sitzung = events.find((e) => e.titel === 'Vereinssitzung');
    assert.deepEqual(sitzung.kategorien, ['WhatsApp', 'Verein']);
    assert.equal(sitzung.ort, 'Clubheim');
  });

  it('stellt X-WA-REMIND unter beiden Schreibweisen bereit', async () => {
    const events = await ladeFixture('beispiel.ics');
    const elternabend = events.find((e) => e.titel.includes('Elternabend'));
    assert.equal(elternabend.customProps['X-WA-REMIND'], '1d,2h');
    assert.equal(elternabend.customProps['WA-REMIND'], '1d,2h');
  });

  it('rechnet Zeitzonen korrekt um (18:30 Berlin = 16:30 UTC)', async () => {
    const events = await ladeFixture('beispiel.ics');
    const elternabend = events.find((e) => e.titel.includes('Elternabend'));
    assert.equal(elternabend.start.toISOString(), '2026-09-20T16:30:00.000Z');
  });

  it('legt ganztägige Termine auf lokale Mitternacht', async () => {
    const events = await ladeFixture('beispiel.ics');
    const sommerfest = events.find((e) => e.titel === 'Sommerfest');
    assert.equal(sommerfest.ganztags, true);
    // 26.09.2026 00:00 Berlin (CEST) = 25.09.2026 22:00 UTC
    assert.equal(sommerfest.start.toISOString(), '2026-09-25T22:00:00.000Z');
  });

  it('expandiert Serientermine und beachtet EXDATE', async () => {
    const events = await ladeFixture('beispiel.ics');
    const training = events.filter((e) => e.uid === 'training@chatendar.example');
    const tage = training.map((e) => e.start.toISOString().slice(0, 10));

    assert.deepEqual(tage, ['2026-09-18', '2026-10-02', '2026-10-09']);
    assert.ok(!tage.includes('2026-09-25'), 'EXDATE wurde nicht beachtet');
    assert.ok(training.every((e) => e.serie === true));
  });

  it('vergibt eindeutige IDs je Serieninstanz', async () => {
    const events = await ladeFixture('beispiel.ics');
    const ids = events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'IDs sind nicht eindeutig');
  });

  it('beschränkt Einzeltermine auf das angefragte Zeitfenster', async () => {
    const events = await ladeFixture('beispiel.ics', {
      from: new Date('2026-09-20T00:00:00Z'),
      to: new Date('2026-09-21T00:00:00Z'),
    });
    assert.deepEqual(
      events.map((e) => e.titel).sort(),
      ['Vereinssitzung', '[WA] Elternabend Klasse 4b'],
    );
  });
});

describe('ICS-Quelle: edge-cases.ics', () => {
  it('berücksichtigt RECURRENCE-ID-Overrides', async () => {
    const events = await ladeFixture('edge-cases.ics');
    const serie = events.filter((e) => e.uid === 'serie-override@chatendar.example');
    const verschoben = serie.find((e) => e.titel.includes('verschoben'));

    assert.equal(serie.length, 3);
    assert.ok(verschoben, 'verschobene Instanz fehlt');
    assert.equal(verschoben.ort, 'Raum 2');
    // 08.10.2026 20:15 Berlin (CEST) = 18:15 UTC
    assert.equal(verschoben.start.toISOString(), '2026-10-08T18:15:00.000Z');
  });

  it('hält die lokale Uhrzeit über die Zeitumstellung hinweg konstant', async () => {
    const events = await ladeFixture('edge-cases.ics');
    const serie = events.filter((e) => e.uid === 'dst@chatendar.example');
    const zeiten = serie.map((e) =>
      new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(e.start),
    );

    assert.equal(serie.length, 3);
    assert.deepEqual(zeiten, ['19:00', '19:00', '19:00']);
    // Die letzte Instanz liegt nach der Zeitumstellung -> andere UTC-Zeit.
    assert.equal(serie[2].start.toISOString(), '2026-10-30T18:00:00.000Z');
  });

  it('verkraftet Termine ohne SUMMARY', async () => {
    const events = await ladeFixture('edge-cases.ics');
    const ohneTitel = events.find((e) => e.uid === 'ohne-titel@chatendar.example');
    assert.equal(ohneTitel.titel, '(ohne Titel)');
  });
});

describe('Fehlerfälle', () => {
  it('meldet eine fehlende ICS-Datei klar', async () => {
    await assert.rejects(
      () => ladeFixture('gibt-es-nicht.ics'),
      /ICS-Datei nicht gefunden/,
    );
  });

  it('meldet, dass CalDAV noch nicht implementiert ist', async () => {
    const config = testConfig({ env: { SOURCE: 'caldav' } });
    await assert.rejects(() => fetchEvents(config, WEITES_FENSTER), /noch nicht implementiert/);
  });
});
