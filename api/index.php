<?php
/**
 * doit — API penghubung frontend ↔ MySQL (doit_db)
 * ----------------------------------------------------
 * GET  api/index.php   → kirim seluruh state (folders, tasks, subtasks, settings) dari database
 * POST api/index.php   → terima seluruh state dari app, lalu database disamakan
 *                        (tambah / ubah / hapus) dalam satu transaksi. Balas dengan
 *                        state resmi dari database (termasuk id baru dari AUTO_INCREMENT).
 *
 * Kolom `tasks.done_on` dipakai untuk menghitung statistik harian (streak, bar, heatmap)
 * sehingga tidak dibutuhkan tabel log tersendiri.
 */

require __DIR__ . '/config.php';
cors();

/* =========================================================
   PEMBANTU VALIDASI
   ========================================================= */

function ids_of(PDO $pdo, string $table): array {
  $ids = [];
  foreach ($pdo->query("SELECT id FROM `$table`") as $r) $ids[(int)$r['id']] = true;
  return $ids;
}

/** Hapus semua baris tabel yang id-nya tidak ada di $keep. */
function keep_only(PDO $pdo, string $table, array $keep): void {
  if ($keep) {
    $ph = implode(',', array_fill(0, count($keep), '?'));
    $pdo->prepare("DELETE FROM `$table` WHERE id NOT IN ($ph)")->execute(array_values($keep));
  } else {
    $pdo->exec("DELETE FROM `$table`");
  }
}

function clean_text($v, int $max): string {
  return mb_substr(trim(is_string($v) ? $v : ''), 0, $max);
}

function clean_date($v): ?string {
  if (is_string($v) && preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m)
      && checkdate((int)$m[2], (int)$m[3], (int)$m[1])) return $v;
  return null;
}

function clean_time($v): ?string {
  if (is_string($v) && preg_match('/^(\d{1,2}):(\d{2})$/', $v, $m)
      && (int)$m[1] < 24 && (int)$m[2] < 60) {
    return sprintf('%02d:%02d:00', (int)$m[1], (int)$m[2]);
  }
  return null;
}

function clean_color($v): string {
  return (is_string($v) && preg_match('/^#[0-9a-fA-F]{6}$/', $v)) ? $v : '#d7f23a';
}

function pick_enum($v, array $allowed, string $default): string {
  return in_array($v, $allowed, true) ? $v : $default;
}

/* =========================================================
   GET — baca seluruh state dari database
   ========================================================= */

function load_state(): array {
  $pdo = db();

  $folders = [];
  foreach ($pdo->query('SELECT id, name, color FROM folders ORDER BY id') as $f) {
    $folders[] = ['id' => (int)$f['id'], 'name' => $f['name'], 'color' => $f['color']];
  }

  $tasks = [];
  $getTasks = $pdo->query(
    'SELECT id, folder_id, title, note, due_date, due_time, priority, status, done_on
     FROM tasks ORDER BY sort_order, id'
  );
  $getSubs = $pdo->prepare(
    'SELECT id, text, is_completed FROM subtasks WHERE task_id = ? ORDER BY sort_order, id'
  );
  foreach ($getTasks as $t) {
    $subs = [];
    $getSubs->execute([(int)$t['id']]);
    foreach ($getSubs as $s) {
      $subs[] = ['id' => (int)$s['id'], 'text' => $s['text'], 'done' => (bool)$s['is_completed']];
    }
    $tasks[] = [
      'id'       => (int)$t['id'],
      'folderId' => (int)$t['folder_id'],
      'title'    => $t['title'],
      'note'     => (string)($t['note'] ?? ''),
      'date'     => (string)($t['due_date'] ?? ''),
      'time'     => substr((string)($t['due_time'] ?? ''), 0, 5),
      'priority' => $t['priority'],
      'status'   => $t['status'],
      'doneOn'   => (string)($t['done_on'] ?? ''),
      'subtasks' => $subs,
    ];
  }

  $settings = $pdo->query('SELECT theme, default_view, current_folder_id FROM app_settings WHERE id = 1')->fetch();
  if (!$settings) {
    $pdo->exec('INSERT INTO app_settings (id) VALUES (1)');
    $settings = ['theme' => 'light', 'default_view' => 'agenda', 'current_folder_id' => null];
  }

  return [
    'ok'    => true,
    'state' => [
      'folders' => $folders,
      'tasks'   => $tasks,
      'theme'   => $settings['theme'],
      'current' => $settings['current_folder_id'] === null ? 'all' : (string)$settings['current_folder_id'],
      'view'    => $settings['default_view'],
    ],
  ];
}

/* =========================================================
   POST — samakan database dengan state yang dikirim app
   ========================================================= */

function sync_state(array $payload): array {
  $pdo = db();

  $folders = is_array($payload['folders'] ?? null) ? $payload['folders'] : [];
  $tasks   = is_array($payload['tasks'] ?? null) ? $payload['tasks'] : [];
  $theme   = pick_enum($payload['theme'] ?? null, ['light', 'dark'], 'light');
  $view    = pick_enum($payload['view'] ?? null, ['agenda', 'board', 'month', 'stats'], 'agenda');
  $current = is_string($payload['current'] ?? null) ? $payload['current'] : 'all';

  $pdo->beginTransaction();
  try {
    /* ---- 1. hapus dulu folder/task yang tidak ada di payload ----
       (dihapus duluan supaya nama folder UNIQUE tidak bentrok saat rename;
        ON DELETE CASCADE otomatis membersihkan tasks & subtasks terkait) */
    $sentFolders = [];
    foreach ($folders as $f) if (is_array($f) && is_numeric($f['id'] ?? null)) $sentFolders[] = (int)$f['id'];
    keep_only($pdo, 'folders', $sentFolders);

    $sentTasks = [];
    foreach ($tasks as $t) if (is_array($t) && is_numeric($t['id'] ?? null)) $sentTasks[] = (int)$t['id'];
    keep_only($pdo, 'tasks', $sentTasks);

    /* ---- 2. folders: insert / update ---- */
    $existingFolders = ids_of($pdo, 'folders');
    $folderMap = [];   // id client (string) => id database
    $usedNames = [];
    $insFolder = $pdo->prepare('INSERT INTO folders (name, color) VALUES (?, ?)');
    $updFolder = $pdo->prepare('UPDATE folders SET name = ?, color = ? WHERE id = ?');
    foreach ($folders as $f) {
      if (!is_array($f)) continue;
      $base = clean_text($f['name'] ?? '', 24);
      if ($base === '') continue;
      $color = clean_color($f['color'] ?? '');
      // jaga nama tetap unik (kolom folders.name UNIQUE)
      $key = mb_strtolower($base); $n = 2;
      while (isset($usedNames[$key])) { $base = mb_substr($base, 0, 21) . ' ' . $n; $key = mb_strtolower($base); $n++; }
      $usedNames[$key] = true;
      $cid = (string)($f['id'] ?? '');
      if ($cid !== '' && is_numeric($cid) && isset($existingFolders[(int)$cid])) {
        $updFolder->execute([$base, $color, (int)$cid]);
        $folderMap[$cid] = (int)$cid;
      } else {
        $insFolder->execute([$base, $color]);
        $folderMap[$cid] = (int)$pdo->lastInsertId();
      }
    }

    /* ---- 3. tasks: insert / update (urutan array = sort_order) ---- */
    $existingTasks = ids_of($pdo, 'tasks');
    $taskMap = [];
    $insTask = $pdo->prepare(
      'INSERT INTO tasks (folder_id, title, note, due_date, due_time, priority, status, done_on, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    $updTask = $pdo->prepare(
      'UPDATE tasks SET folder_id = ?, title = ?, note = ?, due_date = ?, due_time = ?,
        priority = ?, status = ?, done_on = ?, sort_order = ? WHERE id = ?'
    );
    $order = 0;
    foreach ($tasks as $t) {
      if (!is_array($t)) continue;
      $title = clean_text($t['title'] ?? '', 140);
      if ($title === '') continue;
      $cid = (string)($t['id'] ?? '');
      $fid = (string)($t['folderId'] ?? '');
      if (!isset($folderMap[$fid])) continue;   // folder tidak dikenal → abaikan task ini
      $vals = [
        $folderMap[$fid],
        $title,
        clean_text($t['note'] ?? '', 400) ?: null,
        clean_date($t['date'] ?? ''),
        clean_time($t['time'] ?? ''),
        pick_enum($t['priority'] ?? null, ['low', 'mid', 'high'], 'mid'),
        pick_enum($t['status'] ?? null, ['todo', 'doing', 'done'], 'todo'),
        clean_date($t['doneOn'] ?? ''),
        $order++,
      ];
      if ($cid !== '' && is_numeric($cid) && isset($existingTasks[(int)$cid])) {
        $updTask->execute([...$vals, (int)$cid]);
        $taskMap[$cid] = (int)$cid;
      } else {
        $insTask->execute($vals);
        $taskMap[$cid] = (int)$pdo->lastInsertId();
      }
    }

    /* ---- 4. subtasks: insert / update, lalu hapus sisanya ---- */
    $insSub = $pdo->prepare('INSERT INTO subtasks (task_id, text, is_completed, sort_order) VALUES (?, ?, ?, ?)');
    $updSub = $pdo->prepare('UPDATE subtasks SET text = ?, is_completed = ?, sort_order = ? WHERE id = ? AND task_id = ?');
    $delSub = $pdo->prepare('DELETE FROM subtasks WHERE task_id = ?');
    foreach ($tasks as $t) {
      if (!is_array($t)) continue;
      $tid = $taskMap[(string)($t['id'] ?? '')] ?? null;
      if ($tid === null) continue;
      $subs = is_array($t['subtasks'] ?? null) ? $t['subtasks'] : [];
      $seen = [];
      $i = 0;
      foreach ($subs as $s) {
        if (!is_array($s)) continue;
        $text = clean_text($s['text'] ?? '', 80);
        if ($text === '') continue;
        $done = !empty($s['done']) ? 1 : 0;
        $sid = (string)($s['id'] ?? '');
        if ($sid !== '' && is_numeric($sid)) {
          $updSub->execute([$text, $done, $i, (int)$sid, $tid]);
          $seen[] = (int)$sid;
        } else {
          $insSub->execute([$tid, $text, $done, $i]);
          $seen[] = (int)$pdo->lastInsertId();
        }
        $i++;
      }
      if ($seen) {
        $ph = implode(',', array_fill(0, count($seen), '?'));
        $pdo->prepare("DELETE FROM subtasks WHERE task_id = ? AND id NOT IN ($ph)")->execute([$tid, ...$seen]);
      } else {
        $delSub->execute([$tid]);
      }
    }

    /* ---- 5. app_settings (baris tunggal id = 1) ---- */
    $currentId = ($current !== 'all' && isset($folderMap[$current])) ? $folderMap[$current] : null;
    if ($pdo->query('SELECT 1 FROM app_settings WHERE id = 1')->fetchColumn()) {
      $pdo->prepare('UPDATE app_settings SET theme = ?, default_view = ?, current_folder_id = ? WHERE id = 1')
          ->execute([$theme, $view, $currentId]);
    } else {
      $pdo->prepare('INSERT INTO app_settings (id, theme, default_view, current_folder_id) VALUES (1, ?, ?, ?)')
          ->execute([$theme, $view, $currentId]);
    }

    $pdo->commit();
  } catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    throw $e;
  }

  return load_state();   // balas dengan state resmi dari database
}

/* =========================================================
   ROUTER
   ========================================================= */

try {
  $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

  if ($method === 'GET') {
    json_out(load_state());
  }

  if ($method === 'POST') {
    $json = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($json)) {
      json_out(['ok' => false, 'error' => 'Body harus JSON yang valid'], 400);
    }
    json_out(sync_state($json['state'] ?? $json));
  }

  json_out(['ok' => false, 'error' => 'Method tidak didukung'], 405);
} catch (Throwable $e) {
  json_out(['ok' => false, 'error' => 'Kesalahan server: ' . $e->getMessage()], 500);
}
