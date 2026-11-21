# Kassensturz

Budget, Angebote, Rechnungen, Belege und Finanzierung für unseren Hausbau – selbst gehostet auf der Synology DS723.

- **Übersicht:** Gesamtbudget inkl. Reserve, Bezahlt, Beauftragt, Worst Case, Finanzierungspuffer, Kosten je Bereich, Gezahlt nach Person, offene Zahlungen und Entscheidungen
- **Kosten:** Positionen nach Bereichen (A–H) wie in der Excel-Kostenübersicht – Nr, Kostenpunkt, *Im Hauspreis? (Nein/Ja/Prüfen)*, Schätzung, Angebot/Ist, Differenz, Status *Geplant → Angebot → Beauftragt → Bezahlt* (oder *Option*), Hinweis, Info mit klickbaren Links, Belege (PDF/Fotos)
- **Beleg erfassen (OCR):** PDF oder Foto einer Rechnung, eines Angebots oder Kassenbons hochladen (am PC auch per Drag & Drop, am Handy direkt mit der Kamera). Kassensturz liest den Text **lokal auf der NAS** (Poppler/Tesseract, nichts geht in die Cloud), erkennt Dokumentart, Betrag, Datum, Fälligkeit/Zahlungsziel, Firma und Belegnummer, schlägt eine passende vorhandene Position vor und öffnet den Dialog vorausgefüllt – erkannte Felder grün, fehlende orange. Der Beleg wird beim Speichern angehängt.
- **E-Mail-Postfach für Rechnungen:** Rechnungen an ein eigenes Postfach weiterleiten (IMAP, z. B. GMX, Web.de, Gmail mit App-Passwort, eigene Domain). Kassensturz holt PDF- und Bild-Anhänge regelmäßig ab – auch aus als Anhang weitergeleiteten Mails –, liest sie per OCR und legt sie in den **Eingang** unter „Kosten“. Optional nur von bestimmten Absendern. Erledigte Mails werden in einen Ordner verschoben.
- **Was-wäre-wenn:** offene Entscheidungen (z. B. Holzfaser ja/nein, KNX oder wibutler, Klima) mit Optionen und ihren Kosten anlegen, zu Szenarien kombinieren und vergleichen: Gesamtbudget, Worst Case, Finanzierungslücke, geschätzte Ratenänderung. Eine Option lässt sich mit einem Klick in die Positionen übernehmen.
- **Leistungsbeschreibung prüfen:** Bau- und Leistungsbeschreibung oder Angebot hochladen – Kassensturz sucht zu jeder Position die Textstelle (mit Seite) und ordnet sie ein: enthalten, nicht enthalten, teilweise, nicht erwähnt. Mehrere Dokumente nebeneinander = Anbieter-Vergleich. Vorschläge für „Im Hauspreis?“ übernehmen, mögliche Kostenfallen („bauseits“, „Eigenleistung“, „gegen Aufpreis“) als Position anlegen.
- **Gewährleistung:** je Position Abnahme und Dauer (2 J. Kauf, 4 J. VOB/B, 5 J. BGB-Bauwerk oder eigene), Liste aller Fristen mit Begehungs-Termin drei Monate vor Ablauf, „Nächste Fristen“ in der Übersicht und ein **Kalender-Abo** (webcal) für iPhone/Mac/Android mit Fälligkeiten und Gewährleistungsenden.
- **Digitaler Hausordner:** alles, was im Haus verbaut ist (Wärmepumpe, Lüftung, Wechselrichter, Küchengeräte, Fenster, Rauchmelder …) mit Hersteller, Modell, Seriennummer, Ort, Einbaudatum, Anleitungen/Datenblättern/Fotos, Verknüpfung zur Position (Rechnung, Firma, Gewährleistung), Garantie, Wartungsintervall und Wartungsprotokoll. Schnellstart „Aus Positionen“ (Bereich und Wartung werden aus dem Namen geschätzt). Wartungstermine erscheinen in „Nächste Fristen“ und im Kalender-Abo.
- **QR-Aufkleber:** jedes Bauteil hat einen QR-Code, der direkt seine Seite öffnet (`/#teil-CODE`). Etiketten drucken klein (48,5 × 25,4 mm, 40 je A4) oder groß (105 × 57 mm, 10 je A4); QR-Erzeugung ohne Bibliothek (`public/qr.js`). Die Zieladresse ist einstellbar – am besten der feste Tailscale-Name der NAS.
- **Aufteilung der Zahlungen:** Standard 50:50 (in den Einstellungen änderbar), pro Position abweichend in **Prozent oder als feste €-Beträge**; die Übersicht zeigt, wer wie viel gezahlt hat und die Abweichung vom Soll
- **Bereiche & Budget:** Schätzung, Angebot/Ist, Prognose, optionaler Budgetrahmen, Reserve-Kennzeichen je Bereich
- **Finanzierung:** Übersicht „Wer hat wie viel ausgegeben?“ (bezahlte Positionen + Kreditraten, davon Zinsen/Tilgung, Anteil, eingebrachtes Eigenkapital, Rate je Person). Eigenkapital und Darlehen gegen Bedarf und Worst Case; beim Eigenkapital lässt sich festlegen, wer wie viel einbringt (% oder €). Je Darlehen: Sollzins, Monatsrate, erste Rate, Zinsbindung, tilgungsfreie Monate, Aufteilung der Rate (% oder €). Berechnet werden anfängliche Tilgung, bezahlte Zinsen und Tilgung bis heute, Restschuld heute und am Ende der Zinsbindung, Gesamtzinsen, Schuldenfreiheit sowie ein Tilgungsplan nach Jahren (Annuität, monatliche Verzinsung; Annahme: pünktliche Raten)
- **Einstellungen:** Reserve-Satz, Standardaufteilung, Konten, Import/Export (JSON, CSV), Backups

## Rechenlogik (wie in der Excel-Kostenübersicht)

- Es zählen Positionen mit *Im Hauspreis? = Nein*. *Ja* ist im Hauspreis enthalten. *Prüfen* zählt nur zum Worst Case, außer der Posten ist beauftragt oder bezahlt.
- Je Position gilt Angebot/Ist, solange keins vorliegt die Schätzung. *Optionen* zählen nicht.
- Reserve = Reserve-Satz × Kosten aller Bereiche mit Reserve-Haken (Standard: alle außer Hauspreis/Grundstück).
- Gesamtbudget = Prognose + Reserve. Worst Case = Gesamtbudget + alle *Prüfen*-Posten.

Technik: Node.js 24, SQLite (eingebaut), keine npm-Abhängigkeiten. Ein Container, ein Datenordner.

---

## Wo liegen die Daten?

| Was | Ort |
|---|---|
| Programmcode | dieses Repo / Container-Image `ghcr.io/drsnow96/kassensturz` |
| Datenbank, Belege, Backups | **nur** auf der NAS: `/volume2/docker/kassensturz/data` |

Der Container ist zustandslos. Bei einem Update wird er ersetzt, der Datenordner bleibt unberührt.
`data/`, `*.sqlite`, `*.csv` und `*.pdf` sind per `.gitignore` und `.dockerignore` ausgeschlossen.

```
data/
├── kassensturz.sqlite      # alle Einträge, Konten (Passwörter nur als scrypt-Hash)
├── belege/                 # hochgeladene PDFs und Fotos
└── backups/                # automatische Sicherungen der Datenbank
```

---

## Einrichtung auf der DS723 (einmalig, ca. 20 Minuten)

### 1. Ordner anlegen
File Station → Freigabe `docker` → Ordner `kassensturz` → darin Ordner `data`.

### 2. Benutzer-ID herausfinden
SSH aktivieren (Systemsteuerung → Terminal & SNMP), dann:

```sh
ssh deinbenutzer@ds723
id deinbenutzer          # z. B. uid=1026(...) gid=100(users)
```

Die Werte in `docker-compose.yml` bei `PUID`/`PGID` eintragen (Standard 1026/100 passt meist).

### 3. Zugriff auf das private Image erlauben
Auf GitHub: *Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token*,
nur Scope **`read:packages`**, Ablauf z. B. 1 Jahr. Dann auf der NAS:

```sh
sudo docker login ghcr.io -u drsnow96
# Passwort = das Token
```

Damit kann die NAS das Image laden, und Watchtower nutzt dieselben Zugangsdaten (`/root/.docker/config.json`).

> Alternative ohne Token: Das Paket auf GitHub unter *Packages → kassensturz → Package settings* auf **public** stellen.
> Das ist vertretbar, weil das Image nur Code enthält und keine Daten. Dann die `config.json`-Zeile bei Watchtower entfernen.

### 4. Projekt in Container Manager anlegen
Container Manager → **Projekt → Erstellen**
- Projektname: `kassensturz`
- Pfad: `/volume2/docker/kassensturz`
- Quelle: *docker-compose.yml hochladen* (Datei aus diesem Repo)
- Weiter → Fertig. Beide Container starten.

### 5. Erstes Konto anlegen – sofort
`http://<NAS-IP>:8099` öffnen. Solange kein Konto existiert, zeigt die App die Einrichtung.
Dort dein Konto anlegen, danach unter **Einstellungen → Benutzer** das Konto für deine Frau.

### Kostenübersicht importieren
Einstellungen → **Import & Export** → Importdatei (`.json`) wählen → Importieren.
Leere Standardbereiche werden dabei entfernt, ein erneuter Import aktualisiert statt zu verdoppeln, vorher entsteht automatisch ein Backup.
Importdateien enthalten eure echten Zahlen und gehören **nicht** ins Repository.

### 6. Von unterwegs: Tailscale statt Portfreigabe
- Paketzentrum → **Tailscale** installieren und anmelden
- Tailscale-App auf euren Handys/Laptops, gleiches Konto bzw. Einladung
- Aufruf: `http://ds723:8099` (MagicDNS)
- Optional HTTPS mit gültigem Zertifikat: per SSH `sudo tailscale serve --bg 8099` → `https://ds723.<tailnet>.ts.net`
- **Keine** Portweiterleitung im Router einrichten.

### 7. Backup außer Haus
Hyper Backup → Ordner `docker/kassensturz/data` aufnehmen, **clientseitige Verschlüsselung** aktivieren.

---

## Updates

Ich (bzw. Claude) pushe auf `main` → GitHub Actions testet und baut `ghcr.io/drsnow96/kassensturz:latest`.
Watchtower prüft alle 10 Minuten, lädt eine neue Version und tauscht den Container aus (Unterbrechung wenige Sekunden).

Was dabei mit den Daten passiert:
1. Beim Start erkennt die App die neue Version und legt **vorher** ein Backup an (`backups/kassensturz-…-vor-v1.1.0.sqlite`).
2. Danach laufen nur neue Datenbank-Migrationen (nie verändert, nur angehängt).
3. Zusätzlich gibt es ein tägliches Backup. Behalten werden die letzten 10 (`KEEP_BACKUPS`).

Sofort aktualisieren statt um 04:00:

```sh
cd /volume2/docker/kassensturz
sudo docker-compose pull && sudo docker-compose up -d
```

**Nie** `docker-compose down -v` verwenden und den Ordner `data` nicht löschen.

## Backup zurückspielen

```sh
cd /volume2/docker/kassensturz
sudo docker-compose stop kassensturz
cp data/kassensturz.sqlite data/kassensturz-defekt.sqlite
cp data/backups/<backup-datei>.sqlite data/kassensturz.sqlite
rm -f data/kassensturz.sqlite-wal data/kassensturz.sqlite-shm
sudo docker-compose start kassensturz
```

## Sicherheit

- Login mit Benutzername und Passwort (mind. 10 Zeichen, scrypt-gehasht), Sitzung 30 Tage, HttpOnly/SameSite-Cookie
- Nach 5 Fehlversuchen 5 Minuten Sperre je IP
- Schutz gegen Cross-Site-Anfragen (eigener Header + SameSite=Strict), strenge Content-Security-Policy
- Belege werden mit Zufallsnamen gespeichert und nur angemeldeten Benutzern ausgeliefert
- Die Einrichtung ist nur möglich, solange noch kein Konto existiert

## Entwicklung

```sh
npm run dev     # startet auf http://localhost:8080 mit Daten in ./data
npm test        # Integrationstest inkl. Neustart und Backup vor Update
```

Neue Version: `version` in `package.json` erhöhen, nach `main` pushen, optional Tag `v1.2.0` setzen.
Schemaänderungen: neue Migration **hinten** an `MIGRATIONS` in `server.js` anhängen – bestehende nie ändern.
