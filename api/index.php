<?php
declare(strict_types=1);

// API der Schulden-App. Aufruf: api/index.php?a=<aktion>

define('SCHULDEN', true);
require __DIR__ . '/_lib.php';

try {
    switch ($_GET['a'] ?? '') {
        case 'state':
            action_state();
            break;
        case 'setup':
            action_setup();
            break;
        case 'login':
            action_login();
            break;
        case 'logout':
            action_logout();
            break;
        case 'save':
            action_save();
            break;
        case 'delete':
            action_delete();
            break;
        case 'restore':
            action_restore();
            break;
        case 'delete-all':
            action_delete_all();
            break;
        case 'import':
            action_import();
            break;
        case 'password':
            action_password();
            break;
        case 'partner-password':
            action_partner_password();
            break;
        case 'photo':
            action_photo();
            break;
        case 'photo-upload':
            action_photo_upload();
            break;
        case 'photo-delete':
            action_photo_delete();
            break;
        default:
            fail(404, 'Unbekannte Aktion.');
    }
} catch (Throwable $e) {
    error_log('[schulden] ' . $e);
    fail(500, 'Auf dem Server ist ein Fehler aufgetreten.');
}

function action_state(): void
{
    if (user_count() === 0) {
        respond(['needsSetup' => true, 'user' => null]);
    }
    $user = current_user(); // auch mit Einmal-Passwort, die App zeigt dann „Eigenes Passwort festlegen“
    respond($user === null ? ['needsSetup' => false, 'user' => null] : state($user));
}

/**
 * Legt beim ersten Start beide Konten an. Danach ist keine Registrierung mehr möglich.
 * Die andere Person bekommt ein Einmal-Passwort und legt beim ersten Anmelden ein eigenes fest.
 */
function action_setup(): void
{
    $data = read_json();
    if (user_count() > 0) {
        fail(409, 'Die Konten sind schon eingerichtet. Bitte melde dich an.');
    }

    $me = is_array($data['me'] ?? null) ? $data['me'] : [];
    $other = is_array($data['partner'] ?? null) ? $data['partner'] : [];
    $myRole = ($data['role'] ?? '') === 'lender' ? 'lender' : 'borrower';
    $otherRole = $myRole === 'lender' ? 'borrower' : 'lender';

    $myName = require_name($me['name'] ?? null, 'deinen Namen');
    $myUsername = require_username($me['username'] ?? null, 'Dein Benutzername');
    $myPassword = require_password($me['password'] ?? null, 'Dein Passwort');
    $otherName = require_name($other['name'] ?? null, 'den Namen der anderen Person');
    $otherUsername = require_username($other['username'] ?? null, "Benutzername für $otherName");
    $otherPassword = require_password($other['password'] ?? null, "Das Einmal-Passwort für $otherName");
    if ($myUsername === $otherUsername) {
        fail(422, 'Die beiden Benutzernamen müssen unterschiedlich sein.');
    }

    $db = db();
    $now = time();
    $insert = $db->prepare(
        'INSERT INTO users (username, name, role, password_hash, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    $db->beginTransaction();
    try {
        // Der feste Schlüssel sorgt dafür, dass die Einrichtung nur ein einziges Mal klappt.
        $db->prepare("INSERT INTO meta (k, v) VALUES ('setup', ?)")->execute([(string) $now]);
        $insert->execute([$myUsername, $myName, $myRole, password_hash($myPassword, PASSWORD_DEFAULT), 0, $now]);
        $insert->execute([$otherUsername, $otherName, $otherRole, password_hash($otherPassword, PASSWORD_DEFAULT), 1, $now]);
        $db->commit();
    } catch (PDOException $e) {
        $db->rollBack();
        fail(409, 'Die Konten sind schon eingerichtet. Bitte melde dich an.');
    }

    start_session($myUsername);
    respond(state(['username' => $myUsername, 'name' => $myName, 'role' => $myRole, 'must_change' => 0]));
}

function action_login(): void
{
    $data = read_json();
    $username = is_string($data['username'] ?? null) ? strtolower(trim($data['username'])) : '';
    $password = is_string($data['password'] ?? null) ? $data['password'] : '';
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $now = time();
    $db = db();

    // Schutz gegen Passwort-Raten: nach zu vielen Fehlversuchen 15 Minuten Pause.
    $db->prepare('DELETE FROM login_attempts WHERE attempted_at < ?')->execute([$now - LOGIN_WINDOW_SECONDS]);
    $stmt = $db->prepare('SELECT COUNT(*) FROM login_attempts WHERE ip = ? OR username = ?');
    $stmt->execute([$ip, $username]);
    if ((int) $stmt->fetchColumn() >= LOGIN_MAX_FAILURES) {
        fail(429, 'Zu viele Fehlversuche. Bitte warte 15 Minuten und versuch es dann noch einmal.');
    }

    $user = $username === '' ? null : find_user($username);
    if ($user === null) {
        password_hash($password, PASSWORD_DEFAULT); // gleiche Rechenzeit wie bei einem echten Konto
    }
    if ($user === null || !password_verify($password, $user['password_hash'])) {
        $db->prepare('INSERT INTO login_attempts (ip, username, attempted_at) VALUES (?, ?, ?)')
            ->execute([$ip, substr($username, 0, 30), $now]);
        fail(401, 'Benutzername oder Passwort stimmt nicht.');
    }

    if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
        $db->prepare('UPDATE users SET password_hash = ? WHERE username = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $user['username']]);
    }
    $db->prepare('DELETE FROM login_attempts WHERE username = ?')->execute([$user['username']]);
    $db->prepare('DELETE FROM sessions WHERE last_seen < ?')->execute([$now - SESSION_SECONDS]);

    start_session($user['username']);
    respond(state($user));
}

function action_logout(): void
{
    read_json();
    $hash = session_token_hash();
    if ($hash !== null) {
        db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$hash]);
    }
    set_session_cookie('', 1);
    respond(['ok' => true]);
}

/** Neuer Eintrag oder Änderung. Die ID kommt von der App, damit doppeltes Senden nichts doppelt anlegt. */
function action_save(): void
{
    $user = require_user();
    $entry = clean_entry(read_json());
    if ($entry === null) {
        fail(422, 'Der Eintrag ist unvollständig oder ungültig.');
    }

    $db = db();
    $now = now_ms();
    $stmt = $db->prepare('SELECT id FROM entries WHERE id = ?');
    $stmt->execute([$entry['id']]);
    if ($stmt->fetchColumn() !== false) {
        $db->prepare(
            'UPDATE entries SET dir = ?, cents = ?, entry_date = ?, note = ?, updated_by = ?, updated_at = ?,
                    deleted_by = NULL, deleted_at = NULL
              WHERE id = ?'
        )->execute([$entry['dir'], $entry['cents'], $entry['date'], $entry['note'], $user['username'], $now, $entry['id']]);
    } else {
        $db->prepare(
            'INSERT INTO entries (id, dir, cents, entry_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([$entry['id'], $entry['dir'], $entry['cents'], $entry['date'], $entry['note'], $user['username'], $now]);
    }
    respond(state($user));
}

/** Gelöschte Einträge bleiben in der Datenbank (markiert), damit „Rückgängig“ funktioniert. */
function action_delete(): void
{
    $user = require_user();
    $data = read_json();
    $id = is_string($data['id'] ?? null) ? $data['id'] : '';
    db()->prepare('UPDATE entries SET deleted_by = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
        ->execute([$user['username'], now_ms(), $id]);
    respond(state($user));
}

function action_restore(): void
{
    $user = require_user();
    $data = read_json();
    $ids = is_array($data['ids'] ?? null) ? $data['ids'] : [];
    $db = db();
    $stmt = $db->prepare('UPDATE entries SET deleted_by = NULL, deleted_at = NULL WHERE id = ?');
    $db->beginTransaction();
    foreach ($ids as $id) {
        if (is_string($id)) {
            $stmt->execute([$id]);
        }
    }
    $db->commit();
    respond(state($user));
}

function action_delete_all(): void
{
    $user = require_user();
    read_json();
    $db = db();
    $ids = $db->query('SELECT id FROM entries WHERE deleted_at IS NULL')->fetchAll(PDO::FETCH_COLUMN);
    $db->prepare('UPDATE entries SET deleted_by = ?, deleted_at = ? WHERE deleted_at IS NULL')
        ->execute([$user['username'], now_ms()]);
    respond(state($user, ['deletedIds' => $ids]));
}

/**
 * Backup einspielen: fehlende Einträge kommen dazu, gelöschte werden wiederhergestellt,
 * vorhandene bleiben unverändert.
 */
function action_import(): void
{
    $user = require_user();
    $data = read_json();
    $list = is_array($data['entries'] ?? null) ? array_slice($data['entries'], 0, 10000) : [];

    $db = db();
    $find = $db->prepare('SELECT deleted_at FROM entries WHERE id = ?');
    $insert = $db->prepare(
        'INSERT INTO entries (id, dir, cents, entry_date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    $revive = $db->prepare(
        'UPDATE entries SET dir = ?, cents = ?, entry_date = ?, note = ?, deleted_by = NULL, deleted_at = NULL WHERE id = ?'
    );
    $added = 0;
    $restored = 0;
    $now = now_ms();

    $db->beginTransaction();
    foreach ($list as $raw) {
        $entry = clean_entry($raw);
        if ($entry === null) {
            continue;
        }
        $find->execute([$entry['id']]);
        $row = $find->fetch();
        $find->closeCursor();
        if ($row === false) {
            $createdAt = is_int($raw['createdAt'] ?? null) && $raw['createdAt'] > 0 ? $raw['createdAt'] : $now;
            $insert->execute([$entry['id'], $entry['dir'], $entry['cents'], $entry['date'], $entry['note'], $user['username'], $createdAt]);
            $added++;
        } elseif ($row['deleted_at'] !== null) {
            $revive->execute([$entry['dir'], $entry['cents'], $entry['date'], $entry['note'], $entry['id']]);
            $restored++;
        }
    }
    $db->commit();

    respond(state($user, ['added' => $added, 'restored' => $restored]));
}

/**
 * Eigenes Passwort ändern. Wer sich gerade mit einem Einmal-Passwort angemeldet hat, muss es
 * nicht noch einmal eingeben, aber ein anderes wählen.
 */
function action_password(): void
{
    $user = require_user(true);
    $data = read_json();
    $full = find_user($user['username']);
    $pending = (bool) $full['must_change'];
    if (!$pending && !password_verify(is_string($data['current'] ?? null) ? $data['current'] : '', $full['password_hash'])) {
        fail(403, 'Dein aktuelles Passwort stimmt nicht.');
    }
    $new = require_password($data['new'] ?? null, 'Das neue Passwort');
    if (password_verify($new, $full['password_hash'])) {
        fail(422, $pending
            ? 'Bitte wähle ein anderes Passwort als das Einmal-Passwort.'
            : 'Das neue Passwort ist dasselbe wie das alte.');
    }

    $db = db();
    $db->prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE username = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $user['username']]);
    // Andere Geräte abmelden, dieses bleibt angemeldet.
    $db->prepare('DELETE FROM sessions WHERE username = ? AND token_hash <> ?')
        ->execute([$user['username'], session_token_hash()]);
    $user['must_change'] = 0;
    respond(state($user));
}

/**
 * Falls die andere Person ihr Passwort vergessen hat: Einmal-Passwort setzen, das sie beim
 * nächsten Anmelden durch ein eigenes ersetzen muss. Bestätigung mit dem eigenen Passwort.
 */
function action_partner_password(): void
{
    $user = require_user();
    $data = read_json();
    $full = find_user($user['username']);
    if (!password_verify(is_string($data['current'] ?? null) ? $data['current'] : '', $full['password_hash'])) {
        fail(403, 'Dein eigenes Passwort stimmt nicht.');
    }
    $stmt = db()->prepare('SELECT username, name FROM users WHERE username <> ?');
    $stmt->execute([$user['username']]);
    $partner = $stmt->fetch();
    if (!$partner) {
        fail(404, 'Es gibt kein zweites Konto.');
    }
    $new = require_password($data['new'] ?? null, "Das Einmal-Passwort für {$partner['name']}");

    $db = db();
    $db->prepare('UPDATE users SET password_hash = ?, must_change = 1 WHERE username = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $partner['username']]);
    $db->prepare('DELETE FROM sessions WHERE username = ?')->execute([$partner['username']]);
    respond(state($user));
}

/** Foto ausliefern – nur für Angemeldete, die Dateien liegen nicht im Web-Ordner. */
function action_photo(): void
{
    require_user();
    $id = $_GET['id'] ?? '';
    if (!valid_id($id)) {
        fail(404, 'Foto nicht gefunden.');
    }
    $stmt = db()->prepare('SELECT file, mime FROM photos WHERE id = ?');
    $stmt->execute([$id]);
    $photo = $stmt->fetch();
    $path = $photo ? photo_dir() . '/' . $photo['file'] : '';
    if (!$photo || !is_file($path)) {
        fail(404, 'Foto nicht gefunden.');
    }

    header('Content-Type: ' . $photo['mime']);
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: inline');
    header('Cache-Control: private, max-age=31536000, immutable');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'");
    readfile($path);
    exit;
}

/** Foto (Beleg) an einen Eintrag hängen. Die App verkleinert Fotos vorher auf eine handliche Größe. */
function action_photo_upload(): void
{
    $user = require_user();
    require_post();

    // Ist die Anfrage größer als post_max_size, verwirft PHP alle Felder.
    if (empty($_POST) && empty($_FILES) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        fail(413, 'Das Foto ist zu groß für den Server.');
    }
    $id = $_POST['id'] ?? '';
    $entryId = $_POST['entry'] ?? '';
    if (!valid_id($id) || !valid_id($entryId)) {
        fail(422, 'Ungültige Angaben zum Foto.');
    }
    if (find_entry($entryId) === null) {
        fail(404, 'Den Eintrag zu diesem Foto gibt es nicht (mehr).');
    }

    $db = db();
    $stmt = $db->prepare('SELECT id FROM photos WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->fetchColumn() !== false) {
        respond(state($user)); // schon hochgeladen (z. B. erneuter Versuch nach Verbindungsabbruch)
    }
    $stmt = $db->prepare('SELECT COUNT(*) FROM photos WHERE entry_id = ?');
    $stmt->execute([$entryId]);
    if ((int) $stmt->fetchColumn() >= MAX_PHOTOS_PER_ENTRY) {
        fail(422, 'Mehr als ' . MAX_PHOTOS_PER_ENTRY . ' Fotos pro Eintrag gehen nicht.');
    }

    $file = $_FILES['photo'] ?? null;
    $error = is_array($file) ? ($file['error'] ?? UPLOAD_ERR_NO_FILE) : UPLOAD_ERR_NO_FILE;
    if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
        fail(413, 'Das Foto ist zu groß für den Server.');
    }
    if ($error !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
        fail(400, 'Das Foto ist nicht richtig angekommen. Bitte versuch es noch einmal.');
    }
    if ($file['size'] > MAX_PHOTO_BYTES) {
        fail(413, 'Das Foto ist zu groß (höchstens 8 MB).');
    }
    $types = [IMAGETYPE_JPEG => 'image/jpeg', IMAGETYPE_PNG => 'image/png', IMAGETYPE_WEBP => 'image/webp'];
    $info = @getimagesize($file['tmp_name']);
    if ($info === false || !isset($types[$info[2]])) {
        fail(415, 'Das ist kein unterstütztes Bild (JPEG, PNG oder WebP).');
    }

    // Eigener Zufallsname ohne Endung: nicht erratbar und wird nie als Bild direkt ausgeliefert.
    $name = bin2hex(random_bytes(16));
    if (!move_uploaded_file($file['tmp_name'], photo_dir() . '/' . $name)) {
        throw new RuntimeException('Foto konnte nicht gespeichert werden');
    }
    $db->prepare(
        'INSERT INTO photos (id, entry_id, file, mime, bytes, width, height, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([$id, $entryId, $name, $types[$info[2]], (int) $file['size'], (int) $info[0], (int) $info[1], $user['username'], now_ms()]);

    respond(state($user));
}

function action_photo_delete(): void
{
    $user = require_user();
    $data = read_json();
    $id = $data['id'] ?? '';
    if (valid_id($id)) {
        $db = db();
        $stmt = $db->prepare('SELECT file FROM photos WHERE id = ?');
        $stmt->execute([$id]);
        $file = $stmt->fetchColumn();
        if ($file !== false) {
            $db->prepare('DELETE FROM photos WHERE id = ?')->execute([$id]);
            @unlink(photo_dir() . '/' . $file);
        }
    }
    respond(state($user));
}
