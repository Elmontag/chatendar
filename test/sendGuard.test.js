import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createSendGuard, PersistentDailyLimiter } from '../src/messaging/sendGuard.js';

class AllowDailyLimiter {
  check() {
    return { allowed: true };
  }
  record() {}
}

function config(overrides = {}) {
  return {
    antibanEnabled: true,
    authDir: path.resolve('test-auth'),
    sendDelayMs: 1500,
    sendDelayMaxMs: 7000,
    whatsappTargets: [
      { enabled: true },
      { enabled: true },
      { enabled: true },
      { enabled: true },
    ],
    ...overrides,
  };
}

describe('WhatsApp-Sendeschutz', () => {
  it('konfiguriert den erwarteten Fan-out und wartet vor dem Senden', async () => {
    const calls = [];
    let limiterConfig;
    class FakeRateLimiter {
      constructor(value) {
        limiterConfig = value;
      }
      async getDelay(jid, text) {
        calls.push(['check', jid, text]);
        return 42;
      }
      record(jid, text) {
        calls.push(['record', jid, text]);
      }
    }
    class FakeCoordinator {
      tryAcquireSlot() {
        calls.push(['slot']);
        return { allowed: true };
      }
    }
    class FakeHealth {
      isPaused() {
        return false;
      }
      recordMessageFailed() {}
      recordDisconnect() {}
      recordReconnect() {}
    }
    const guard = createSendGuard(config(), {
      RateLimiterClass: FakeRateLimiter,
      InstanceCoordinatorClass: FakeCoordinator,
      HealthMonitorClass: FakeHealth,
      DailyLimiterClass: AllowDailyLimiter,
      sleep: async (ms) => calls.push(['sleep', ms]),
    });

    const result = await guard.send('4915112345678@s.whatsapp.net', 'Hallo', async () => {
      calls.push(['send']);
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(limiterConfig.maxIdenticalMessages, 4);
    assert.deepEqual(calls, [
      ['check', '4915112345678@s.whatsapp.net', 'Hallo'],
      ['slot'],
      ['sleep', 42],
      ['send'],
      ['record', '4915112345678@s.whatsapp.net', 'Hallo'],
    ]);
  });

  it('meldet Schutzblockaden explizit und sendet nicht', async () => {
    class BlockingRateLimiter {
      async getDelay() {
        return -1;
      }
    }
    class FakeCoordinator {
      tryAcquireSlot() {
        return { allowed: true };
      }
    }
    class FakeHealth {
      isPaused() {
        return false;
      }
      recordDisconnect() {}
      recordReconnect() {}
    }
    const guard = createSendGuard(config(), {
      RateLimiterClass: BlockingRateLimiter,
      InstanceCoordinatorClass: FakeCoordinator,
      HealthMonitorClass: FakeHealth,
      DailyLimiterClass: AllowDailyLimiter,
    });

    it('wartet bei einem belegten accountweiten Slot und versucht ihn erneut', async () => {
      const sleeps = [];
      class FakeRateLimiter {
        async getDelay() {
          return 10;
        }
        record() {}
      }
      class WaitingCoordinator {
        calls = 0;
        tryAcquireSlot() {
          this.calls += 1;
          return this.calls === 1 ? { allowed: false, retryAfterMs: 50 } : { allowed: true };
        }
      }
      class FakeHealth {
        isPaused() {
          return false;
        }
        recordMessageFailed() {}
        recordDisconnect() {}
        recordReconnect() {}
      }
      const guard = createSendGuard(config(), {
        RateLimiterClass: FakeRateLimiter,
        InstanceCoordinatorClass: WaitingCoordinator,
        HealthMonitorClass: FakeHealth,
        DailyLimiterClass: AllowDailyLimiter,
        sleep: async (ms) => sleeps.push(ms),
      });

      assert.equal(await guard.send('jid', 'Text', async () => 'ok'), 'ok');
      assert.deepEqual(sleeps, [50]);
    });
    let sent = false;

    await assert.rejects(
      guard.send('4915112345678@s.whatsapp.net', 'Hallo', async () => {
        sent = true;
      }),
      /Antiban-Schutz blockiert/,
    );
    assert.equal(sent, false);
  });

  it('lässt sich vollständig deaktivieren', async () => {
    const guard = createSendGuard(config({ antibanEnabled: false }), {
      RateLimiterClass: class {
        constructor() {
          throw new Error('darf nicht initialisiert werden');
        }
      },
    });
    assert.equal(await guard.send('jid', 'Text', async () => 'gesendet'), 'gesendet');
  });

  it('bewahrt das Tageslimit über neue Instanzen hinweg', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatendar-antiban-test-'));
    const filePath = path.join(dir, 'daily.json');
    try {
      const first = new PersistentDailyLimiter({ filePath, maxPerDay: 1 });
      assert.equal(first.check().allowed, true);
      first.record();

      const second = new PersistentDailyLimiter({ filePath, maxPerDay: 1 });
      assert.equal(second.check().allowed, false);
      assert.ok(second.check().retryAfterMs > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
