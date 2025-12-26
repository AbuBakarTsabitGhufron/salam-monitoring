# Salam Monitoring Bot

Bot WhatsApp untuk memantau status router SALAM. Mendukung notifikasi down dengan jeda anti-spam, laporan terjadwal, dan perintah admin via WhatsApp.

## Deploy & Jalankan

### Persiapan
- Node.js 18+ dan npm.
- Akun WhatsApp untuk dipakai login (QR scan di terminal).
- Pastikan `node_modules/` tidak ikut git push (sudah ada `.gitignore`).

### Instalasi
```bash
npm install
```

### Jalankan (development)
```bash
node index.js
```
- Saat pertama kali jalan, scan QR yang muncul di terminal.
- Sesi tersimpan di `.wwebjs_auth/` dan cache di `.wwebjs_cache/`.

### Jalankan sebagai service (contoh systemd)
Buat unit `/etc/systemd/system/salam-monitor.service`:
```
[Unit]
Description=Salam Monitoring Bot
After=network-online.target

[Service]
WorkingDirectory=/home/tsabith/Project/MonitorCleonSalam
ExecStart=/usr/bin/node index.js
Restart=always
User=tsabith
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
Lalu:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now salam-monitor.service
```

### Update / redeploy cepat
```bash
git pull
npm install --production
sudo systemctl restart salam-monitor.service   # jika pakai systemd
```

## Cara Kerja Singkat
- Bot polling API `OFFLINE_ENDPOINT` setiap 30s (`CHECK_INTERVAL_MS`).
- Notifikasi down dikirim ke target WA di `targets.json` dengan jeda `notificationDelayMs` (default 30s). Bisa diubah via perintah `/delay` admin.
- Jika dalam satu siklus ada ≥3 user baru down, pesan digabung per router agar tidak spam.
- Laporan terjadwal di jam `state.scheduleTimes` (default 07:00, 15:00) memanggil `STATUS_ENDPOINT` per router.
- Status last notified per user/ router disimpan di `state.json` untuk mencegah duplikasi.

## Perintah WhatsApp
- Perintah umum tersedia untuk target atau admin; perintah admin hanya untuk `ADMIN_CHAT_IDS` di `index.js`.

### Perintah Umum
- `/salam` — Tampilkan status router terkini (laporan singkat).
- `/cmd` — Tampilkan bantuan.

### Perintah Admin
- `/targets <add|remove|list> [id]` — Kelola daftar penerima pesan.
- `/threshold <min> <max>` — Set ambang durasi menit min/max untuk dianggap down.
- `/blacklist <add|remove|list> [nama]` — Abaikan user tertentu.
- `/jadwal [jam...]` — Set jam laporan otomatis (format HH:MM, bisa banyak).
- `/delay [detik]` — Lihat/set jeda antar notifikasi down (0–600 detik).

## Struktur Repo
- `index.js` — Logika utama bot, scheduler, handler perintah, notifikasi.
- `package.json` — Dependensi: `whatsapp-web.js`, `axios`, `node-cron`, `qrcode-terminal`.
- `state.json` — Status runtime: terakhir notif per user, jadwal, threshold, delay.
- `blacklist.json` — Daftar user yang diabaikan.
- `targets.json` — Daftar ID chat/grup tujuan.
- `cek_id.js` — Skrip helper (lihat file untuk detail jika dibutuhkan).
- `.wwebjs_auth/`, `.wwebjs_cache/` — Sesi/ cache WhatsApp Web (jangan dipush).
- `.gitignore` — Mengecualikan `node_modules/`, log, dan cache sesi.

## Catatan Operasional
- Pastikan koneksi stabil; jika push ke GitHub gagal karena file besar, hapus `node_modules/` dari commit dan push ulang.
- Jika mau ganti nomor admin/target, edit `ADMIN_CHAT_IDS` di `index.js` atau `targets.json` lalu restart bot.
- Waktu memakai TZ `Asia/Jakarta`.
