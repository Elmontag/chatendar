import fs from 'node:fs';
import path from 'node:path';

import { HealthMonitor, InstanceCoordinator, RateLimiter } from 'baileys-antiban';

import { log } from '../logger.js';

const DEFAULT_LIMITS = Object.freeze({
  maxPerMinute: 5,
  maxPerHour: 100,
  maxPerDay: 800,
  maxDelayMs: 7000,
  newChatDelayMs: 4000,
  identicalMessageWindowMs: 60 * 60 * 1000,
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PersistentDailyLimiter {
  constructor({ filePath, maxPerDay }) {
    this.filePath = filePath;
    this.maxPerDay = maxPerDay;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  currentSends(now = Date.now()) {
    if (!fs.existsSync(this.filePath)) return [];
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Antiban-Tagesstatus konnte nicht gelesen werden: ${error.message}`);
    }
    if (!Array.isArray(state?.sends) || state.sends.some((value) => !Number.isFinite(value))) {
      throw new Error('Antiban-Tagesstatus ist ungültig; Datei prüfen oder gezielt entfernen');
    }
    const cutoff = now - 24 * 60 * 60 * 1000;
    return state.sends.filter((timestamp) => timestamp > cutoff);
  }

  check(now = Date.now()) {
    const sends = this.currentSends(now);
    if (sends.length < this.maxPerDay) return { allowed: true };
    return {
      allowed: false,
      retryAfterMs: Math.max(1000, Math.min(...sends) + 24 * 60 * 60 * 1000 - now),
    };
  }

  record(now = Date.now()) {
    const sends = [...this.currentSends(now), now];
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sends }), 'utf8');
    fs.renameSync(temporary, this.filePath);
  }
}

export function createSendGuard(
  config,
  {
    RateLimiterClass = RateLimiter,
    InstanceCoordinatorClass = InstanceCoordinator,
    HealthMonitorClass = HealthMonitor,
    DailyLimiterClass = PersistentDailyLimiter,
    sleep = delay,
  } = {},
) {
  if (!config.antibanEnabled) {
    return {
      async send(_jid, _text, operation) {
        return operation();
      },
      onDisconnect() {},
      onReconnect() {},
    };
  }

  const activeTargets = (config.whatsappTargets ?? []).filter((target) => target.enabled).length;
  const rateLimiter = new RateLimiterClass({
    maxPerMinute: DEFAULT_LIMITS.maxPerMinute,
    maxPerHour: DEFAULT_LIMITS.maxPerHour,
    maxPerDay: DEFAULT_LIMITS.maxPerDay,
    minDelayMs: config.sendDelayMs,
    maxDelayMs: Math.max(config.sendDelayMaxMs, config.sendDelayMs),
    newChatDelayMs: DEFAULT_LIMITS.newChatDelayMs,
    maxIdenticalMessages: Math.max(3, activeTargets),
    burstAllowance: 3,
    identicalMessageWindowMs: DEFAULT_LIMITS.identicalMessageWindowMs,
  });
  const coordinator = new InstanceCoordinatorClass({
    sharedFilePath: path.join(config.authDir, 'chatendar-antiban-rate.json'),
    poolMaxPerMinute: DEFAULT_LIMITS.maxPerMinute,
    poolMaxPerHour: DEFAULT_LIMITS.maxPerHour,
    staleThresholdMs: 60 * 60 * 1000,
  });
  const dailyLimiter = new DailyLimiterClass({
    filePath: path.join(config.authDir, 'chatendar-antiban-daily.json'),
    maxPerDay: DEFAULT_LIMITS.maxPerDay,
  });
  const health = new HealthMonitorClass({
    autoPauseAt: 'medium',
    onRiskChange(status) {
      const message = `WhatsApp-Schutzstatus ${status.risk} (${status.score}): ${status.recommendation}`;
      if (status.risk === 'low') log.debug(message);
      else log.warn(message);
    },
  });
  let sendLock = Promise.resolve();

  return {
    send(jid, text, operation) {
      const pending = sendLock.then(async () => {
        if (health.isPaused()) {
          const status = health.getStatus();
          throw new Error(`Versand durch Antiban-Schutz pausiert: ${status.recommendation}`);
        }

        const waitMs = await rateLimiter.getDelay(jid, text);
        if (waitMs < 0) {
          throw new Error('Versand durch Antiban-Schutz blockiert: Rate-Limit oder identische Nachrichten');
        }
        const daily = dailyLimiter.check();
        if (!daily.allowed) {
          throw new Error(
            `Versand durch tägliches Antiban-Limit blockiert; frühestens in ${Math.ceil((daily.retryAfterMs ?? 0) / 1000)}s erneut versuchen`,
          );
        }

        let slot = coordinator.tryAcquireSlot();
        const coordinatorWaitMs = slot.allowed ? 0 : (slot.retryAfterMs ?? 1000);
        const totalWaitMs = Math.max(waitMs, coordinatorWaitMs);
        if (totalWaitMs > 0) {
          log.debug(`Antiban-Sendeabstand: ${totalWaitMs} ms vor Nachricht an ${jid}`);
          await sleep(totalWaitMs);
        }
        if (!slot.allowed) {
          slot = coordinator.tryAcquireSlot();
          if (!slot.allowed) {
            throw new Error(
              `Versand durch accountweites Rate-Limit blockiert; frühestens in ${Math.ceil((slot.retryAfterMs ?? 0) / 1000)}s erneut versuchen`,
            );
          }
        }

        try {
          const result = await operation();
          rateLimiter.record(jid, text);
          try {
            dailyLimiter.record();
          } catch (error) {
            log.error(`Antiban-Tagesstatus konnte nach erfolgreichem Versand nicht gespeichert werden: ${error.message}`);
          }
          return result;
        } catch (error) {
          health.recordMessageFailed(error?.message ?? String(error));
          throw error;
        }
      });
      sendLock = pending.catch(() => {});
      return pending;
    },

    onDisconnect(reason) {
      health.recordDisconnect(reason ?? 'unbekannt');
    },

    onReconnect() {
      health.recordReconnect();
    },
  };
}
