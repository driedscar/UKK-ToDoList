# doit — integrasi MySQL

Aplikasi doit sekarang tersambung ke database MySQL **doit_db** lewat API PHP di `api/index.php`.

## Cara menjalankan

1. Pastikan **MySQL (XAMPP)** aktif — database `doit_db` beserta tabelnya sudah ada.
2. Klik dua kali **`start.bat`** → browser terbuka di `http://localhost:8080`.
   - Cara manual: `php -S localhost:8080 -t .` dari folder ini, lalu buka `http://localhost:8080`.
3. Live Server (VS Code) juga tetap bisa dipakai untuk frontend, asalkan `start.bat` tetap berjalan di belakang (API diakses lewat `http://localhost:8080`).

## File yang ditambahkan

| File | Fungsi |
|---|---|
| `api/config.php` | Koneksi ke MySQL (`doit_db`, user `root` tanpa password — default XAMPP) |
| `api/index.php` | `GET` = ambil seluruh state; `POST` = menyamakan database dengan isi app |
| `start.bat` | Menjalankan server PHP + membuka browser |

## Cara kerjanya

- Setiap perubahan (tambah/ubah/hapus task & folder, subtask, drag & drop, tema, view) otomatis tersimpan ke MySQL lewat `api/index.php` (debounce ±350 ms).
- Task yang dicentang dicatat di kolom `tasks.done_on` — statistik (streak, bar mingguan, heatmap) dihitung dari kolom itu.
- Saat halaman dibuka, data selalu diambil dari database; `localStorage` hanya jadi cache offline.
- Kalau API/database tidak terjangkau, app tetap bisa dipakai dengan penyimpanan lokal, lalu tersinkron saat server kembali aktif.
- Isi `localStorage` lama (sebelum integrasi) dibackup sekali ke key `doit.v3.pre-db`.

## Struktur tabel `doit_db` (sudah ada)

- `folders` — id, name (unik), color
- `tasks` — folder_id (FK), title, note, due_date, due_time, priority, status, done_on, sort_order
- `subtasks` — task_id (FK), text, is_completed, sort_order
- `app_settings` — baris tunggal: theme, default_view, current_folder_id
