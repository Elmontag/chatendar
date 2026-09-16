import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSelected, selectEvents } from '../src/reminders/selector.js';
import { makeEvent, testConfig } from './helpers.js';

const config = testConfig();

describe('Terminselektion', () => {
  it('erkennt die Kategorie', () => {
    const event = makeEvent({ kategorien: ['Verein', 'WhatsApp'] });
    assert.equal(isSelected(event, config).selected, true);
  });

  it('vergleicht Kategorien ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    const event = makeEvent({ kategorien: [' whatsapp '] });
    assert.equal(isSelected(event, config).selected, true);
  });

  it('erkennt das Titel-Präfix', () => {
    const event = makeEvent({ titel: '[WA] Elternabend' });
    assert.equal(isSelected(event, config).selected, true);
  });

  it('verwirft unmarkierte Termine', () => {
    const event = makeEvent({ titel: 'Zahnarzt', kategorien: ['Privat'] });
    assert.equal(isSelected(event, config).selected, false);
  });

  it('nennt beide Gründe, wenn beide Merkmale zutreffen', () => {
    const event = makeEvent({ titel: '[WA] Chorprobe', kategorien: ['WhatsApp'] });
    assert.equal(isSelected(event, config).reasons.length, 2);
  });

  it('respektiert abgeschaltete Selektionswege', () => {
    const nurKategorie = testConfig({ env: { SELECT_BY_PREFIX: 'false' } });
    assert.equal(isSelected(makeEvent({ titel: '[WA] Test' }), nurKategorie).selected, false);

    const nurPraefix = testConfig({ env: { SELECT_BY_CATEGORY: 'false' } });
    assert.equal(isSelected(makeEvent({ kategorien: ['WhatsApp'] }), nurPraefix).selected, false);
  });
});

describe('selectEvents', () => {
  it('teilt in markiert und nicht markiert auf', () => {
    const events = [
      makeEvent({ id: 'a', titel: '[WA] A' }),
      makeEvent({ id: 'b', titel: 'B', kategorien: ['WhatsApp'] }),
      makeEvent({ id: 'c', titel: 'C' }),
    ];
    const { selected, rejected } = selectEvents(events, config);
    assert.deepEqual(selected.map((e) => e.id), ['a', 'b']);
    assert.deepEqual(rejected.map((e) => e.id), ['c']);
  });

  it('entfernt das Präfix aus dem Titel (STRIP_PREFIX=true)', () => {
    const { selected } = selectEvents([makeEvent({ titel: '[WA] Elternabend' })], config);
    assert.equal(selected[0].titel, 'Elternabend');
  });

  it('behält das Präfix bei STRIP_PREFIX=false', () => {
    const keep = testConfig({ env: { STRIP_PREFIX: 'false' } });
    const { selected } = selectEvents([makeEvent({ titel: '[WA] Elternabend' })], keep);
    assert.equal(selected[0].titel, '[WA] Elternabend');
  });

  it('verändert das Original-Termin-Objekt nicht', () => {
    const original = makeEvent({ titel: '[WA] Elternabend' });
    selectEvents([original], config);
    assert.equal(original.titel, '[WA] Elternabend');
  });
});
