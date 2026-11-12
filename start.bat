@echo off
rem ============================================================
rem  doit — jalankan aplikasi + API MySQL
rem  Pastikan MySQL (XAMPP) sudah aktif sebelum menjalankan ini.
rem ============================================================
cd /d "%~dp0"
echo.
echo   doit berjalan di:  http://localhost:8080
echo   Tekan Ctrl+C di jendela ini untuk berhenti.
echo.
start /b cmd /c "timeout /t 1 /nobreak >nul & start http://localhost:8080"
php -S localhost:8080 -t .
