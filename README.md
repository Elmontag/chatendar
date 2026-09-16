# chatendar

Liest Termine aus einem Kalender, berücksichtigt konfigurierbare Vorlaufzeiten
pro Termin und schickt daraus Erinnerungen in eine WhatsApp-Gruppe. Mehrere
gleichzeitig fällige Termine werden zu **einer** Sammelnachricht gebündelt.

Das Tool führt pro Aufruf genau **einen** Durchlauf aus und beendet sich
danach. Die zeitliche Wiederholung übernimmt ein systemd-Timer oder ein
Cronjob – siehe [Automatisierung](#automatisierung).

## Eigenschaften

- **Kalenderquelle austauschbar** – aktuell lokale ICS-Datei, die Schnittstelle
  für CalDAV/Nextcloud ist vorbereitet
- **Gezielte Auswahl** – nur Termine, die per Kategorie (`WhatsApp`) und/oder
  Titel-Präfix (`[WA]`) markiert sind
- **Bis zu zwei Vorlaufzeiten pro Termin** – global konfigurierbar, pro Termin
  über `X-WA-REMIND` überschreibbar
- **Kein Doppelversand** – jede Kombination aus Termin und Vorlaufzeit-Stufe
  wird dauerhaft in SQLite vermerkt
- **Sammelnachrichten** – alles, was in einem Lauf zur selben Vorlaufzeit-Stufe
  fällig ist, landet in einer Nachricht
- **Frei konfigurierbare Templates** – inklusive bedingter Abschnitte
- **Dry-Run** – Nachrichten nur anzeigen, nichts senden (Default)
- **Serientermine** – RRULE, EXDATE und verschobene Einzeltermine werden
  korrekt aufgelöst, inklusive Sommer-/Winterzeit

## Voraussetzungen

- Node.js ≥ 20 (getestet mit 22 LTS)
- Ein WhatsApp-Konto, das per QR-Code als verknüpftes Gerät gekoppelt wird

## Setup

```bash
git clone https://github.com/Elmontag/chatendar.git
cd chatendar
npm install

cp .env.example .env
$EDITOR .env
```

Mindestens anzupassen sind `ICS_PATH` und – sobald wirklich gesendet werden
soll – `WHATSAPP_GROUP_ID` sowie `DRY_RUN=false`.

### 1. Trockenlauf

Zuerst ohne WhatsApp prüfen, ob die Termine richtig erkannt werden. Der
mitgelieferte Beispielkalender funktioniert ohne jede Konfiguration:

```bash
npm run dry-run -- --now=2026-09-19T17:00:00Z
```

Ausgabe:

```
── Lauf gestartet ────────────────────────────────────
Zeitpunkt: 2026-09-19 19:00 (Europe/Berlin) | Quelle: ICS-Datei | Modus: DRY-RUN (es wird nichts gesendet)
7 Termin(e) im Zeitfenster bis 2026-12-18 18:00 geladen
6 Termin(e) für WhatsApp markiert (Kategorie "WhatsApp" oder Präfix "[WA]"), 1 nicht markiert
3 Erinnerung(en) fällig, 5 übersprungen (noch-nicht-faellig: 5)
2 Sammelnachricht(en) aus 3 Erinnerung(en) gebaut
[DRY-RUN] Nachricht an … – 2 Termin(e), 1d vorher:
    │ 🔔 *Erinnerung* (1 Tag vorher) – 2 Termine:
    │
    │ • *Elternabend Klasse 4b*
    │   🗓 So., 20.09.2026, 18:30 Uhr
    │   📍 Aula der Grundschule
    │
    │ • *Vereinssitzung*
    │   🗓 So., 20.09.2026, 19:00 Uhr
    │   📍 Clubheim
[DRY-RUN] Nachricht an … – 1 Termin(e), 2h vorher:
    │ 🔔 *Erinnerung* (2 Stunden vorher)
    │
    │ *Chorprobe*
    │ 🗓 Sa., 19.09.2026, 21:00 Uhr
── Lauf beendet ──────────────────────────────────────
```

`--now` setzt den Referenzzeitpunkt und ist nur zum Testen gedacht; im
Normalbetrieb entfällt der Parameter.

### 2. WhatsApp koppeln (QR-Code)

```bash
npm run pair
```

Der QR-Code erscheint direkt im Terminal. In WhatsApp auf dem Handy:
**Einstellungen → Verknüpfte Geräte → Gerät verknüpfen** und den Code scannen.

Danach listet das Skript alle Gruppen mit ihrer ID auf:

```
120363012345678901@g.us   Familie
120363098765432109@g.us   Elternbeirat 4b
```

Die passende ID nach `WHATSAPP_GROUP_ID` in die `.env` übernehmen.

> **Wichtig:** Die Session liegt in `./auth_session` und erlaubt vollen Zugriff
> auf den gekoppelten WhatsApp-Account. Der Ordner ist in `.gitignore`
> eingetragen und sollte auf dem Server `chmod 700` bekommen. Die Kopplung ist
> einmalig – solange der Ordner erhalten bleibt, ist kein weiterer QR-Code
> nötig. Bei einem Backup den Ordner mitsichern.
>
> Ein Hinweis zum Risiko: Baileys nutzt das inoffizielle Multi-Device-Protokoll.
> Das ist für normale Gruppen der einzig praktikable Weg, verstößt aber gegen
> die WhatsApp-Nutzungsbedingungen. Ein eigener Account statt des privaten
> Hauptaccounts ist die sicherere Wahl.

### 3. Scharf schalten

```bash
# einmal live testen, ohne .env zu ändern
node src/index.js --live

# oder dauerhaft in der .env
DRY_RUN=false
```

## Termine im Kalender markieren

Nur markierte Termine werden verschickt. Beide Wege sind einzeln oder
gemeinsam nutzbar (`SELECT_BY_CATEGORY` / `SELECT_BY_PREFIX`); ein Treffer
genügt.

**Über die Kategorie** (in den meisten Kalender-Apps als „Kategorie“ oder
„Tag“ zu setzen):

```ics
BEGIN:VEVENT
UID:vereinssitzung@example.com
DTSTART;TZID=Europe/Berlin:20260920T190000
DTEND;TZID=Europe/Berlin:20260920T203000
SUMMARY:Vereinssitzung
LOCATION:Clubheim
CATEGORIES:WhatsApp,Verein
END:VEVENT
```

**Über das Titel-Präfix** – praktisch, wenn die Kalender-App keine Kategorien
kann. Das Präfix wird aus der Nachricht entfernt (`STRIP_PREFIX=true`):

```ics
BEGIN:VEVENT
UID:elternabend@example.com
DTSTART;TZID=Europe/Berlin:20260920T183000
DTEND;TZID=Europe/Berlin:20260920T200000
SUMMARY:[WA] Elternabend Klasse 4b
LOCATION:Aula der Grundschule
X-WA-REMIND:1d,2h
END:VEVENT
```

### Eigene Vorlaufzeiten pro Termin

`X-WA-REMIND` überschreibt `DEFAULT_REMINDERS` für genau diesen Termin:

```ics
X-WA-REMIND:1d,2h      → einen Tag und zwei Stunden vorher
X-WA-REMIND:1w         → eine Woche vorher
X-WA-REMIND:3d,45m     → drei Tage und 45 Minuten vorher
```

Einheiten: `w` (Wochen), `d` (Tage), `h` (Stunden), `m` (Minuten). Auch
zusammengesetzt (`1d12h`) oder als reine Minutenzahl (`90`). Mehr als
`MAX_REMINDERS` (Default 2) Angaben werden abgeschnitten, ein ungültiger Wert
führt zu einer Warnung und den Default-Vorlaufzeiten – der Lauf bricht nicht ab.

Ein vollständiger Beispielkalender liegt unter
[`test/fixtures/beispiel.ics`](test/fixtures/beispiel.ics) und enthält alle
Fälle: Kategorie, Präfix, eigene Vorlaufzeit, ganztägiger Termin, Serientermin
mit Ausnahme und einen nicht markierten Termin.

## Nachrichten anpassen

Templates sind reine Konfiguration (`.env` oder `config.json`). Platzhalter:

| Platzhalter      | Inhalt                                          |
| ---------------- | ----------------------------------------------- |
| `{titel}`        | Titel des Termins (ggf. ohne Präfix)            |
| `{datum}`        | `So., 20.09.2026`                               |
| `{datum_kurz}`   | `20.09.2026`                                    |
| `{wochentag}`    | `Sonntag`                                       |
| `{uhrzeit}`      | `18:30` – leer bei ganztägigen Terminen         |
| `{ort}`          | Ort des Termins                                 |
| `{ganztag}`      | `ganztägig` bei ganztägigen Terminen            |
| `{vorlauf}`      | `1 Tag`, `2 Stunden`                            |
| `{vorlauf_kurz}` | `1d`, `2h`                                      |
| `{items}`        | nur im Sammel-Template: die gerenderte Liste    |
| `{anzahl}`       | nur im Sammel-Template: Anzahl der Termine      |

Bedingte Abschnitte `{?platzhalter}…{/platzhalter}` erscheinen nur, wenn der
Platzhalter gefüllt ist. So entfällt die Ortszeile automatisch bei Terminen
ohne Ort:

```
TEMPLATE_SINGLE=🔔 *{titel}*\n🗓 {datum}{?uhrzeit} um {uhrzeit} Uhr{/uhrzeit}{?ort}\n📍 {ort}{/ort}
```

Es gibt drei Templates: `TEMPLATE_SINGLE` für einen einzelnen fälligen Termin,
`TEMPLATE_COLLECTION` für die Sammelnachricht und `TEMPLATE_COLLECTION_ITEM`
für jeden Eintrag darin. WhatsApp kennt `*fett*`, `_kursiv_` und
` ```Monospace``` `.

## Automatisierung

Das Tool bringt bewusst keinen eigenen Scheduler mit. Wichtig ist nur:
**`CHECK_WINDOW_MINUTES` muss mindestens so groß sein wie das Aufrufintervall**,
besser das Doppelte. Sonst kann eine Erinnerung zwischen zwei Läufen
durchrutschen und wird als `prueffenster-verpasst` verworfen.

### systemd-Timer (empfohlen)

`/etc/systemd/system/chatendar.service`:

```ini
[Unit]
Description=chatendar – Kalender-Erinnerungen nach WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=chatendar
WorkingDirectory=/opt/chatendar
ExecStart=/usr/bin/node /opt/chatendar/src/index.js
# Die Session muss beschreibbar bleiben:
ReadWritePaths=/opt/chatendar/auth_session /opt/chatendar/data
ProtectSystem=strict
PrivateTmp=true
NoNewPrivileges=true
```

`/etc/systemd/system/chatendar.timer`:

```ini
[Unit]
Description=chatendar alle 15 Minuten ausführen

[Timer]
OnCalendar=*:0/15
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
```

Aktivieren und prüfen:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chatendar.timer

systemctl list-timers chatendar.timer   # nächste Ausführung
journalctl -u chatendar.service -f      # Log mitlesen
sudo systemctl start chatendar.service  # sofort einmal ausführen
```

Passend dazu in der `.env`: `CHECK_WINDOW_MINUTES=30`.

### Cronjob (Alternative)

```cron
*/15 * * * * cd /opt/chatendar && /usr/bin/node src/index.js >> /var/log/chatendar.log 2>&1
```

Cron startet mit minimalem Environment – deshalb das `cd`, damit `.env`,
`auth_session/` und `data/` gefunden werden.

## Bedienung

```bash
node src/index.js [Optionen]
```

| Option           | Wirkung                                                     |
| ---------------- | ----------------------------------------------------------- |
| `--dry-run`      | Nachrichten nur anzeigen, nichts senden                      |
| `--live`         | Tatsächlich senden (überschreibt `DRY_RUN=true`)             |
| `--now <ISO>`    | Referenzzeitpunkt setzen, z. B. `2026-09-19T17:00:00Z`       |
| `--config <Pfad>`| Pfad zu einer `config.json`                                  |
| `--verbose`, `-v`| Ausführliches Logging                                        |
| `--quiet`, `-q`  | Nur Warnungen und Fehler                                     |
| `--help`, `-h`   | Hilfe                                                        |

Exit-Code `0` bei Erfolg, `1` bei Fehlern (Konfiguration, Kalender, Versand) –
für Monitoring auswertbar.

## Wie die Fälligkeit bestimmt wird

Der Versandzeitpunkt ist `Termin-Start − Vorlaufzeit`. Eine Erinnerung ist
fällig, wenn dieser Zeitpunkt im Prüffenster liegt:

```
jetzt − CHECK_WINDOW_MINUTES   ≤   Versandzeitpunkt   ≤   jetzt
```

Übersprungen wird mit einem dieser Gründe im Log:

| Grund                      | Bedeutung                                                     |
| -------------------------- | ------------------------------------------------------------- |
| `bereits-versendet`        | steht schon im State – wird nie erneut verschickt              |
| `noch-nicht-faellig`       | Versandzeitpunkt liegt in der Zukunft                          |
| `termin-bereits-gestartet` | der Termin läuft schon oder ist vorbei                         |
| `prueffenster-verpasst`    | Versandzeitpunkt liegt vor dem Fenster (Tool lief längere Zeit nicht) |

Das Fenster verhindert, dass nach einem Ausfall plötzlich alte Erinnerungen
nachgefeuert werden. Mit `CATCH_UP=true` wird stattdessen alles nachgeholt,
solange der Termin noch bevorsteht.

## State und Duplikatsvermeidung

Jede Kombination aus Termin-ID und Vorlaufzeit-Stufe wird in der SQLite-Tabelle
`sent_reminders` (`DB_PATH`) festgehalten. Bei Serienterminen enthält die ID den
Zeitpunkt der Instanz, damit jeder Termin einzeln gezählt wird.

Persistiert wird erst **nach** erfolgreichem Versand. Schlägt das Senden fehl,
bleibt die Erinnerung offen und wird beim nächsten Lauf erneut versucht.

Dry-Runs verändern den State standardmäßig nicht (`RECORD_DRY_RUN=false`), sind
also beliebig wiederholbar.

```bash
# Was wurde bereits verschickt?
sqlite3 data/reminders.db "SELECT event_title, offset_minutes, status, processed_at FROM sent_reminders ORDER BY processed_at DESC LIMIT 20;"

# Eine Erinnerung erneut zulassen
sqlite3 data/reminders.db "DELETE FROM sent_reminders WHERE event_id = 'elternabend@example.com';"
```

## Tests

```bash
npm test
```

Die Tests laufen ohne WhatsApp-Verbindung: ICS-Parsing, Selektion,
Vorlaufzeiten, Bündelung, Templates und State werden isoliert geprüft, dazu
ein kompletter Dry-Run als eigener Prozess gegen
`test/fixtures/beispiel.ics`.

## Projektstruktur

```
src/
  calendar/
    calendarSource.js     Interface + Registry der Quellen
    icsSource.js          ICS-Datei (node-ical), inkl. Serienauflösung
    caldavSource.js       Stub für CalDAV/Nextcloud
  reminders/
    selector.js           Terminselektion (Kategorie/Präfix)
    duration.js           Vorlaufzeiten parsen und formatieren
    scheduler.js          Versandzeitpunkte und Fälligkeit
    batching.js           Gruppierung je Vorlaufzeit-Stufe
  messaging/
    templateRenderer.js   Templates füllen
    whatsappClient.js     Baileys-Wrapper
  state/
    db.js                 SQLite-Zugriff
  util/
    datetime.js           Zeitzonen und Formatierung
  cli.js                  Argument-Parsing
  config.js               Konfiguration laden und validieren
  index.js                Einstiegspunkt für einen Durchlauf
  pair.js                 Einmalige WhatsApp-Kopplung
test/                     Tests und Beispiel-ICS-Dateien
auth_session/             Baileys-Session (gitignored)
data/                     SQLite-State (gitignored)
```

## CalDAV nachrüsten

Die Abstraktion steht, `SOURCE=caldav` ist bereits registriert. Zu tun ist nur:

1. `npm install tsdav`
2. `fetchEvents()` in `src/calendar/caldavSource.js` implementieren – die Datei
   enthält eine ausformulierte Umsetzungsskizze
3. Zurückgeben müssen die Termine die interne Struktur aus
   `src/calendar/calendarSource.js`

Am übrigen Code ändert sich nichts.

## Bekannte Grenzen

- Eine Zielgruppe pro Installation (`WHATSAPP_GROUP_ID`)
- CalDAV noch nicht implementiert
- Kein interner Scheduler – Aufruf erfolgt extern
- Verschobene Serientermine werden nur erkannt, wenn die ursprüngliche
  Instanz im Abfragefenster liegt
- Baileys nutzt das inoffizielle WhatsApp-Protokoll (siehe Hinweis oben)

## Lizenz

MIT
