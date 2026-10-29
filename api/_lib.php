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
const SCHEMA_VERSION = '1';

// ---------- Antworten und Anfragen ----------

function respond(array $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function fail(int $status, string $message): void
{
    respond(['error' => $message], $status);
}

/** Liest den JSON-Body einer POST-Anfrage. Der Zusatz-Header schützt vor Anfragen fremder Seiten. */
function read_json(): array
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        fail(405, 'Diese Aktion geht nur per POST.');
    }
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'schulden') {
        fail(403, 'Ungültige Anfrage.');
    }
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
 * Ort der SQLite-Datei. Bevorzugt ein Ordner neben dem Web-Ordner, damit die Datei nie
 * über das Internet abrufbar ist (bei Plesk: /var/www/vhosts/<domain>/schulden-daten).
 * Geht das nicht, landet sie im Ordner data/ der App, der per .htaccess gesperrt ist.
 */
function sqlite_path(): string
{
    static $path = null;
    if ($path !== null) {
        return $path;
    }

    $insideDir = dirname(__DIR__) . '/data';
    $inside = $insideDir . '/.ht.schulden.sqlite';
    $outsideDir = outside_data_dir();
    $outside = $outsideDir === null ? null : $outsideDir . '/schulden.sqlite';

    // Eine vorhandene Datei immer weiterverwenden.
    if ($outside !== null && @is_file($outside)) {
        return $path = $outside;
    }
    if (is_file($inside)) {
        return $path = $inside;
    }
    if ($outside !== null && (@is_dir($outsideDir) || @mkdir($outsideDir, 0700)) && @is_writable($outsideDir)) {
        return $path = $outside;
    }
    if (!is_dir($insideDir)) {
        mkdir($insideDir, 0700, true);
    }
    return $path = $inside;
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
    if (db_driver(db()) === 'sqlite') {
        return [
            'type' => 'SQLite-Datei',
            'location' => strpos($dsn, 'sqlite:') === 0 ? substr($dsn, 7) : sqlite_path(),
        ];
    }
    return [
        'type' => 'MySQL-Datenbank',
        'location' => preg_match('/dbname=([^;]+)/', $dsn, $m) ? $m[1] : '',
    ];
}

function migrate(PDO $pdo): void
{
    try {
        if ($pdo->query("SELECT v FROM meta WHERE k = 'schema'")->fetchColumn() === SCHEMA_VERSION) {
            return;
        }
    } catch (PDOException $e) {
        // Datenbank ist noch leer.
    }

    // Bewusst schlichtes SQL, das in SQLite und MySQL/MariaDB gleich funktioniert.
    $suffix = db_driver($pdo) === 'mysql' ? ' DEFAULT CHARSET=utf8mb4' : '';
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
    try {
        $pdo->prepare("INSERT INTO meta (k, v) VALUES ('schema', ?)")->execute([SCHEMA_VERSION]);
    } catch (PDOException $e) {
        // Eine parallele Anfrage war schneller.
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
        'SELECT s.last_seen, u.username, u.name, u.role
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
    return ['username' => $row['username'], 'name' => $row['name'], 'role' => $row['role']];
}

function require_user(): array
{
    $user = current_user();
    if ($user === null) {
        fail(401, 'Bitte melde dich an.');
    }
    return $user;
}

function find_user(string $username): ?array
{
    $stmt = db()->prepare('SELECT username, name, role, password_hash FROM users WHERE username = ?');
    $stmt->execute([$username]);
    return $stmt->fetch() ?: null;
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

    if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{6,64}$/', $id)) {
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

    return array_map(static function (array $row): array {
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
        ];
    }, $rows);
}

/** Alles, was die App nach dem Anmelden braucht. */
function state(array $user, array $extra = []): array
{
    $stmt = db()->prepare('SELECT username, name, role FROM users WHERE username <> ?');
    $stmt->execute([$user['username']]);

    return array_merge([
        'needsSetup' => false,
        'user' => ['username' => $user['username'], 'name' => $user['name'], 'role' => $user['role']],
        'partner' => $stmt->fetch() ?: null,
        'entries' => load_entries(),
        'storage' => storage_info(),
    ], $extra);
}
