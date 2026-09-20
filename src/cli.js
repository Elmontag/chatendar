/**
 * Einfaches CLI-Argument-Parsing (ohne Abhängigkeit).
 */

export const USAGE = `
chatendar – Kalender-Erinnerungen in eine WhatsApp-Gruppe

Aufruf:
  node src/index.js [Optionen]

Optionen:
  --preview [Tage]     Nur anzeigen, was ansteht und wann es verschickt wird
                       (Default 14 Tage). Sendet nichts, ändert nichts.
  --dry-run            Nachrichten nur anzeigen, nichts senden (überschreibt DRY_RUN)
  --live               Tatsächlich senden (überschreibt DRY_RUN=true)
  --keepalive          Nur WhatsApp verbinden und wieder schließen (hält die Session in
                       Benutzung, sendet nichts, lädt keinen Kalender)
  --now <ISO-Zeit>     Referenzzeitpunkt für den Lauf (z. B. 2026-09-19T18:00:00Z) – zum Testen
  --config <Pfad>      Pfad zu einer config.json
  --verbose, -v        Ausführliches Logging (Log-Level debug)
  --quiet, -q          Nur Warnungen und Fehler
  --help, -h           Diese Hilfe

Exit-Codes:
  0  Lauf erfolgreich
  1  Fehler (Konfiguration, Kalender, Versand, Keepalive)
`.trim();

/**
 * @param {string[]} argv typischerweise process.argv.slice(2)
 * @returns {{overrides: object, now: Date|null, configFile: string|null, logLevel: string|null, help: boolean}}
 */
export function parseArgs(argv) {
  const result = { overrides: {}, now: null, configFile: null, logLevel: null, help: false, preview: null, keepalive: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // Sowohl "--option wert" als auch "--option=wert" unterstützen.
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const nextValue = () => {
      if (inlineValue !== null) return inlineValue;
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${flag} erwartet einen Wert`);
      }
      i += 1;
      return value;
    };

    switch (flag) {
      case '--preview':
      case '--vorschau': {
        // Tagesangabe ist optional: --preview, --preview 30, --preview=30
        let tage = inlineValue;
        if (tage === null && /^\d+$/.test(argv[i + 1] ?? '')) {
          tage = argv[i + 1];
          i += 1;
        }
        const parsed = Number.parseInt(tage ?? '14', 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`--preview erwartet eine Anzahl Tage (ist: "${tage}")`);
        }
        result.preview = parsed;
        break;
      }
      case '--keepalive':
        result.keepalive = true;
        break;
      case '--dry-run':
        result.overrides.dryRun = true;
        break;
      case '--live':
      case '--no-dry-run':
        result.overrides.dryRun = false;
        break;
      case '--now': {
        const value = nextValue();
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) throw new Error(`--now ist kein gültiges Datum: "${value}"`);
        result.now = parsed;
        break;
      }
      case '--config':
        result.configFile = nextValue();
        break;
      case '--verbose':
      case '-v':
        result.logLevel = 'debug';
        break;
      case '--quiet':
      case '-q':
        result.logLevel = 'warn';
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`Unbekannte Option: ${arg}\n\n${USAGE}`);
    }
  }

  return result;
}
