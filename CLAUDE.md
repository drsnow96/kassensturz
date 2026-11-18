# Hinweise für Claude

- Sprache der Oberfläche und Commits: Deutsch.
- Keine npm-Abhängigkeiten einführen; Node 24 mit `node:sqlite`.
- Nutzdaten liegen nur in `DATA_DIR` (`/data`). Niemals echte Beträge, Namen oder Zugangsdaten ins Repo schreiben, auch nicht in Seeds oder Tests.
- Datenbankänderungen nur als neue Migration am Ende von `MIGRATIONS` in `server.js`. Bestehende Migrationen nie ändern.
- Vor jedem Push: `npm test`. Bei Release `version` in `package.json` erhöhen (Watchtower holt `latest`, App legt dann automatisch ein Backup an).
