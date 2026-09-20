# chatendar

Liest Termine aus einem Kalender, berücksichtigt konfigurierbare Vorlaufzeiten
pro Termin und schickt daraus Erinnerungen an WhatsApp-Gruppen oder
Einzelpersonen. Mehrere
gleichzeitig fällige Termine werden zu **einer** Sammelnachricht gebündelt.

Das Tool führt pro Aufruf genau **einen** Durchlauf aus und beendet sich
danach. Die zeitliche Wiederholung übernimmt ein systemd-Timer oder ein
Cronjob – siehe [Automatisierung](#automatisierung).

## Eigenschaften

- **Mehrere Kalenderprofile** – jeder Kalender hat seinen eigenen vollständigen
  Einstellungsstack
- **Mehrere WhatsApp-Ziele pro Profil** – dieselbe Profilnachricht kann an
  Gruppen und Einzelpersonen gehen
- **Konservativer Sendeschutz** – `baileys-antiban` begrenzt und verteilt
  ausgehende Nachrichten zeitlich, ohne deren Inhalt zu verändern
- **Verlässlicher Versand** – nach dem Senden bleibt die Verbindung offen, bis der
  Empfänger die Nachricht bestätigt hat; Entschlüsselungs-Retries werden beantwortet
- **Session-Pflege** – Keepalive-Verbindung bei langen Sendepausen, atomar
  geschriebene Zugangsdaten und automatische Sicherungen der Kopplung, siehe
  [Session-Pflege](#session-pflege)
- **Kalenderquelle austauschbar** – lokale ICS-Datei oder CalDAV/Nextcloud
- **Gezielte Auswahl** – nur Termine, die per Kategorie (`WhatsApp`) und/oder
  Titel-Präfix (`[WA]`) markiert sind; abschaltbar, dann zählen alle Termine
- **Bis zu zwei Vorlaufzeiten pro Termin** – global konfigurierbar, pro Termin
  über `X-WA-REMIND` überschreibbar
- **Kein Doppelversand** – jede Kombination aus Profil, WhatsApp-Ziel, Termin und
  Vorlaufzeit-Stufe wird dauerhaft in SQLite vermerkt
- **Sammelnachrichten** – alles, was in einem Lauf zur selben Vorlaufzeit-Stufe
  fällig ist, landet in einer Nachricht
- **Wochenübersicht** – zu einem festen Wochentermin (z. B. freitags 18:00)
  eine Liste aller Termine der kommenden Woche
- **Vorschau-Modus** – zeigt, was wann rausgeht, ohne zu senden
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
soll – `WHATSAPP_GROUP_ID` oder `WHATSAPP_PHONE` sowie `DRY_RUN=false`.

### Konfigurationsformen

Die klassische Top-Level-Konfiguration bleibt vollständig kompatibel. Sie wird
intern als ein implizites Profil mit der ID `default` behandelt:

```ini
SOURCE=file
ICS_PATH=./calendar.ics
WHATSAPP_GROUP_ID=120363000000000000@g.us
DRY_RUN=true
```

Für den direkten Versand an eine einzelne Person kann stattdessen eine
internationale Telefonnummer angegeben werden:

```ini
WHATSAPP_PHONE=+4915112345678
```

Für mehrere Kalender werden stattdessen explizite `profiles[]` in
`config.json` verwendet. Ein Profil ist eine vollständige, unabhängige
Konfiguration: Kalenderquelle, Selektion, Vorlaufzeiten, Templates,
Wochenübersicht, State-Datei und `whatsappTargets[]` gehören jeweils zum Profil.
Profile mit `enabled: false` werden übersprungen.

Alternativ kann die Konfiguration über eine lokale Web-Oberfläche gepflegt
werden. Sie schreibt primär `config.json`; Werte aus `.env` haben weiterhin
Vorrang und eignen sich für lokale Secrets:

```bash
npm run settings
```

Danach im Browser `http://127.0.0.1:3876` öffnen. Für einen
[abgesicherten Zugriff aus dem lokalen Netzwerk](#sicherer-zugriff-aus-dem-lokalen-netzwerk)
kann der Listener ausdrücklich an die private Server-IP gebunden werden. Die
Oberfläche bietet gruppierte Einstellungen, Template-Editoren mit Vorschau,
Validierung sowie Preview- und Dry-Run-Aktionen. Kalenderprofile lassen sich
dort anlegen, kopieren, aktivieren oder löschen und ihre WhatsApp-Ziele
hinzufügen, aktivieren oder entfernen. In der Profilverwaltung lassen sich die
Gruppen der gekoppelten WhatsApp-Session über „WhatsApp-Gruppen laden“
auslesen und ausgewählte Einträge doppelungsfrei ins Profil übernehmen.
Außerdem kann dort der gespeicherte Versand-State nur für das ausgewählte
Profil geleert werden, z. B. nach Tests mit einer Testgruppe. Live-Versand wird
dort nicht ausgelöst.

### Mehrere Kalender und WhatsApp-Ziele

Die bisherigen Top-Level-Einstellungen bleiben gültig und werden als ein
implizites Standardprofil ausgeführt. Für mehrere Kalender wird in
`config.json` stattdessen `profiles[]` verwendet. Jedes Profil enthält seinen
eigenen vollständigen Einstellungsstack: Quelle, Selektion, Vorlaufzeiten,
Templates, Wochenübersicht, State-Pfad und WhatsApp-Ziele.

```json
{
  "profiles": [
    {
      "id": "schule",
      "name": "Schulkalender",
      "enabled": true,
      "source": "caldav",
      "caldav": {
        "url": "https://cloud.example.test/remote.php/dav",
        "username": "user@example.test",
        "password": "app-passwort",
        "calendar": "Schule"
      },
      "selectByCategory": true,
      "selectCategory": "WhatsApp",
      "defaultReminders": "1d",
      "templateSingle": "Kurzer Reminder: *{titel}*\\n🗓 {tagesbereich_relativ}, {datumsbereich}{?termin_zeit} um {termin_zeit}{/termin_zeit}",
      "whatsappTargets": [
        { "type": "group", "id": "120363000000000001@g.us", "name": "Eltern Klasse 3", "enabled": true },
        { "type": "person", "phone": "+4915112345678", "name": "Klassenleitung", "enabled": true }
      ],
      "dbPath": "./data/schule.db"
    },
    {
      "id": "verein",
      "name": "Vereinskalender",
      "enabled": true,
      "source": "file",
      "icsPath": "./verein.ics",
      "selectByCategory": false,
      "selectByPrefix": false,
      "whatsappTargets": [
        { "type": "group", "id": "120363000000000003@g.us", "name": "Verein", "enabled": true }
      ],
      "dbPath": "./data/verein.db"
    }
  ]
}
```

Alle aktivierten Ziele in einem Profil erhalten denselben gerenderten
Nachrichtentext. Zielspezifische Templates oder eigene Selektionsregeln sind
bewusst nicht Teil dieser Variante; dafür ein separates Profil anlegen.

Die Gruppen-ID lässt sich nach `npm run pair` aus der Gruppenliste übernehmen.
Personen werden mit internationaler Telefonnummer gepflegt; Chatendar prüft
vor dem Live-Versand, ob die Nummer bei WhatsApp registriert ist.
In der Settings-Oberfläche können Profile angelegt, kopiert, aktiviert oder
gelöscht und die Gruppen je Profil verwaltet werden. Die Oberfläche speichert
`config.json`; die eigentliche WhatsApp-Kopplung bleibt bei `npm run pair`.

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

### 1a. Wenn nichts passiert: `--preview`

Ein normaler Lauf sendet nur, was **genau jetzt** fällig ist. Das Prüffenster
ist im Betrieb nur Minuten breit – ein einzelner Testlauf trifft also fast nie
etwas, und die Ausgabe endet mit „Nichts zu senden“. Das ist der Normalfall,
kein Fehler.

Um zu sehen, ob die Konfiguration stimmt, gibt es den Vorschau-Modus. Er
sendet nichts und verändert den State nicht:

```bash
node src/index.js --preview        # nächste 14 Tage
node src/index.js --preview 60     # nächste 60 Tage
```

```
── Vorschau: die nächsten 14 Tage ────────────────────
Zeitpunkt: 2026-09-16 23:35 (Europe/Berlin) | Quelle: ICS-Datei | Datei/Ziel: /opt/chatendar/calendar.ics
2 Termin(e) im Zeitraum geladen
Selektion: Kategorie "WhatsApp" oder Präfix "[WA]"
2 Termin(e) markiert, 0 nicht markiert

    2026-09-18 19:00  Vereinssitzung  (Clubheim)
        1d    vorher → 2026-09-17 19:00   geplant
        2h    vorher → 2026-09-18 17:00   geplant

    2026-09-21 17:00  Elternabend
        1d    vorher → 2026-09-20 17:00   geplant
        2h    vorher → 2026-09-21 15:00   geplant

Wochenübersicht: nächster Versand 2026-09-18 18:00 (fr 18:00, Zeitraum 7d)
```

Daran lässt sich ablesen:

| Beobachtung | Bedeutung |
| ----------- | --------- |
| `0 Termin(e) im Zeitraum geladen` | `ICS_PATH` zeigt auf die falsche Datei, oder alle Termine liegen in der Vergangenheit – mit `--preview 365` weiter nach vorn schauen |
| `0 Termin(e) markiert` | Die Termine tragen weder Kategorie noch Präfix. Die Vorschau listet die gefundenen Termine samt ihrer Kategorien auf |
| überall `geplant` | Alles korrekt – es ist schlicht noch nichts fällig |
| `Prüffenster verpasst` | Das Tool lief zum Versandzeitpunkt nicht. `CHECK_WINDOW_MINUTES` erhöhen oder `CATCH_UP=true` setzen |

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

Die passende ID nach `WHATSAPP_GROUP_ID` in die `.env` übernehmen oder in
`config.json` als Gruppenziel unter `whatsappTargets[]` des jeweiligen Profils
hinterlegen. Einzelpersonen werden dort mit `type: "person"` und einer
internationalen `phone`-Nummer eingetragen.

> **Wichtig:** Die Session liegt in `./auth_session` und erlaubt vollen Zugriff
> auf den gekoppelten WhatsApp-Account. Der Ordner ist in `.gitignore`
> eingetragen und sollte auf dem Server `chmod 700` bekommen. Die Kopplung ist
> einmalig – solange der Ordner erhalten bleibt, ist kein weiterer QR-Code
> nötig. Bei einem Backup den Ordner mitsichern.
>
> **Risiko:** Baileys nutzt das inoffizielle Multi-Device-Protokoll und kann
> gegen die WhatsApp-Nutzungsbedingungen verstoßen. `baileys-antiban` reduziert
> mit konservativen Limits und zufälligen Abständen lediglich typische
> Automatisierungsmuster; es verhindert keine Sperre. Chatendar aktiviert keine
> Textveränderung, Auto-Antworten, künstliche Presence, Fingerprint- oder
> Proxy-Funktionen. Direktnachrichten nur an Personen senden, die dem Empfang
> zugestimmt haben. Ein eigener Account statt des privaten Hauptaccounts bleibt
> die sicherere Wahl.

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

Wer einen **eigenen Kalender** nur für die Gruppe führt, braucht gar keine
Markierung – dann beide Wege abschalten, und jeder Termin des Kalenders zählt:

```ini
SELECT_BY_CATEGORY=false
SELECT_BY_PREFIX=false
```

In dem Fall warnt jeder Lauf deutlich, dass alle Termine verschickt werden –
in einem gemischten Privatkalender wäre das unangenehm.

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

Templates sind reine Konfiguration (`config.json`, `.env` oder die lokale
Settings-Oberfläche). Platzhalter:

| Platzhalter | Inhalt |
| ----------- | ------ |
| `{titel}` | Titel des Termins (ggf. ohne Präfix) |
| `{tag_relativ}` / `{tag_relativ_ende}` | `Heute`, `Morgen`, `Übermorgen`, `In 4 Tagen` |
| `{tagesbereich_relativ}` | `Morgen` oder bei mehrtägigen Terminen `Morgen bis Übermorgen` |
| `{datum}` | rückwärtskompatibel: `So., 20.09.2026` |
| `{datum_ohne_wochentag}` / `{datum_kurz}` | nur Datum: `20.09.2026` |
| `{datum_mit_wochentag}` | ausgeschrieben: `Sonntag, 20.09.2026` |
| `{datum_mit_wochentag_kurz}` | abgekürzt: `So., 20.09.2026` |
| `{datum_ende_ohne_wochentag}`, `{datum_ende_mit_wochentag}`, `{datum_ende_mit_wochentag_kurz}` | Enddatum-Varianten für mehrtägige Termine |
| `{datum_relativ}` / `{datum_relativ_ende}` | relativer Tag plus Datum |
| `{datumsbereich}` | nur Datum/Zeitraum ohne Wochentag und Uhrzeit: `20.09.2026` oder `20.09.2026–22.09.2026` |
| `{datumsbereich_mit_wochentag}` | Zeitraum mit ausgeschriebenen Wochentagen |
| `{datumsbereich_mit_wochentag_kurz}` | Zeitraum mit abgekürzten Wochentagen |
| `{termin_zeit}` | nur Uhrzeit/Zeitspanne: `18:30–20:00 Uhr`, leer bei ganztägigen Terminen |
| `{termin_zeitraum}` | kompletter rückwärtskompatibler Terminzeitraum inkl. relativer Tagesangabe und Uhrzeit |
| `{wochentag}` / `{wochentag_kurz}` | `Sonntag` / `So.` |
| `{wochentag_ende}` / `{wochentag_ende_kurz}` | End-Wochentag für mehrtägige Termine |
| `{uhrzeit}` / `{uhrzeit_ende}` | Start-/Enduhrzeit ohne `Uhr`, leer bei ganztägigen Terminen |
| `{ort}` | Ort des Termins |
| `{vorlauf}` / `{vorlauf_kurz}` | `1 Tag` / `1d` |
| `{items}` | nur in Sammel-/Übersichts-Templates: gerenderte Liste |
| `{anzahl}` | nur in Sammel-/Übersichts-Templates: Anzahl der Termine |

Bedingte Abschnitte `{?platzhalter}…{/platzhalter}` erscheinen nur, wenn der
Platzhalter gefüllt ist. So entfällt die Ortszeile automatisch bei Terminen
ohne Ort:

```
TEMPLATE_SINGLE=Kurzer Reminder ({vorlauf} vorher): *{titel}*\n🗓 {tagesbereich_relativ}, {datumsbereich}{?termin_zeit} um {termin_zeit}{/termin_zeit}{?ort}\n📍 {ort}{/ort}
```

Es gibt drei Templates: `TEMPLATE_SINGLE` für einen einzelnen fälligen Termin,
`TEMPLATE_COLLECTION` für die Sammelnachricht und `TEMPLATE_COLLECTION_ITEM`
für jeden Eintrag darin. WhatsApp kennt `*fett*`, `_kursiv_` und
` ```Monospace``` `.

In `config.json` können Templates als normale mehrzeilige JSON-Strings stehen.
In `.env` werden `\n`-Sequenzen zu echten Zeilenumbrüchen umgewandelt. Die
Settings-Oberfläche zeigt für die Reminder- und Wochenübersichts-Templates eine
Vorschau mit Beispieldaten.

## Wochenübersicht

Unabhängig von den Einzel- und Sammelerinnerungen kann zu einem festen
Wochentermin eine Liste aller Termine der kommenden Woche verschickt werden:

```ini
DIGEST_ENABLED=true
DIGEST_DAY=fr        # mo, di, mi, do, fr, sa, so (auch "Freitag" oder 0-6)
DIGEST_TIME=18:00    # lokale Zeit in TIMEZONE
DIGEST_RANGE=7d      # oder next-week
```

Für **ausschließlich Wochenübersichten**:

```ini
REMINDERS_ENABLED=false
DIGEST_ENABLED=true
```

`REMINDERS_ENABLED=false` deaktiviert Einzel- und Sammelerinnerungen gemeinsam,
ohne die Wochenübersicht oder ihre Terminauswahl zu beeinflussen. Die Option
kann in `config.json` je Profil als `"remindersEnabled": false` gesetzt werden.

Ergebnis:

```
🗓 *Termine der kommenden Woche* (18.09. – 25.09.2026)

• *Freitag, 18.09.2026* – 19:00 Uhr
  Training (📍 Sporthalle)
• *Samstag, 19.09.2026* – 21:00 Uhr
  Chorprobe
• *Sonntag, 20.09.2026* – 18:30 Uhr
  Elternabend Klasse 4b (📍 Aula der Grundschule)
```

### Welcher Zeitraum?

`DIGEST_RANGE` entscheidet, was „kommende Woche“ bedeutet:

| Wert        | Bedeutung                                                              |
| ----------- | ---------------------------------------------------------------------- |
| `7d`        | rollierend: ab dem Versandzeitpunkt sieben Tage voraus (Default)        |
| `14d`, `10d` … | beliebiger anderer rollierender Zeitraum                             |
| `next-week` | die nächste volle Kalenderwoche, Montag 00:00 bis Sonntag 24:00         |

Für einen Versand am **Freitag** passt meist `7d` – die Liste beginnt dann mit
dem heutigen Abend. Für einen Versand am **Sonntag** ist oft `next-week`
gemeint, damit die Liste sauber am Montag anfängt. Beides funktioniert an
jedem Wochentag.

### Verhalten

- Die Übersicht geht **pro Woche genau einmal** raus. Der State-Schlüssel ist
  der geplante Versandzeitpunkt, mehrere Läufe innerhalb des Prüffensters
  erzeugen also keine Dubletten.
- Es gelten dieselben Selektionsregeln wie bei den Erinnerungen – nur markierte
  Termine landen in der Liste.
- Fällt der Versandzeitpunkt in einen Lauf, in dem auch Erinnerungen fällig
  sind, werden **zwei getrennte Nachrichten** verschickt.
- Enthält der Zeitraum keine Termine, wird nichts gesendet. Mit
  `DIGEST_SEND_WHEN_EMPTY=true` geht stattdessen `TEMPLATE_DIGEST_EMPTY` raus.
- Auch hier gilt das Prüffenster: Das Tool muss um `DIGEST_TIME` herum laufen.
  Bei `DIGEST_TIME=18:00` und einem 15-Minuten-Timer passt
  `CHECK_WINDOW_MINUTES=30` problemlos.

Der nächste Versandzeitpunkt lässt sich mit `--preview` prüfen.

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

Bei `ProtectSystem=strict` müssen alle Ordner beschreibbar sein, die der Bot
anfasst: `AUTH_DIR`, `data/` (State, Log, Standard-Ordner der Session-Sicherungen)
und ein abweichend gesetztes `SESSION_BACKUP_DIR`. Jeder Lauf prüft am Ende
außerdem, ob ein [Keepalive](#keepalive) fällig ist.

### Cronjob (Alternative)

```cron
*/15 * * * * cd /opt/chatendar && /usr/bin/flock -n data/chatendar-cron.lock /usr/bin/node src/index.js >> /var/log/chatendar.log 2>&1
```

Cron startet mit minimalem Environment – deshalb das `cd`, damit `.env`,
`auth_session/` und `data/` gefunden werden. `flock` verhindert, dass ein
noch laufender Durchlauf vom nächsten Cron-Termin überlappt wird. Zusätzlich
sperrt chatendar den jeweiligen Session-Ordner während einer WhatsApp-Verbindung.

## Session-Pflege

Die Kopplung steckt in `AUTH_DIR` (Standard `auth_session/`). Geht sie verloren,
muss neu gekoppelt werden. Gegen die vermeidbaren Ursachen gibt es drei Maßnahmen.

### Keepalive

Der Bot verbindet sich nur, wenn etwas zu senden ist. Bei seltenen Erinnerungen
kann die Session so lange ungenutzt bleiben. Deshalb öffnet jeder normale Lauf am
Ende die WhatsApp-Verbindung kurz ohne zu senden, wenn die letzte Verbindung
länger als `KEEPALIVE_DAYS` (Standard 7, `0` = aus) zurückliegt. Der Heartbeat
arbeitet auch die auf dem Server wartenden Nachrichten ab und meldet eine
Abmeldung über Exit-Code 1, sodass Monitoring sie sofort sieht. Nach einem Versuch
wird erst nach 6 Stunden ein neuer gestartet, damit ein Dauerfehler nicht im
Cron-Takt bei WhatsApp anklopft. Profile mit `DRY_RUN=true` sind ausgenommen.

Manuell, unabhängig von Fälligkeit und Kalender:

```bash
npm run keepalive
```

Der Zeitpunkt der letzten Verbindung steht in `auth_session/chatendar-session.json`.
Ob WhatsApp die Inaktivitäts-Abmeldung an der Verbindung festmacht, ist nicht
dokumentiert. Der Keepalive ist deshalb eine Absicherung und vor allem eine
Früherkennung, keine Garantie. Ohne Bot-Einfluss bleibt: Das Handy muss regelmäßig
online sein (WhatsApp meldet verknüpfte Geräte nach etwa 14 Tagen Handy-Inaktivität
ab), und die Kopplung darf am Handy nicht entfernt werden.

Für Benachrichtigung bei Fehlern im systemd-Betrieb in `chatendar.service`
`OnFailure=` auf einen Dienst setzen, der eine Nachricht verschickt; bei Cron
sorgt `MAILTO=` für Mails bei Ausgabe auf stderr.

### Automatische Sicherung

Nach einer erfolgreichen Verbindung wird `AUTH_DIR` höchstens einmal täglich nach
`SESSION_BACKUP_DIR` (Standard `./data/session-backups/`) kopiert. Bewahrt werden
die letzten `SESSION_BACKUP_KEEP` Stände (Standard 7, `0` = aus). Gesichert wird
erst, nachdem die Zugangsdaten sicher geschrieben wurden, und nie während
Baileys noch schreibt. Nach dem Koppeln wird sofort gesichert.

Unabhängig davon schreibt der Bot `creds.json` atomar und hält die letzte gültige
Fassung als `creds.json.bak` vor. Ist die Datei beim Start beschädigt (Absturz oder
Stromausfall beim Schreiben), wird sie daraus wiederhergestellt; die defekte Datei
bleibt als `creds.json.corrupt` liegen. Eine bewusst gelöschte `creds.json` wird
nicht wiederhergestellt.

Die Sicherung enthält vollen Zugriff auf das WhatsApp-Konto: nicht ins Repo, nicht
in eine Cloud-Synchronisation, Ordnerrechte bleiben `700`. Gegen Plattenausfall
`SESSION_BACKUP_DIR` auf ein anderes Laufwerk legen.

Wiederherstellen (Timer vorher stoppen):

```bash
systemctl stop chatendar.timer
mv auth_session auth_session.defekt
cp -a data/session-backups/auth_session-<hash>/<zeitstempel> auth_session
systemctl start chatendar.timer
npm run keepalive   # prüft die wiederhergestellte Session
```

Das stellt Identität und Registrierung wieder her und erspart das Neu-Koppeln.
Gespeicherte Chat-Sitzungen können veraltet sein; sie werden über den
Retry-Mechanismus bei Bedarf neu ausgehandelt. Immer die neueste Sicherung nehmen.

### Was sonst zur Abmeldung führt

- Dieselbe Session gleichzeitig an zwei Orten (zweiter Rechner, Kopie, Docker
  neben dem Dienst): WhatsApp trennt eine Verbindung, und die Verschlüsselungszustände
  laufen auseinander. Immer nur ein Prozess pro Session.
- `AUTH_DIR` nicht beschreibbar (z. B. `ProtectSystem` ohne `ReadWritePaths`) oder ein
  anderes Arbeitsverzeichnis im Cron bei relativem Pfad: absoluten Pfad verwenden.
- Am Handy „Verknüpfte Geräte" entfernt, WhatsApp neu installiert oder die Nummer
  neu registriert: dann hilft nur Neu-Koppeln (alte Einträge in „Verknüpfte
  Geräte" dabei entfernen).

## Bedienung

```bash
node src/index.js [Optionen]
```

| Option             | Wirkung                                                   |
| ------------------ | --------------------------------------------------------- |
| `--preview [Tage]` | Anzeigen, was ansteht und wann es rausgeht (Default 14)    |
| `--keepalive`    | Nur WhatsApp verbinden und schließen, nichts senden          |
| `--dry-run`      | Nachrichten nur anzeigen, nichts senden                      |
| `--live`         | Tatsächlich senden (überschreibt `DRY_RUN=true`)             |
| `--now <ISO>`    | Referenzzeitpunkt setzen, z. B. `2026-09-19T17:00:00Z`       |
| `--config <Pfad>`| Pfad zu einer `config.json`                                  |
| `--verbose`, `-v`| Ausführliches Logging                                        |
| `--quiet`, `-q`  | Nur Warnungen und Fehler                                     |
| `--help`, `-h`   | Hilfe                                                        |

Exit-Code `0` bei Erfolg, `1` bei Fehlern (Konfiguration, Kalender, Versand, Keepalive) –
für Monitoring auswertbar.

### Einstellungen im Browser

```bash
npm run settings
```

Startet eine lokale Oberfläche auf `127.0.0.1:3876`. Dort lassen sich die
üblichen Konfigurationswerte in `config.json` speichern, Profile kopieren oder
löschen, WhatsApp-Gruppen und Einzelpersonen pro Profil verwalten, Templates mit Textareas
bearbeiten, die Konfiguration validieren und `--preview` bzw. `--dry-run`
sicher ohne Live-Versand ausführen. Diese Aktionen nutzen das aktuell in der
Sidebar ausgewählte Profil inklusive ungespeicherter Änderungen, also auch
profilspezifischer Kalenderquellen und Nachrichtentemplates. In der
Profilverwaltung liest „WhatsApp-Gruppen laden“ die Gruppen der gekoppelten
Session des ausgewählten Profils (Ordner aus `AUTH_DIR`) und übernimmt
ausgewählte Gruppen per „Ausgewählte übernehmen“ ohne Doppelungen in die
Gruppenliste; dabei werden keine Nachrichten gesendet. Fehlt die Session oder
wird ein neuer QR-Code verlangt, meldet die Oberfläche das mit dem Hinweis auf
`npm run pair`. Das eigentliche Koppeln erfolgt weiterhin per `npm run pair`.
Mit „State dieses Profils leeren“ lassen sich nur die Versandmarker des aktuell
ausgewählten Profils entfernen; Einstellungen, Kalenderdaten und andere Profile
bleiben unverändert.

#### Sicherer Zugriff aus dem lokalen Netzwerk

Ohne weitere Optionen bleibt die Oberfläche ausschließlich auf dem Server
erreichbar. Das ist der sichere Standard:

```bash
npm run settings
# Browser auf dem Server: http://127.0.0.1:3876
```

Für den Zugriff von einem vertrauenswürdigen Gerät im selben privaten Netz
zuerst die private IPv4-Adresse des Servers und das lokale Netz ermitteln:

```bash
ip -br -4 addr
ip -4 route
```

Angenommen, der Server hat `192.168.178.20` und das lokale Netz ist
`192.168.178.0/24`. Dann den Server ausdrücklich nur an diese private Adresse
binden:

```bash
npm run settings -- --host 192.168.178.20 --port 3876
```

Nicht ungeschützt `--host 0.0.0.0` verwenden: Das würde auf allen
IPv4-Schnittstellen lauschen. Die konkrete private Server-IP verhindert
bereits eine Bindung an eine eventuell vorhandene öffentliche Schnittstelle.
Zusätzlich sollte UFW zuerst das lokale Netz erlauben und danach alle anderen
Quellen für diesen Port sperren:

```bash
sudo ufw status verbose
sudo ufw status numbered

sudo ufw insert 1 allow proto tcp from 192.168.178.0/24 to 192.168.178.20 port 3876 comment 'chatendar settings LAN'
sudo ufw insert 2 deny proto tcp from any to 192.168.178.20 port 3876 comment 'chatendar settings block external'
```

IP-Adresse und CIDR müssen zur eigenen Netzkonfiguration passen. Vorhandene
breite Regeln wie `ALLOW 3876/tcp Anywhere` sollten entfernt werden; die
Nummern dafür zeigt `sudo ufw status numbered`, gelöscht wird anschließend
gezielt mit `sudo ufw delete <Nummer>`.

Ist UFW noch inaktiv, vor `sudo ufw enable` zuerst den tatsächlichen
SSH-Zugriff erlauben und eine zweite SSH-Sitzung zum Testen offen halten. Bei
Standardkonfiguration ist das beispielsweise `sudo ufw allow OpenSSH`; bei
einem abweichenden SSH-Port muss stattdessen dessen konkrete Regel gesetzt
werden.

Listener und Firewall lassen sich auf dem Server prüfen:

```bash
ss -ltnp 'sport = :3876'
sudo ufw status numbered
```

Von einem erlaubten LAN-Gerät muss anschließend
`http://192.168.178.20:3876` erreichbar sein. Ein Gerät außerhalb des
erlaubten CIDR darf keine Verbindung erhalten. Am Router darf außerdem keine
Portweiterleitung für TCP 3876 eingerichtet sein.

Die Settings-App besitzt in diesem Betriebsmodell keine eigene Anmeldung.
Jedes Gerät im erlaubten Netz kann Konfigurationen ändern, Profil-State löschen
und Preview-/Dry-Run-Aktionen starten. Für Gast-WLAN, nicht vertrauenswürdige
lokale Geräte oder Zugriff von unterwegs die App auf `127.0.0.1` belassen und
stattdessen ein VPN oder einen authentifizierten Reverse Proxy verwenden.

Die verfügbaren Startoptionen zeigt:

```bash
npm run settings -- --help
```

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

Jede Kombination aus Profil-ID, WhatsApp-Ziel-ID, Termin-ID und Vorlaufzeit-Stufe
wird in der SQLite-Tabelle `sent_reminders` (`DB_PATH`) festgehalten. Bei
Serienterminen enthält die ID den Zeitpunkt der Instanz, damit jeder Termin
einzeln gezählt wird.

Beim ersten Start mit einer älteren State-Datenbank wird die Tabelle automatisch
auf das neue Schema migriert. Alte Einträge werden dem Profil `default` und der
Zielgruppe `default` zugeordnet. Dadurch bleibt die historische
Top-Level-Konfiguration nachvollziehbar; neue Profil-/Ziel-Kombinationen
haben jeweils ihren eigenen State und unterdrücken einander nicht. Profil-IDs
und Zieladressen sollten deshalb stabil bleiben.

Persistiert wird erst **nach** erfolgreichem Versand. Schlägt das Senden fehl,
bleibt die Erinnerung offen und wird beim nächsten Lauf erneut versucht.

Dry-Runs verändern den State standardmäßig nicht (`RECORD_DRY_RUN=false`), sind
also beliebig wiederholbar.

In der Settings-Oberfläche kann der State gezielt pro Profil geleert werden.
Das ist praktisch, wenn ein Profil zunächst gegen eine Testgruppe lief und
anschließend in den Produktivbetrieb wechseln soll. Gelöscht werden nur Einträge
mit der jeweiligen Profil-ID; andere Profile in derselben SQLite-Datei bleiben
erhalten.

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
`test/fixtures/beispiel.ics`. Der WhatsApp-Client, der Sendeschutz, Keepalive und
Session-Sicherung laufen gegen Attrappen des Baileys-Sockets. Ob eine Nachricht
beim Empfänger tatsächlich lesbar ankommt, lässt sich nur mit einem echten
Testversand prüfen (siehe [Fehlersuche](#fehlersuche-warte-auf-diese-nachricht)).

## Projektstruktur

```
src/
  calendar/
    calendarSource.js     Interface + Registry der Quellen
    icsSource.js          ICS-Datei (node-ical), inkl. Serienauflösung
    caldavSource.js       CalDAV/Nextcloud via tsdav
  reminders/
    selector.js           Terminselektion (Kategorie/Präfix)
    duration.js           Vorlaufzeiten parsen und formatieren
    scheduler.js          Versandzeitpunkte und Fälligkeit
    batching.js           Gruppierung je Vorlaufzeit-Stufe
    digest.js             Wochenübersicht: Termin, Zeitraum, Fälligkeit
  messaging/
    templateRenderer.js   Templates füllen
    whatsappClient.js     Baileys-Wrapper
    whatsappTarget.js     Telefonnummern und Ziel-JIDs normalisieren
    sendGuard.js          Konservatives Rate-Limit/Jitter
    keepalive.js          Heartbeat-Verbindung ohne Versand
    sessionMaintenance.js Verbindungsprotokoll und Sicherung von AUTH_DIR
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

## CalDAV / Nextcloud verwenden

Statt einer lokalen ICS-Datei kann direkt ein CalDAV-Kalender gelesen werden:

```ini
SOURCE=caldav
CALDAV_URL=https://cloud.example.com/remote.php/dav
CALDAV_USERNAME=...
CALDAV_PASSWORD=...
CALDAV_CALENDAR=Familienkalender
```

`CALDAV_CALENDAR` kann der Anzeigename des Kalenders oder dessen URL sein. Die
abgerufenen iCalendar-Objekte werden durch dieselbe ICS-Logik verarbeitet wie
lokale Dateien, inklusive Kategorien, `X-WA-REMIND`, Ganztags- und
Serienterminen.

## Bekannte Grenzen

- Alle aktivierten Ziele eines Profils erhalten dieselbe gerenderte Nachricht;
  zielspezifische Templates gibt es nicht
- Kein interner Scheduler – Aufruf erfolgt extern
- Verschobene Serientermine werden nur erkannt, wenn die ursprüngliche
  Instanz im Abfragefenster liegt
- Baileys nutzt das inoffizielle WhatsApp-Protokoll; auch der Sendeschutz kann
  Sperren nicht ausschließen (siehe Hinweis oben)
- Der Keepalive ist eine Absicherung, keine Garantie: Abmeldungen durch WhatsApp
  (Handy lange inaktiv, Gerät entfernt, Konto eingeschränkt) lassen sich nicht
  verhindern, nur früh erkennen
- Gesendete Nachrichten für Retry-Anfragen werden nur bis zum Ende des Laufs
  vorgehalten; ein Retry, der erst später eintrifft, kann nicht beantwortet werden
- Die Session-Sperre prüft Prozesse per PID. Sie schützt vor überlappenden Läufen
  auf einem Rechner, nicht vor mehreren Containern oder Rechnern mit derselben
  Session. Dieselbe Session darf nie an zwei Orten gleichzeitig laufen

## Fehlersuche: „Warte auf diese Nachricht"

Sieht ein Empfänger nur „Warte auf diese Nachricht. Das kann einen Moment
dauern", konnte sein Gerät die Nachricht nicht entschlüsseln. WhatsApp fordert
dann vom Absender einen erneuten Versand an (Retry). Das klappt nur, wenn der
Bot nach dem Senden noch verbunden ist. Deshalb wartet der Bot nach dem letzten
Senden bis zu `SEND_SETTLE_MS` (Standard 10 s) auf die Zustellbestätigung und
hält gesendete Nachrichten für Retries vor. `SEND_SETTLE_MS=0` schaltet das ab
und sollte nicht gesetzt werden.

Zur Analyse lässt sich das Baileys-Protokoll mitschreiben:

```bash
BAILEYS_LOG_LEVEL=debug npm start   # schreibt nach ./data/baileys.log
grep -i "retry" data/baileys.log
```

„recv retry request" gefolgt von einem erneuten Versand ist der Normalfall;
„message not available" zeigt, dass ein Retry nicht beantwortet werden konnte.
Die Log-Datei enthält Rufnummern und darf nicht weitergegeben werden.

Hilft das nicht und betrifft es nur einen Empfänger, kann dessen gespeicherte
Signal-Sitzung desynchronisiert sein: `auth_session/` sichern, dann die Dateien
`session-<nummer>.*` dieses Empfängers löschen. Beim nächsten Versand wird eine
frische Sitzung ausgehandelt.

## Lizenz

MIT
