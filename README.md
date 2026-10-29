# Schulden

Kleine Web-App, mit der zwei Personen (z. B. ich und Papa) festhalten, wie viel Geld geliehen und zurückgezahlt wurde – statt alles auf Papier zu schreiben. Beide melden sich mit eigenem Konto an und sehen dieselben Einträge. Die App lässt sich auf den Home-Bildschirm legen und zeigt ohne Internet den letzten Stand.

## Funktionen

- Aktueller Stand auf einen Blick, jeweils aus eigener Sicht („Du schuldest Papa …“ bzw. „Tim schuldet dir …“)
- Einträge mit Betrag, Notiz und Datum; beide können eintragen, ändern und löschen (mit „Rückgängig“)
- Verlauf nach Monaten, mit Stand nach jedem Eintrag und dem Anfangsbuchstaben der Person, die eingetragen hat
- Anmeldung mit Benutzername und Passwort, bleibt auf dem Gerät angemeldet
- Passwort ändern; Passwort der anderen Person zurücksetzen, falls vergessen
- Backup als Datei (JSON), Backup einspielen, Export als Tabelle (CSV für Excel/Numbers)
- Hell- und Dunkelmodus

## Installation auf Plesk

Voraussetzungen: PHP 7.4 oder neuer (unter **Websites & Domains → PHP** prüfen, 8.x empfohlen) und ein SSL-Zertifikat (z. B. Let's Encrypt). Ohne HTTPS lässt sich die App nicht auf dem Home-Bildschirm installieren.

1. Diese Dateien und Ordner in `httpdocs` hochladen (oder in einen Unterordner wie `httpdocs/schulden`), z. B. mit dem Plesk-**Dateimanager** oder per FTP:
   `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`, `api/`, `data/`

   Alternativ in Plesk unter **Git** dieses Repository verbinden und automatisch nach `httpdocs` ausliefern lassen.
2. Die Adresse im Browser öffnen. Beim ersten Aufruf erscheint **Einrichten**: dort direkt die beiden Konten anlegen (deins und das deines Vaters). Danach ist keine weitere Registrierung möglich.
3. Deinem Vater Adresse, Benutzername und Passwort geben. Er meldet sich unter derselben Adresse an.

Lag schon die erste Version ohne Login auf dem Server, einfach alle Dateien ersetzen. Die installierte App meldet „Neue Version verfügbar“. Nach dem ersten Anmelden bietet sie an, die bisher nur auf dem Handy gespeicherten Einträge hochzuladen.

## Wo werden die Daten gespeichert?

Auf deinem Server, in einer SQLite-Datenbank. Die Datei wird beim ersten Aufruf automatisch angelegt, und zwar **außerhalb** des Web-Ordners, damit sie nie über das Internet abrufbar ist:

```
/var/www/vhosts/<deine-domain>/schulden-daten/schulden.sqlite
```

Den genauen Pfad zeigt die App unter **Einstellungen → Daten**. Kann PHP dort keinen Ordner anlegen, landet die Datei stattdessen in `data/.ht.schulden.sqlite` innerhalb der App. Dieser Ordner ist per `.htaccess` gesperrt.

Die Datei liegt im Webspace und wird deshalb normalerweise vom Plesk-Backup erfasst. Zusätzlich kannst du in der App jederzeit **Backup als Datei speichern**.

**Lieber MySQL/MariaDB?** In Plesk unter **Datenbanken** eine Datenbank anlegen, `api/config.sample.php` nach `api/config.php` kopieren und die Zugangsdaten eintragen. `config.php` niemals ins Git-Repository hochladen, sie steht deshalb in `.gitignore`.

## Sicherheit

- Passwörter werden nur als Hash gespeichert (`password_hash`, bcrypt).
- Die Anmeldung läuft über ein Cookie, das für JavaScript unsichtbar (`HttpOnly`), nur über HTTPS (`Secure`) und nur von der eigenen Seite (`SameSite=Strict`) gesendet wird.
- Nach 8 falschen Passwörtern innerhalb von 15 Minuten ist die Anmeldung für 15 Minuten gesperrt.
- Ändert jemand sein Passwort, werden seine anderen Geräte abgemeldet.
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
| `app.js` | Oberfläche: Anmelden, Einträge, Einstellungen, Installations-Hinweis |
| `api/index.php` | Server-Schnittstelle (Anmelden, Speichern, Löschen, Backup …) |
| `api/_lib.php` | Datenbank, Anmeldung, Prüfung der Eingaben |
| `api/config.sample.php` | Vorlage für MySQL-Zugangsdaten (optional) |
| `data/` | Ersatz-Speicherort der Datenbank, per `.htaccess` gesperrt |
| `sw.js` | Service Worker: App-Dateien für den Offline-Betrieb |
| `manifest.webmanifest`, `icons/` | App-Name und Icons für den Home-Bildschirm |
