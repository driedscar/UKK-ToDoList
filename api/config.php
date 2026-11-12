<?php
/**
 * doit — konfigurasi koneksi MySQL (XAMPP)
 * ----------------------------------------------------
 * Database : doit_db
 * User     : root (default XAMPP, tanpa password)
 * Kalau kamu pakai user/password lain, cukup ubah konstanta di bawah.
 */

const DB_HOST = '127.0.0.1';
const DB_NAME = 'doit_db';
const DB_USER = 'root';
const DB_PASS = '';

/** Koneksi PDO tunggal (lazy). */
function db(): PDO {
  static $pdo = null;
  if ($pdo === null) {
    $pdo = new PDO(
      'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
      DB_USER,
      DB_PASS,
      [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
      ]
    );
  }
  return $pdo;
}

/** Kirim respons JSON lalu matikan skrip. */
function json_out($data, int $code = 200): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

/** Header CORS — supaya halaman dari Live Server (port lain) tetap bisa akses API ini. */
function cors(): void {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
  if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
  }
}
