# Kassensturz

Budget, Angebote, Rechnungen, Belege und Finanzierung für unseren Hausbau – selbst gehostet auf der Synology DS723.

- **Übersicht:** Gesamtbudget, Bezahlt, Beauftragt, Prognose, Budget-Rest, Finanzierungspuffer, Balken je Kategorie, offene Zahlungen
- **Ausgaben:** erfassen mit Status *Option → Angebot → Beauftragt → Bezahlt*, Firma, Datum, Fälligkeit, Notiz, Belege (PDF/Fotos), Suche, Filter, CSV-Export
- **Kategorien & Budget:** Budget je Kategorie, Gebunden / Prognose / Rest
- **Finanzierung:** Eigenkapital, KfW, Bankdarlehen … gegen den Bedarf
- **Einstellungen:** Konten für euch beide, Passwort ändern, Backups

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
Watchtower prüft täglich um 04:00 Uhr, lädt die neue Version und tauscht den Container aus.

Was dabei mit den Daten passiert:
1. Beim Start erkennt die App die neue Version und legt **vorher** ein Backup an (`backups/kassensturz-…-vor-v1.1.0.sqlite`).
2. Danach laufen nur neue Datenbank-Migrationen (nie verändert, nur angehängt).
3. Zusätzlich gibt es ein tägliches Backup. Behalten werden die letzten 10 (`KEEP_BACKUPS`).

Sofort aktualisieren statt um 04:00:

```sh
cd /volume2/docker/kassensturz
sudo docker compose pull && sudo docker compose up -d
```

**Nie** `docker compose down -v` verwenden und den Ordner `data` nicht löschen.

## Backup zurückspielen

```sh
cd /volume2/docker/kassensturz
sudo docker compose stop kassensturz
cp data/kassensturz.sqlite data/kassensturz-defekt.sqlite
cp data/backups/<backup-datei>.sqlite data/kassensturz.sqlite
rm -f data/kassensturz.sqlite-wal data/kassensturz.sqlite-shm
sudo docker compose start kassensturz
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
