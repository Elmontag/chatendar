import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  digestRange,
  digestStateKey,
  evaluateDigest,
  eventsInRange,
  lastScheduledInstant,
  nextScheduledInstant,
  parseTimeOfDay,
  parseWeekday,
} from '../src/reminders/digest.js';
import { buildDigestMessage, formatRangeLabel } from '../src/messaging/templateRenderer.js';
import { makeEvent, testConfig } from './helpers.js';

/** Config mit aktivierter Wochenübersicht. */
function digestConfig(env = {}) {
  return testConfig({ env: { DIGEST_ENABLED: 'true', DIGEST_DAY: 'fr', DIGEST_TIME: '18:00', ...env } });
}

describe('parseWeekday', () => {
  it('versteht deutsche und englische Schreibweisen', () => {
    assert.equal(parseWeekday('fr'), 5);
    assert.equal(parseWeekday('Freitag'), 5);
    assert.equal(parseWeekday('friday'), 5);
    assert.equal(parseWeekday('SO'), 0);
    assert.equal(parseWeekday('Sonntag'), 0);
    assert.equal(parseWeekday(1), 1);
  });

  it('lehnt Unsinn ab', () => {
    assert.throws(() => parseWeekday('Freitagabend'), /Unbekannter Wochentag/);
    assert.throws(() => parseWeekday('9'), /Unbekannter Wochentag/);
  });
});

describe('parseTimeOfDay', () => {
  it('parst HH:MM', () => {
    assert.deepEqual(parseTimeOfDay('18:00'), { hour: 18, minute: 0 });
    assert.deepEqual(parseTimeOfDay('7:30'), { hour: 7, minute: 30 });
    assert.deepEqual(parseTimeOfDay('9'), { hour: 9, minute: 0 });
  });

  it('lehnt ungültige Zeiten ab', () => {
    assert.throws(() => parseTimeOfDay('25:00'), /Ungültige Uhrzeit/);
    assert.throws(() => parseTimeOfDay('18:70'), /Ungültige Uhrzeit/);
    assert.throws(() => parseTimeOfDay('abends'), /Ungültige Uhrzeit/);
  });
});

describe('lastScheduledInstant', () => {
  const config = digestConfig();

  it('findet den Versandzeitpunkt am Tag selbst', () => {
    // Freitag, 18.09.2026, 20:00 Berlin -> Versand war heute um 18:00
    const now = new Date('2026-09-18T18:00:00Z');
    assert.equal(lastScheduledInstant(now, config).toISOString(), '2026-09-18T16:00:00.000Z');
  });

  it('geht eine Woche zurück, wenn die Uhrzeit noch nicht erreicht ist', () => {
    // Freitag, 18.09.2026, 10:00 Berlin -> der letzte Versand war Freitag davor
    const now = new Date('2026-09-18T08:00:00Z');
    assert.equal(lastScheduledInstant(now, config).toISOString(), '2026-09-11T16:00:00.000Z');
  });

  it('findet den letzten Freitag von einem Mittwoch aus', () => {
    const now = new Date('2026-09-16T21:00:00Z'); // Mittwoch
    assert.equal(lastScheduledInstant(now, config).toISOString(), '2026-09-11T16:00:00.000Z');
  });

  it('hält die lokale Uhrzeit über die Zeitumstellung hinweg', () => {
    const sonntags = digestConfig({ DIGEST_DAY: 'so', DIGEST_TIME: '18:00' });
    // Sommerzeit (CEST, UTC+2)
    const sommer = lastScheduledInstant(new Date('2026-10-25T20:00:00Z'), sonntags);
    // Winterzeit (CET, UTC+1) – Umstellung war am 25.10.2026
    const winter = lastScheduledInstant(new Date('2026-11-01T20:00:00Z'), sonntags);

    assert.equal(sommer.toISOString(), '2026-10-25T17:00:00.000Z');
    assert.equal(winter.toISOString(), '2026-11-01T17:00:00.000Z');
    for (const instant of [sommer, winter]) {
      const lokal = new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
      }).format(instant);
      assert.equal(lokal, '18:00');
    }
  });

  it('nextScheduledInstant liegt genau eine Woche später', () => {
    const now = new Date('2026-09-16T21:00:00Z');
    const naechster = nextScheduledInstant(now, config);
    assert.equal(naechster.toISOString(), '2026-09-18T16:00:00.000Z');
    assert.ok(naechster > now);
  });
});

describe('digestRange', () => {
  const scheduledAt = new Date('2026-09-18T16:00:00Z'); // Freitag 18:00 Berlin

  it('rollierend ab dem Versandzeitpunkt (7d)', () => {
    const { from, to } = digestRange(scheduledAt, digestConfig({ DIGEST_RANGE: '7d' }));
    assert.equal(from.toISOString(), '2026-09-18T16:00:00.000Z');
    assert.equal(to.toISOString(), '2026-09-25T16:00:00.000Z');
  });

  it('erlaubt andere Zeiträume (14d)', () => {
    const { to } = digestRange(scheduledAt, digestConfig({ DIGEST_RANGE: '14d' }));
    assert.equal(to.toISOString(), '2026-10-02T16:00:00.000Z');
  });

  it('nächste Kalenderwoche = Montag bis Sonntag', () => {
    const { from, to } = digestRange(scheduledAt, digestConfig({ DIGEST_RANGE: 'next-week' }));
    // Montag, 21.09.2026, 00:00 Berlin = 20.09. 22:00 UTC
    assert.equal(from.toISOString(), '2026-09-20T22:00:00.000Z');
    assert.equal(to.toISOString(), '2026-09-27T22:00:00.000Z');
  });

  it('bei Versand am Montag ist die nächste Woche die übernächste', () => {
    const montags = digestConfig({ DIGEST_DAY: 'mo', DIGEST_RANGE: 'next-week' });
    const montag = new Date('2026-09-21T16:00:00Z'); // Montag 18:00 Berlin
    const { from } = digestRange(montag, montags);
    assert.equal(from.toISOString(), '2026-09-27T22:00:00.000Z'); // Montag, 28.09.
  });
});

describe('evaluateDigest', () => {
  const config = digestConfig();

  it('ist am Versandzeitpunkt fällig', () => {
    const now = new Date('2026-09-18T16:10:00Z'); // 10 min danach
    const digest = evaluateDigest(config, { now });
    assert.equal(digest.due, true);
    assert.equal(digest.reason, 'faellig');
  });

  it('ist nicht fällig, wenn sie diese Woche schon raus ist', () => {
    const now = new Date('2026-09-18T16:10:00Z');
    const digest = evaluateDigest(config, { now, isSent: () => true });
    assert.equal(digest.due, false);
    assert.equal(digest.reason, 'bereits-versendet');
  });

  it('feuert nicht mitten in der Woche nach', () => {
    const now = new Date('2026-09-20T12:00:00Z'); // Sonntag
    assert.equal(evaluateDigest(config, { now }).reason, 'prueffenster-verpasst');
  });

  it('holt sie mit CATCH_UP=true nach', () => {
    const now = new Date('2026-09-20T12:00:00Z');
    const digest = evaluateDigest(digestConfig({ CATCH_UP: 'true' }), { now });
    assert.equal(digest.due, true);
  });

  it('meldet "deaktiviert", wenn DIGEST_ENABLED=false', () => {
    const now = new Date('2026-09-18T16:10:00Z');
    const digest = evaluateDigest(testConfig(), { now });
    assert.equal(digest.due, false);
    assert.equal(digest.reason, 'deaktiviert');
  });

  it('nutzt pro Woche einen eigenen State-Schlüssel', () => {
    const dieseWoche = evaluateDigest(config, { now: new Date('2026-09-18T16:10:00Z') });
    const naechsteWoche = evaluateDigest(config, { now: new Date('2026-09-25T16:10:00Z') });
    assert.notEqual(dieseWoche.stateKey, naechsteWoche.stateKey);
    assert.equal(dieseWoche.stateKey, digestStateKey(dieseWoche.scheduledAt));
  });
});

describe('eventsInRange', () => {
  const range = { from: new Date('2026-09-21T00:00:00Z'), to: new Date('2026-09-28T00:00:00Z') };

  it('filtert auf den Zeitraum und sortiert chronologisch', () => {
    const events = [
      makeEvent({ id: 'spaet', titel: 'Spät', start: new Date('2026-09-25T10:00:00Z') }),
      makeEvent({ id: 'davor', titel: 'Davor', start: new Date('2026-09-20T10:00:00Z') }),
      makeEvent({ id: 'frueh', titel: 'Früh', start: new Date('2026-09-22T10:00:00Z') }),
      makeEvent({ id: 'danach', titel: 'Danach', start: new Date('2026-09-29T10:00:00Z') }),
    ];
    assert.deepEqual(eventsInRange(events, range).map((e) => e.titel), ['Früh', 'Spät']);
  });

  it('behandelt das Ende als exklusiv', () => {
    const events = [makeEvent({ start: range.to })];
    assert.equal(eventsInRange(events, range).length, 0);
  });
});

describe('Nachricht der Wochenübersicht', () => {
  const config = digestConfig();
  const range = { from: new Date('2026-09-20T22:00:00Z'), to: new Date('2026-09-27T22:00:00Z') };

  it('listet alle Termine auf', () => {
    const events = [
      makeEvent({ id: 'a', titel: 'Elternabend', ort: 'Aula', start: new Date('2026-09-21T15:00:00Z') }),
      makeEvent({ id: 'b', titel: 'Training', start: new Date('2026-09-25T17:00:00Z') }),
    ];
    const text = buildDigestMessage(events, range, config);

    assert.match(text, /Termine der kommenden Woche/);
    assert.match(text, /In 4 Tagen, 21\.09\.2026/);
    assert.match(text, /Elternabend/);
    assert.match(text, /Aula/);
    assert.match(text, /In 8 Tagen, 25\.09\.2026/);
    assert.match(text, /Training/);
  });

  it('kommt mit ganztägigen Terminen klar', () => {
    const events = [makeEvent({ titel: 'Sommerfest', ganztags: true, start: new Date('2026-09-22T22:00:00Z') })];
    const text = buildDigestMessage(events, range, config);
    assert.doesNotMatch(text, /ganztägig/);
    assert.doesNotMatch(text, /Uhr/);
  });

  it('fasst mehrtägige Termine in einer Zeile zusammen', () => {
    const events = [
      makeEvent({
        titel: 'Klassenfahrt',
        start: new Date('2026-09-21T08:00:00Z'),
        ende: new Date('2026-09-23T14:00:00Z'),
      }),
    ];
    const text = buildDigestMessage(events, range, config, new Date('2026-09-20T08:00:00Z'));

    assert.match(text, /Morgen bis In 3 Tagen/);
    assert.match(text, /21\.09\.2026–23\.09\.2026/);
    assert.match(text, /10:00–16:00 Uhr/);
    assert.equal((text.match(/Klassenfahrt/g) ?? []).length, 1);
  });

  it('nutzt das Leer-Template ohne Termine', () => {
    assert.match(buildDigestMessage([], range, config), /Keine Termine/);
  });

  it('formatiert das Zeitraum-Label mit exklusivem Ende', () => {
    assert.equal(formatRangeLabel(range, config), '21.09. – 27.09.2026');
  });

  it('respektiert eigene Templates', () => {
    const eigenes = digestConfig({
      TEMPLATE_DIGEST: 'Woche {zeitraum}: {anzahl}\\n{items}',
      TEMPLATE_DIGEST_ITEM: '- {titel}',
    });
    const events = [makeEvent({ titel: 'Test', start: new Date('2026-09-21T15:00:00Z') })];
    assert.equal(buildDigestMessage(events, range, eigenes), 'Woche 21.09. – 27.09.2026: 1\n- Test');
  });
});
