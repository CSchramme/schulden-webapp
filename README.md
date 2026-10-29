# Schulden mit Papa

Kleine Web-App, um festzuhalten, wie viel Geld ich mir von Papa geliehen und wie viel ich schon zurückgezahlt habe – statt alles auf Papier zu schreiben. Sie lässt sich als App auf den Home-Bildschirm legen und funktioniert auch offline.

**Live:** https://cschramme.github.io/schulden-webapp/

## Funktionen

- Aktueller Stand auf einen Blick („Du schuldest Papa …“ / „Papa schuldet dir …“ / „Ihr seid quitt“)
- Einträge für **Geliehen** und **Zurückgezahlt** mit Betrag, Notiz und Datum
- Verlauf nach Monaten, mit Kontostand nach jedem Eintrag
- Einträge antippen zum Bearbeiten oder Löschen (mit „Rückgängig“)
- Name anpassbar (z. B. „Vater“)
- Backup speichern/wiederherstellen (JSON) und Export als Tabelle (CSV für Excel/Numbers)
- Hell- und Dunkelmodus, offline nutzbar

## Zum Home-Bildschirm hinzufügen

- **iPhone/iPad (Safari):** Teilen-Symbol → „Zum Home-Bildschirm“
- **Android (Chrome):** Menü ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ – oder den Button „Installieren“ in der App nutzen

> Tipp fürs iPhone: Die App auf dem Home-Bildschirm hat einen eigenen Speicher, getrennt von Safari. Am besten erst installieren und dann Einträge machen.

## Wo liegen die Daten?

Alles wird nur lokal im Browser auf dem jeweiligen Gerät gespeichert (`localStorage`), es gibt keinen Server und kein Konto. Deshalb ab und zu unter **Einstellungen → Backup speichern** eine Sicherung machen. Mit „Backup wiederherstellen“ kannst du die Daten auch auf ein neues Handy übertragen.

## Veröffentlichen (GitHub Pages)

Einmalig im Repository unter **Settings → Pages → Build and deployment → Source** „**GitHub Actions**“ auswählen. Danach wird jeder Push auf `main` automatisch veröffentlicht (`.github/workflows/pages.yml`). Der Workflow setzt dabei eine neue Cache-Version im Service Worker, sodass die installierte App das Update beim nächsten Öffnen bekommt.

## Lokal starten

Kein Build nötig – einfach einen statischen Server im Ordner starten:

```sh
python3 -m http.server 8000
```

und http://localhost:8000 öffnen.

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Aufbau der Seite |
| `styles.css` | Aussehen |
| `app.js` | Logik: Einträge, Speichern, Backup, Installations-Hinweis |
| `sw.js` | Service Worker für den Offline-Betrieb |
| `manifest.webmanifest`, `icons/` | App-Name und Icons für den Home-Bildschirm |
