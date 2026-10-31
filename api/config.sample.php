<?php
// Optional: Nur nötig, wenn du statt der automatisch angelegten SQLite-Datei
// eine MySQL/MariaDB-Datenbank aus Plesk nutzen willst.
// Datei kopieren nach api/config.php und die Zugangsdaten eintragen.
// Achtung: config.php nie ins (öffentliche) Git-Repository hochladen.

return [
    'db_dsn' => 'mysql:host=localhost;dbname=schulden;charset=utf8mb4',
    'db_user' => 'schulden',
    'db_pass' => 'HIER-DAS-PASSWORT',
];
