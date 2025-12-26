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
- Notifikasi down dikirim ke target WA di `targets.json` **tanpa delay** (langsung).
- **Fitur Grouping Notifikasi**: Jika ada ≥10 user dengan prefix yang sama (contoh: BRN-, PGK-, NBS-) down bersamaan, notifikasi akan digabung menjadi satu pesan "Link XXX Down" untuk menghindari spam.
- User tanpa prefix atau dengan jumlah <10 tetap dikirim sebagai notifikasi individual.
- Laporan terjadwal di jam `state.scheduleTimes` (default 07:00, 15:00) memanggil `STATUS_ENDPOINT` per router.
- Status last notified per user/router disimpan di `state.json` untuk mencegah duplikasi.
- Data grouped alerts tersimpan di memori untuk command `/detail`.

## Fitur Grouping Notifikasi

Bot secara otomatis mengelompokkan notifikasi offline berdasarkan prefix username untuk menghindari spam pesan.

### Cara Kerja
- **Deteksi Prefix**: Bot mengekstrak prefix dari username dengan format `XXX-` (huruf kapital sebelum tanda `-`)
  - Contoh: `BRN-User1` → prefix `BRN`
  - Contoh: `PGK-Afdika` → prefix `PGK`
  
- **Threshold Grouping**: Jika ada **≥10 user** dengan prefix yang sama down bersamaan, notifikasi digabung menjadi satu pesan.

### Contoh Notifikasi

**Notifikasi Grouped (≥10 user dengan prefix sama):**
```
💥 Link BRN Down
📟 Router: SALAM 1
👥 Jumlah: 15 user
⏰ Down sejak: 26/12/2025 15:22 WIB
```

**Notifikasi Individual (<10 user atau tanpa prefix):**
```
💥 User Down
📟 Router: SALAM 1
👤 User: BRN-Afdika
⏰ Down sejak: 26/12/2025 15:22 WIB
```

### Melihat Detail Grouped Notification
Setelah menerima notifikasi "Link XXX Down", gunakan command `/detail` untuk melihat daftar lengkap:
```
/detail BRN
```

Output:
```
📋 Detail Link BRN Down
📟 Router: SALAM 1
👥 Total: 15 user

Daftar user:
1. BRN-Afdika
2. BRN-Anggraini
3. BRN-Aprilia
... (dan seterusnya)
```

### Skenario Pengelompokan

| Kondisi | Hasil Notifikasi |
|---------|------------------|
| 15 user BRN- down | 1 pesan grouped |
| 5 user BRN- down | 5 pesan individual |
| 12 user BRN- + 15 user PGK- down | 2 pesan grouped (1 BRN, 1 PGK) |
| 12 user BRN- + 5 user PGK- down | 1 grouped BRN + 5 individual PGK |
| User tanpa prefix (contoh: "User123") | Selalu individual |

## Perintah WhatsApp
- Perintah umum tersedia untuk target atau admin; perintah admin hanya untuk `ADMIN_CHAT_IDS` di `index.js`.

### Perintah Umum
- `/salam` — Tampilkan status router terkini (laporan singkat).
- `/detail <prefix>` — Tampilkan daftar lengkap user yang down dari notifikasi "Link XXX Down" terakhir. Contoh: `/detail BRN` untuk melihat semua user BRN yang down. Tanpa parameter untuk melihat daftar prefix yang tersedia.
- `/cmd` — Tampilkan bantuan.

### Perintah Admin
- `/targets <add|remove|list> [id]` — Kelola daftar penerima pesan.
- `/threshold <min> <max>` — Set ambang durasi menit min/max untuk dianggap down.
- `/blacklist <add|remove|list> [nama]` — Abaikan user tertentu.
- `/jadwal [jam...]` — Set jam laporan otomatis (format HH:MM, bisa banyak).

## Struktur Repo
- `index.js` — Logika utama bot, scheduler, handler perintah, notifikasi, dan grouping notifikasi.
- `package.json` — Dependensi: `whatsapp-web.js`, `axios`, `node-cron`, `qrcode-terminal`.
- `state.json` — Status runtime: terakhir notif per user, jadwal, threshold.
- `blacklist.json` — Daftar user yang diabaikan.
- `targets.json` — Daftar ID chat/grup tujuan.
- `cek_id.js` — Skrip helper (lihat file untuk detail jika dibutuhkan).
- `.wwebjs_auth/`, `.wwebjs_cache/` — Sesi/cache WhatsApp Web (jangan dipush).
- `.gitignore` — Mengecualikan `node_modules/`, log, dan cache sesi.

## Catatan Operasional
- Pastikan koneksi stabil; jika push ke GitHub gagal karena file besar, hapus `node_modules/` dari commit dan push ulang.
- Jika mau ganti nomor admin/target, edit `ADMIN_CHAT_IDS` di `index.js` atau `targets.json` lalu restart bot.
- Waktu memakai TZ `Asia/Jakarta`.
