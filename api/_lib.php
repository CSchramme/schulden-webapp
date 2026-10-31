<?php
declare(strict_types=1);

// Gemeinsame Funktionen der API. Wird nur von api/index.php eingebunden.
if (!defined('SCHULDEN')) {
    http_response_code(404);
    exit;
}

const SESSION_COOKIE = 'schulden_session';
const SESSION_SECONDS = 365 * 24 * 3600;
const MAX_CENTS = 10000000000; // 100 Mio. €
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 8;
const SCHEMA_VERSION = 3;
const MAX_PHOTOS_PER_ENTRY = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

// ---------- Antworten und Anfragen ----------

function respond(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    send_queued_notifications();
    exit;
}

function fail(int $status, string $message): void
{
    respond(['error' => $message], $status);
}

/** Nur POST mit Zusatz-Header – das schützt vor Anfragen, die von fremden Seiten ausgelöst werden. */
function require_post(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        fail(405, 'Diese Aktion geht nur per POST.');
    }
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'schulden') {
        fail(403, 'Ungültige Anfrage.');
    }
}

/** Liest den JSON-Body einer POST-Anfrage. */
function read_json(): array
{
    require_post();
    $data = json_decode((string) file_get_contents('php://input', false, null, 0, 5000000), true);
    if (!is_array($data)) {
        fail(400, 'Ungültige Daten.');
    }
    return $data;
}

function now_ms(): int
{
    return (int) floor(microtime(true) * 1000);
}

// ---------- Datenbank ----------

function config(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        $loaded = is_file($file) ? require $file : [];
        $config = is_array($loaded) ? $loaded : [];
    }
    return $config;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $cfg = config();
        if (!empty($cfg['db_dsn'])) {
            $pdo = new PDO($cfg['db_dsn'], $cfg['db_user'] ?? null, $cfg['db_pass'] ?? null);
        } else {
            $pdo = new PDO('sqlite:' . sqlite_path());
        }
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        if (db_driver($pdo) === 'sqlite') {
            $pdo->exec('PRAGMA busy_timeout = 5000');
            $pdo->exec('PRAGMA journal_mode = WAL');
        }
        migrate($pdo);
    }
    return $pdo;
}

function db_driver(PDO $pdo): string
{
    return (string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
}

/**
 * Ordner für Datenbank-Datei und Fotos. Bevorzugt ein Ordner neben dem Web-Ordner, damit
 * nichts davon über das Internet abrufbar ist (bei Plesk: /var/www/vhosts/<domain>/schulden-daten).
 * Geht das nicht, wird der Ordner data/ der App genutzt, der per .htaccess gesperrt ist.
 */
function data_dir(): string
{
    static $dir = null;
    if ($dir !== null) {
        return $dir;
    }

    $inside = inside_data_dir();
    $outside = outside_data_dir();

    // Einen Ordner, in dem schon eine Datenbank liegt, immer weiterverwenden.
    if ($outside !== null && @is_file($outside . '/schulden.sqlite')) {
        return $dir = $outside;
    }
    if (is_file($inside . '/.ht.schulden.sqlite')) {
        return $dir = $inside;
    }
    if ($outside !== null && (@is_dir($outside) || @mkdir($outside, 0700)) && @is_writable($outside)) {
        return $dir = $outside;
    }
    if (!is_dir($inside)) {
        mkdir($inside, 0700, true);
    }
    return $dir = $inside;
}

function inside_data_dir(): string
{
    return dirname(__DIR__) . '/data';
}

/** Im Ersatz-Ordner beginnt der Name mit ".ht", den Apache zusätzlich von sich aus sperrt. */
function sqlite_path(): string
{
    $dir = data_dir();
    return $dir . ($dir === inside_data_dir() ? '/.ht.schulden.sqlite' : '/schulden.sqlite');
}

function photo_dir(): string
{
    $dir = data_dir() . '/belege';
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    return $dir;
}

function outside_data_dir(): ?string
{
    $docRoot = (string) ($_SERVER['DOCUMENT_ROOT'] ?? '');
    $root = $docRoot === '' ? false : realpath($docRoot);
    if ($root === false) {
        return null;
    }
    $parent = dirname($root);
    return $parent === $root ? null : $parent . '/schulden-daten';
}

function storage_info(): array
{
    $dsn = (string) (config()['db_dsn'] ?? '');
    $photos = data_dir() . '/belege';
    if (db_driver(db()) === 'sqlite') {
        return [
            'type' => 'SQLite-Datei',
            'location' => strpos($dsn, 'sqlite:') === 0 ? substr($dsn, 7) : sqlite_path(),
            'photos' => $photos,
        ];
    }
    return [
        'type' => 'MySQL-Datenbank',
        'location' => preg_match('/dbname=([^;]+)/', $dsn, $m) ? $m[1] : '',
        'photos' => $photos,
    ];
}

function migrate(PDO $pdo): void
{
    $version = 0;
    try {
        $version = (int) $pdo->query("SELECT v FROM meta WHERE k = 'schema'")->fetchColumn();
    } catch (PDOException $e) {
        // Datenbank ist noch leer.
    }
    if ($version >= SCHEMA_VERSION) {
        return;
    }

    // Bewusst schlichtes SQL, das in SQLite und MySQL/MariaDB gleich funktioniert.
    $suffix = db_driver($pdo) === 'mysql' ? ' DEFAULT CHARSET=utf8mb4' : '';
    if ($version < 1) {
        migrate_v1($pdo, $suffix);
    }
    if ($version < 2) {
        // Einmal-Passwort: die Person muss beim nächsten Anmelden ein eigenes festlegen.
        if (!column_exists($pdo, 'users', 'must_change')) {
            $pdo->exec('ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
        }
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS photos (
                id VARCHAR(64) NOT NULL PRIMARY KEY,
                entry_id VARCHAR(64) NOT NULL,
                file VARCHAR(64) NOT NULL,
                mime VARCHAR(20) NOT NULL,
                bytes BIGINT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                created_by VARCHAR(30) NOT NULL,
                created_at BIGINT NOT NULL
            )' . $suffix
        );
    }
    if ($version < 3) {
        // Benachrichtigungen per ntfy, jede Person mit eigenem Kanal.
        $columns = [
            'ntfy_server' => 'VARCHAR(200)',
            'ntfy_topic' => 'VARCHAR(64)',
            'ntfy_token' => 'VARCHAR(200)',
        ];
        foreach ($columns as $column => $type) {
            if (!column_exists($pdo, 'users', $column)) {
                $pdo->exec("ALTER TABLE users ADD COLUMN $column $type NOT NULL DEFAULT ''");
            }
        }
    }

    $pdo->prepare("UPDATE meta SET v = ? WHERE k = 'schema'")->execute([(string) SCHEMA_VERSION]);
    try {
        $pdo->prepare("INSERT INTO meta (k, v) VALUES ('schema', ?)")->execute([(string) SCHEMA_VERSION]);
    } catch (PDOException $e) {
        // Eintrag gab es schon (oben aktualisiert) oder eine parallele Anfrage war schneller.
    }
}

function column_exists(PDO $pdo, string $table, string $column): bool
{
    try {
        $pdo->query("SELECT $column FROM $table WHERE 1 = 0");
        return true;
    } catch (PDOException $e) {
        return false;
    }
}

function migrate_v1(PDO $pdo, string $suffix): void
{
    $tables = [
        'CREATE TABLE IF NOT EXISTS meta (
            k VARCHAR(30) NOT NULL PRIMARY KEY,
            v VARCHAR(255) NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS users (
            username VARCHAR(30) NOT NULL PRIMARY KEY,
            name VARCHAR(40) NOT NULL,
            role VARCHAR(10) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at BIGINT NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS sessions (
            token_hash CHAR(64) NOT NULL PRIMARY KEY,
            username VARCHAR(30) NOT NULL,
            created_at BIGINT NOT NULL,
            last_seen BIGINT NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS entries (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            dir VARCHAR(10) NOT NULL,
            cents BIGINT NOT NULL,
            entry_date CHAR(10) NOT NULL,
            note VARCHAR(255) NOT NULL,
            created_by VARCHAR(30) NOT NULL,
            created_at BIGINT NOT NULL,
            updated_by VARCHAR(30) NULL,
            updated_at BIGINT NULL,
            deleted_by VARCHAR(30) NULL,
            deleted_at BIGINT NULL
        )',
        'CREATE TABLE IF NOT EXISTS login_attempts (
            ip VARCHAR(45) NOT NULL,
            username VARCHAR(30) NOT NULL,
            attempted_at BIGINT NOT NULL
        )',
    ];
    foreach ($tables as $sql) {
        $pdo->exec($sql . $suffix);
    }
}

// ---------- Anmeldung ----------

function base_path(): string
{
    $dir = str_replace('\\', '/', dirname(dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/api/index.php'))));
    return rtrim($dir, '/') . '/';
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
        || (string) ($_SERVER['SERVER_PORT'] ?? '') === '443';
}

function set_session_cookie(string $value, int $expires): void
{
    setcookie(SESSION_COOKIE, $value, [
        'expires' => $expires,
        'path' => base_path(),
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function start_session(string $username): void
{
    $token = bin2hex(random_bytes(32));
    $now = time();
    db()->prepare('INSERT INTO sessions (token_hash, username, created_at, last_seen) VALUES (?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $username, $now, $now]);
    set_session_cookie($token, $now + SESSION_SECONDS);
}

function session_token_hash(): ?string
{
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    return is_string($token) && preg_match('/^[a-f0-9]{64}$/', $token) ? hash('sha256', $token) : null;
}

function current_user(): ?array
{
    $hash = session_token_hash();
    if ($hash === null) {
        return null;
    }
    $stmt = db()->prepare(
        'SELECT s.last_seen, u.username, u.name, u.role, u.must_change
           FROM sessions s JOIN users u ON u.username = s.username
          WHERE s.token_hash = ?'
    );
    $stmt->execute([$hash]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }

    $now = time();
    if ((int) $row['last_seen'] < $now - SESSION_SECONDS) {
        db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$hash]);
        return null;
    }
    // Wer die App nutzt, bleibt angemeldet: Ablaufdatum höchstens einmal am Tag verlängern.
    if ((int) $row['last_seen'] < $now - 24 * 3600) {
        db()->prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?')->execute([$now, $hash]);
        set_session_cookie((string) $_COOKIE[SESSION_COOKIE], $now + SESSION_SECONDS);
    }
    return [
        'username' => $row['username'],
        'name' => $row['name'],
        'role' => $row['role'],
        'must_change' => (int) $row['must_change'],
    ];
}

/** Angemeldete Person. Wer noch das Einmal-Passwort hat, darf nur ein eigenes Passwort festlegen. */
function require_user(bool $allowPendingPassword = false): array
{
    $user = current_user();
    if ($user === null) {
        fail(401, 'Bitte melde dich an.');
    }
    if ($user['must_change'] && !$allowPendingPassword) {
        fail(403, 'Bitte lege zuerst dein eigenes Passwort fest.');
    }
    return $user;
}

function find_user(string $username): ?array
{
    $stmt = db()->prepare(
        'SELECT username, name, role, must_change, password_hash, ntfy_server, ntfy_topic, ntfy_token
           FROM users WHERE username = ?'
    );
    $stmt->execute([$username]);
    return $stmt->fetch() ?: null;
}

/** Die jeweils andere Person (es gibt genau zwei Konten). */
function partner_of(string $username): ?array
{
    $stmt = db()->prepare('SELECT username FROM users WHERE username <> ?');
    $stmt->execute([$username]);
    $other = $stmt->fetchColumn();
    return $other === false ? null : find_user($other);
}

function user_count(): int
{
    return (int) db()->query('SELECT COUNT(*) FROM users')->fetchColumn();
}

// ---------- Eingaben prüfen ----------

/** Text säubern (Leerraum zusammenfassen) und auf $max Zeichen kürzen. Ungültiges UTF-8 → null. */
function clean_text($value, int $max): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $value = preg_replace('/\s+/u', ' ', $value);
    if ($value === null || !preg_match('/^.{0,' . $max . '}/u', trim($value), $m)) {
        return null;
    }
    return trim($m[0]);
}

function require_name($value, string $label): string
{
    $name = clean_text($value, 40);
    if ($name === null || $name === '') {
        fail(422, "Bitte $label angeben.");
    }
    return $name;
}

function require_username($value, string $label): string
{
    $username = is_string($value) ? strtolower(trim($value)) : '';
    if (!preg_match('/^[a-z0-9._-]{2,30}$/', $username)) {
        fail(422, "$label: 2–30 Zeichen, nur Buchstaben a–z, Ziffern, Punkt, Minus oder Unterstrich.");
    }
    return $username;
}

function require_password($value, string $label): string
{
    if (!is_string($value) || strlen($value) < 8) {
        fail(422, "$label muss mindestens 8 Zeichen lang sein.");
    }
    if (strlen($value) > 200) {
        fail(422, "$label ist zu lang.");
    }
    return $value;
}

function clean_entry($raw): ?array
{
    if (!is_array($raw)) {
        return null;
    }
    $id = $raw['id'] ?? null;
    $dir = $raw['dir'] ?? null;
    $cents = $raw['cents'] ?? null;
    $date = $raw['date'] ?? null;
    $note = clean_text($raw['note'] ?? '', 120);

    if (!valid_id($id)) {
        return null;
    }
    if ($dir !== 'borrow' && $dir !== 'repay') {
        return null;
    }
    if (!is_int($cents) || $cents < 1 || $cents > MAX_CENTS) {
        return null;
    }
    if (!is_string($date) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m)
        || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        return null;
    }
    if ($note === null) {
        return null;
    }
    return ['id' => $id, 'dir' => $dir, 'cents' => $cents, 'date' => $date, 'note' => $note];
}

// ---------- Daten für die App ----------

function load_entries(): array
{
    $rows = db()->query(
        'SELECT e.id, e.dir, e.cents, e.entry_date, e.note, e.created_at, e.updated_at,
                cu.name AS created_name, uu.name AS updated_name
           FROM entries e
           LEFT JOIN users cu ON cu.username = e.created_by
           LEFT JOIN users uu ON uu.username = e.updated_by
          WHERE e.deleted_at IS NULL
          ORDER BY e.entry_date, e.created_at'
    )->fetchAll();

    $photos = [];
    foreach (db()->query('SELECT id, entry_id, width, height FROM photos ORDER BY created_at') as $photo) {
        $photos[$photo['entry_id']][] = ['id' => $photo['id'], 'w' => (int) $photo['width'], 'h' => (int) $photo['height']];
    }

    return array_map(static function (array $row) use ($photos): array {
        return [
            'id' => $row['id'],
            'dir' => $row['dir'],
            'cents' => (int) $row['cents'],
            'date' => $row['entry_date'],
            'note' => $row['note'],
            'createdAt' => (int) $row['created_at'],
            'createdBy' => $row['created_name'],
            'updatedAt' => $row['updated_at'] === null ? null : (int) $row['updated_at'],
            'updatedBy' => $row['updated_name'],
            'photos' => $photos[$row['id']] ?? [],
        ];
    }, $rows);
}

/** Alles, was die App nach dem Anmelden braucht. */
function state(array $user, array $extra = []): array
{
    $own = find_user($user['username']);
    $partner = partner_of($user['username']);
    $pending = (bool) $user['must_change'];

    return array_merge([
        'needsSetup' => false,
        'user' => [
            'username' => $user['username'],
            'name' => $user['name'],
            'role' => $user['role'],
            'mustChangePassword' => $pending,
            // Der Token wird nie zurückgegeben, nur ob einer hinterlegt ist.
            'ntfy' => [
                'server' => $own['ntfy_server'],
                'topic' => $own['ntfy_topic'],
                'hasToken' => $own['ntfy_token'] !== '',
            ],
        ],
        'partner' => $partner === null ? null : [
            'username' => $partner['username'],
            'name' => $partner['name'],
            'role' => $partner['role'],
            'passwordPending' => (bool) $partner['must_change'],
            'notifications' => $partner['ntfy_topic'] !== '',
        ],
        // Mit Einmal-Passwort gibt es erst nach dem Festlegen des eigenen Passworts Daten.
        'entries' => $pending ? [] : load_entries(),
        'storage' => $pending ? null : storage_info(),
    ], $extra);
}

/** Eintrag holen, der nicht gelöscht ist. */
function find_entry(string $id): ?array
{
    $stmt = db()->prepare('SELECT id FROM entries WHERE id = ? AND deleted_at IS NULL');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function valid_id($id): bool
{
    return is_string($id) && preg_match('/^[A-Za-z0-9_-]{6,64}$/', $id) === 1;
}

// ---------- Benachrichtigungen (ntfy) ----------

function app_url(): string
{
    $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
    return (is_https() ? 'https://' : 'http://') . $host . base_path();
}

function euro_text(int $cents): string
{
    return number_format($cents / 100, 2, ',', '.') . ' €';
}

/** Art des Eintrags aus Sicht der Person mit dieser Rolle. */
function dir_label(string $dir, string $role): string
{
    if ($role === 'lender') {
        return $dir === 'borrow' ? 'Verliehen' : 'Zurückbekommen';
    }
    return $dir === 'borrow' ? 'Geliehen' : 'Zurückgezahlt';
}

/** Aktueller Stand aus Sicht von $recipient, $otherName ist die andere Person. */
function balance_text(array $recipient, string $otherName): string
{
    $balance = (int) db()->query(
        "SELECT COALESCE(SUM(CASE WHEN dir = 'borrow' THEN cents ELSE -cents END), 0) FROM entries WHERE deleted_at IS NULL"
    )->fetchColumn();
    if ($balance === 0) {
        return 'Ihr seid quitt';
    }
    // Positiver Stand: die Person mit der Rolle "borrower" hat Schulden.
    $recipientOwes = ($recipient['role'] === 'borrower') === ($balance > 0);
    return $recipientOwes
        ? "Du schuldest $otherName " . euro_text(abs($balance))
        : "$otherName schuldet dir " . euro_text(abs($balance));
}

function entry_summary(array $entry, string $role): string
{
    $text = dir_label($entry['dir'], $role) . ': ' . euro_text((int) $entry['cents']);
    if ($entry['note'] !== '') {
        $text .= ' · ' . $entry['note'];
    }
    if ($entry['date'] !== date('Y-m-d')) {
        [$y, $m, $d] = explode('-', $entry['date']);
        $text .= " (vom $d.$m.$y)";
    }
    return $text;
}

/**
 * Der anderen Person Bescheid geben, wenn $actor etwas geändert hat.
 * $event: created, updated, deleted, restored, deleted-all, imported, joined
 */
function notify_partner(array $actor, string $event, ?array $entry = null, array $details = []): void
{
    $recipient = partner_of($actor['username']);
    if ($recipient === null || $recipient['ntfy_topic'] === '') {
        return;
    }
    $name = $actor['name'];
    $role = $recipient['role'];
    $count = (int) ($details['count'] ?? 0);
    $lines = [];

    switch ($event) {
        case 'created':
            $title = "$name hat etwas eingetragen";
            $lines[] = entry_summary($entry, $role);
            break;
        case 'updated':
            $title = "$name hat einen Eintrag geändert";
            $line = entry_summary($entry, $role);
            if (isset($details['before']) && (int) $details['before']['cents'] !== (int) $entry['cents']) {
                $line .= ', vorher ' . euro_text((int) $details['before']['cents']);
            }
            $lines[] = $line;
            break;
        case 'deleted':
            $title = "$name hat einen Eintrag gelöscht";
            $lines[] = entry_summary($entry, $role);
            break;
        case 'restored':
            $title = $count === 1 ? "$name hat einen Eintrag wiederhergestellt" : "$name hat $count Einträge wiederhergestellt";
            break;
        case 'deleted-all':
            $title = "$name hat alle Einträge gelöscht";
            $lines[] = $count === 1 ? '1 Eintrag' : "$count Einträge";
            break;
        case 'imported':
            $title = "$name hat ein Backup eingespielt";
            $lines[] = $count === 1 ? '1 Eintrag dazugekommen' : "$count Einträge dazugekommen";
            break;
        case 'joined':
            queue_notification($recipient, "$name ist jetzt dabei", "$name hat sich angemeldet und ein eigenes Passwort festgelegt.");
            return;
        default:
            return;
    }
    $lines[] = 'Stand: ' . balance_text($recipient, $name);
    queue_notification($recipient, $title, implode("\n", $lines));
}

function queue_notification(array $recipient, string $title, string $message): void
{
    $GLOBALS['schulden_outbox'][] = [$recipient, $title, $message];
}

/** Erst die Antwort an die App schicken, dann die Benachrichtigungen – so wartet niemand darauf. */
function send_queued_notifications(): void
{
    $outbox = $GLOBALS['schulden_outbox'] ?? [];
    if (!$outbox) {
        return;
    }
    $GLOBALS['schulden_outbox'] = [];
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    } elseif (function_exists('litespeed_finish_request')) {
        litespeed_finish_request();
    }
    foreach ($outbox as [$recipient, $title, $message]) {
        $result = ntfy_send($recipient, $title, $message);
        if ($result !== null) {
            error_log("[schulden] ntfy an {$recipient['username']}: $result");
        }
    }
}

/** Nachricht über ntfy schicken. Rückgabe: null bei Erfolg, sonst eine Fehlerbeschreibung. */
function ntfy_send(array $recipient, string $title, string $message): ?string
{
    $server = rtrim($recipient['ntfy_server'] !== '' ? $recipient['ntfy_server'] : NTFY_DEFAULT_SERVER, '/');
    $payload = json_encode([
        'topic' => $recipient['ntfy_topic'],
        'title' => $title,
        'message' => $message,
        'tags' => ['moneybag'],
        'click' => app_url(),
        'icon' => app_url() . 'icons/icon-192.png',
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $headers = ['Content-Type: application/json'];
    if ($recipient['ntfy_token'] !== '') {
        $headers[] = 'Authorization: Bearer ' . $recipient['ntfy_token'];
    }

    if (function_exists('curl_init')) {
        $ch = curl_init($server . '/');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => 8,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        unset($ch);
        if ($body === false) {
            return "keine Verbindung zu $server ($error)";
        }
    } else {
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $payload,
            'timeout' => 8,
            'ignore_errors' => true,
        ]]);
        $body = @file_get_contents($server . '/', false, $context);
        $status = isset($http_response_header[0]) && preg_match('/\s(\d{3})\s?/', $http_response_header[0], $m) ? (int) $m[1] : 0;
        if ($body === false || $status === 0) {
            return "keine Verbindung zu $server";
        }
    }
    if ($status >= 200 && $status < 300) {
        return null;
    }
    $reason = json_decode((string) $body, true)['error'] ?? '';
    return "ntfy antwortet mit Fehler $status" . ($reason !== '' ? " ($reason)" : '');
}
