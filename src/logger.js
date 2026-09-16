/**
 * Minimalistisches Konsolen-Logging.
 *
 * Bewusst ohne externe Abhängigkeit: für einen Cron-Lauf reicht ein
 * Zeitstempel + Level, damit die Ausgabe in journalctl/Logfiles lesbar bleibt.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;

/** Log-Level setzen ('debug' | 'info' | 'warn' | 'error'). */
export function setLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

function stamp() {
  return new Date().toISOString();
}

function emit(level, stream, args) {
  if (LEVELS[level] < currentLevel) return;
  stream(`[${stamp()}] ${level.toUpperCase().padEnd(5)}`, ...args);
}

export const log = {
  debug: (...args) => emit('debug', console.log, args),
  info: (...args) => emit('info', console.log, args),
  warn: (...args) => emit('warn', console.warn, args),
  error: (...args) => emit('error', console.error, args),
  /** Überschrift für einen Abschnitt – erleichtert das Lesen langer Läufe. */
  section: (title) => emit('info', console.log, [`── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`]),
};
