# Schulden

Kleine Web-App, mit der zwei Personen (z. B. ich und Papa) festhalten, wie viel Geld geliehen und zurückgezahlt wurde – statt alles auf Papier zu schreiben. Beide melden sich mit eigenem Konto an, sehen dieselben Einträge und können selbst eintragen. Die App lässt sich wie eine normale App auf den Home-Bildschirm legen (Progressive Web App) und zeigt ohne Internet den letzten Stand.

## Funktionen

- Aktueller Stand auf einen Blick, jeweils aus eigener Sicht („Du schuldest Papa …“ bzw. „Tim schuldet dir …“)
- Beide können Einträge anlegen, ändern und löschen (mit „Rückgängig“), mit Betrag, Notiz und Datum – auch rückwirkend für alte Schulden
- **Fotos von Belegen** an jedem Eintrag (bis zu 6, direkt mit der Kamera oder aus der Galerie). Sie werden vor dem Hochladen verkleinert, dabei fallen Zusatzdaten wie der Aufnahmeort weg.
- Verlauf nach Monaten, mit Stand nach jedem Eintrag und dem Anfangsbuchstaben der Person, die eingetragen hat
- **Angemeldet bleiben:** einmal anmelden, danach ist man ein Jahr lang angemeldet (jede Nutzung verlängert das)
- **Einmal-Passwort:** Du legst für die andere Person nur ein Startpasswort fest. Beim ersten Anmelden muss sie ein eigenes wählen, das nur sie kennt. Die Zugangsdaten lassen sich direkt aus der App per WhatsApp & Co. verschicken.
- Zum Home-Bildschirm hinzufügen, mit App-Icon, Vollbild und Verknüpfung „Neuer Eintrag“ (langes Drücken auf das Icon, Android)
- Backup als Datei (JSON), Backup einspielen, Export als Tabelle (CSV für Excel/Numbers)
- Hell- und Dunkelmodus

## Installation auf Plesk

Voraussetzungen: PHP 7.4 oder neuer (unter **Websites & Domains → PHP** prüfen, 8.x empfohlen) und ein SSL-Zertifikat (z. B. Let's Encrypt). Ohne HTTPS lässt sich die App nicht auf dem Home-Bildschirm installieren.

1. Diese Dateien und Ordner in `httpdocs` hochladen (oder in einen Unterordner wie `httpdocs/schulden`), z. B. mit dem Plesk-**Dateimanager** oder per FTP:
   `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.json`, `icons/`, `screenshots/`, `api/`, `data/`

   Alternativ in Plesk unter **Git** dieses Repository verbinden und automatisch nach `httpdocs` ausliefern lassen.
2. Die Adresse im Browser öffnen. Beim ersten Aufruf erscheint **Einrichten**: dort direkt beide Konten anlegen – deins mit deinem Passwort, das deines Vaters mit einem Einmal-Passwort.
3. Danach zeigt die App die Zugangsdaten für deinen Vater zum Verschicken an. Er meldet sich unter derselben Adresse an und legt sein eigenes Passwort fest.

### Update von einer früheren Version

Einfach alle Dateien ersetzen (die alte `manifest.webmanifest` kann weg). Die Datenbank wird beim nächsten Aufruf automatisch erweitert, Einträge und Anmeldungen bleiben erhalten. Die installierte App meldet „Neue Version verfügbar“.

Hat dein Vater schon ein Passwort, das du kennst: unter **Einstellungen → Einmal-Passwort für Papa setzen** ein Einmal-Passwort vergeben. Beim nächsten Anmelden legt er dann sein eigenes fest.

## Zum Home-Bildschirm hinzufügen

- **iPhone/iPad (Safari):** Teilen-Symbol → „Zum Home-Bildschirm“. Danach in der App einmal anmelden – die App auf dem Home-Bildschirm hat einen eigenen Speicher, getrennt von Safari.
- **Android (Chrome):** Menü ⋮ → „App installieren“, oder in der App auf „Installieren“ tippen.

## Wo werden die Daten gespeichert?

Auf deinem Server, in einer SQLite-Datenbank. Die Datei wird beim ersten Aufruf automatisch angelegt, und zwar **außerhalb** des Web-Ordners, damit sie nie über das Internet abrufbar ist. Die Fotos liegen im Unterordner `belege`:

```
/var/www/vhosts/<deine-domain>/schulden-daten/schulden.sqlite
/var/www/vhosts/<deine-domain>/schulden-daten/belege/
```

Den genauen Pfad zeigt die App unter **Einstellungen → Daten**. Fotos gibt der Server nur an angemeldete Personen heraus. Kann PHP neben dem Web-Ordner keinen Ordner anlegen, landet alles stattdessen in `data/` innerhalb der App. Dieser Ordner ist per `.htaccess` gesperrt, und die Fotos haben dort Zufallsnamen ohne Endung.

Der Ordner liegt im Webspace und wird deshalb normalerweise vom Plesk-Backup erfasst. Zusätzlich kannst du in der App jederzeit **Backup als Datei speichern** (enthält die Einträge, aber nicht die Fotos).

**Lieber MySQL/MariaDB?** In Plesk unter **Datenbanken** eine Datenbank anlegen, `api/config.sample.php` nach `api/config.php` kopieren und die Zugangsdaten eintragen. Die Fotos bleiben im Ordner `schulden-daten/belege`. `config.php` niemals ins Git-Repository hochladen, sie steht deshalb in `.gitignore`.

## Sicherheit

- Passwörter werden nur als Hash gespeichert (`password_hash`, bcrypt).
- Mit einem Einmal-Passwort lässt der Server nichts anderes zu, als ein eigenes Passwort festzulegen – auch keine Daten.
- Die Anmeldung läuft über ein Cookie, das für JavaScript unsichtbar (`HttpOnly`), nur über HTTPS (`Secure`) und nur von der eigenen Seite (`SameSite=Strict`) gesendet wird.
- Nach 8 falschen Passwörtern innerhalb von 15 Minuten ist die Anmeldung für 15 Minuten gesperrt.
- Ändert jemand sein Passwort, werden seine anderen Geräte abgemeldet.
- Hochgeladene Fotos werden geprüft (nur JPEG, PNG, WebP, höchstens 8 MB).
- Gelöschte Einträge werden nur als gelöscht markiert, damit „Rückgängig“ funktioniert.

**Beide Passwörter vergessen?** Den Ordner `schulden-daten` in Plesk umbenennen. Die App startet dann wieder mit „Einrichten“, und danach kannst du ein Backup einspielen.

## Lokal ausprobieren

```sh
php -S localhost:8000
```

und http://localhost:8000 öffnen. Die Datenbank wird dann im Ordner über dem Projekt angelegt (`../schulden-daten/`).

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html`, `styles.css` | Aufbau und Aussehen |
| `app.js` | Oberfläche: Anmelden, Einträge, Fotos, Einstellungen, Installations-Hinweis |
| `api/index.php` | Server-Schnittstelle (Anmelden, Speichern, Fotos, Backup …) |
| `api/_lib.php` | Datenbank, Anmeldung, Prüfung der Eingaben |
| `api/config.sample.php` | Vorlage für MySQL-Zugangsdaten (optional) |
| `data/` | Ersatz-Speicherort für Datenbank und Fotos, per `.htaccess` gesperrt |
| `sw.js` | Service Worker: App-Dateien für den Offline-Betrieb |
| `manifest.json`, `icons/`, `screenshots/` | App-Name, Icons und Bilder für den Home-Bildschirm bzw. Installationsdialog |
