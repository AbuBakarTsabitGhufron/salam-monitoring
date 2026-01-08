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
- **Notifikasi Online Kembali**: Bot mendeteksi user/link yang kembali online dan mengirim notifikasi recovery.
- User tanpa prefix atau dengan jumlah <10 tetap dikirim sebagai notifikasi individual.
- **Retry Logic**: Request API otomatis retry 3x dengan timeout 30 detik untuk stabilitas.
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

### Notifikasi Online Kembali

Bot juga mengirim notifikasi saat user/link kembali online:

**Notifikasi Grouped Online (≥10 user dengan prefix sama):**
```
✅ Link BRN Online Kembali
📟 Router: SALAM 1
👥 Jumlah: 15 user
⏰ Online kembali: 08/01/2026 14:30 WIB
```

**Notifikasi Individual Online:**
```
✅ User Online Kembali
📟 Router: SALAM 1
👤 User: BRN-Afdika
⏰ Online kembali: 08/01/2026 14:30 WIB
```

### Melihat Detail Grouped Notification
Setelah menerima notifikasi "Link XXX Down" atau "Link XXX Online Kembali", gunakan command `/detail` untuk melihat daftar lengkap:

**Contoh untuk Link Down:**
```
/detail down BRN
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

**Contoh untuk Link Online:**
```
/detail up BRN
```

Output:
```
📋 Detail Link BRN Online Kembali
📟 Router: SALAM 1
👥 Total: 15 user

Daftar user:
1. BRN-Afdika
2. BRN-Anggraini
3. BRN-Aprilia
... (dan seterusnya)
```

**Melihat Prefix yang Tersedia:**
```
/detail
```

Output akan menampilkan daftar prefix down dan up yang tersedia.

### Skenario Pengelompokan

| Kondisi | Hasil Notifikasi |
|---------|------------------|
| 15 user BRN- down | 1 pesan grouped down |
| 5 user BRN- down | 5 pesan individual down |
| 12 user BRN- + 15 user PGK- down | 2 pesan grouped down (1 BRN, 1 PGK) |
| 12 user BRN- + 5 user PGK- down | 1 grouped BRN + 5 individual PGK down |
| 15 user BRN- online kembali | 1 pesan grouped online |
| 5 user BRN- online kembali | 5 pesan individual online |
| User tanpa prefix (contoh: "User123") | Selalu individual |

## Perintah WhatsApp
- Perintah umum tersedia untuk target atau admin; perintah admin hanya untuk `ADMIN_CHAT_IDS` di `index.js`.

### Perintah Umum
- `/salam` — Tampilkan status router terkini (laporan singkat).
- `/detail <down|up> <prefix>` — Tampilkan daftar lengkap user yang down/online dari notifikasi Link XXX terakhir. 
  - Contoh: `/detail down BRN` untuk melihat user yang down
  - Contoh: `/detail up PGK` untuk melihat user yang online kembali
  - Tanpa parameter untuk melihat daftar prefix yang tersedia
- `/cmd` — Tampilkan bantuan.
- `/debug` — Tampilkan Chat ID, status admin/target, dan device mapping (untuk debugging autentikasi).

### Perintah Admin
- `/targets <add|remove|list> [id] [all|link]` — Kelola daftar penerima pesan dengan kategori:
  - `add [id] all`: Target menerima semua notifikasi (default)
  - `add [id] link`: Target hanya menerima notifikasi link down/online (≥10 user)
  - `remove [id]`: Hapus target
  - `list`: Tampilkan semua target beserta tipenya
- `/threshold <min> <max>` — Set ambang durasi menit min/max untuk dianggap down.
- `/blacklist <add|remove|list> [nama]` — Abaikan user tertentu.
- `/jadwal [jam...]` — Set jam laporan otomatis (format HH:MM, bisa banyak).

## Kategorisasi Target Notifikasi

Bot mendukung kategorisasi target untuk memfilter jenis notifikasi yang diterima:

### Tipe Target:
- **`all`**: Menerima SEMUA notifikasi (user down individual, link down, link online, laporan terjadwal)
- **`link`**: Hanya menerima notifikasi link down/online (≥10 user dengan prefix sama)

### Routing Notifikasi:

| Jenis Notifikasi | Target `all` | Target `link` |
|------------------|--------------|---------------|
| 💥 User Down Individual | ✅ | ❌ |
| 💥 Link Down (≥10 user) | ✅ | ✅ |
| ✅ User Online Individual | ✅ | ❌ |
| ✅ Link Online (≥10 user) | ✅ | ✅ |
| 📊 Laporan Terjadwal | ✅ | ❌ |

### Contoh Penggunaan:
```bash
# Target untuk semua notifikasi
/targets add 6287715308060@c.us all

# Target khusus link down/online saja
/targets add 6285179869754@c.us link

# Lihat semua target
/targets list
```

## Struktur Repo
- `index.js` — Logika utama bot, scheduler, handler perintah, notifikasi down/online, dan grouping.
- `package.json` — Dependensi: `whatsapp-web.js`, `axios`, `node-cron`, `qrcode-terminal`.
- `state.json` — Status runtime: terakhir notif per user, jadwal, threshold.
- `blacklist.json` — Daftar user yang diabaikan.
- `targets.json` — Daftar ID chat/grup tujuan dengan tipe kategorisasi.
- `cek_id.js` — Skrip helper (lihat file untuk detail jika dibutuhkan).
- `.wwebjs_auth/`, `.wwebjs_cache/` — Sesi/cache WhatsApp Web (jangan dipush).
- `.gitignore` — Mengecualikan `node_modules/`, log, dan cache sesi.

## Fitur Teknis

### Retry Logic & Error Handling
- Request API otomatis retry hingga 3x jika gagal
- Timeout 30 detik per request (dari sebelumnya 10 detik)
- Error handling spesifik untuk berbagai jenis error (timeout, connection refused, dll)
- Bot tetap berjalan meskipun API down sementara

### Custom Session Name
- Session WhatsApp Web menggunakan nama custom: `salam-monitoring-bot`
- Nama akan muncul di WhatsApp Web → Devices → Linked devices
- Bisa diubah di konstanta `SESSION_NAME` di `index.js`

### Device ID Mapping & Authentication
Bot mendukung autentikasi untuk **linked devices** (WhatsApp Desktop, Web, dll) dengan sistem mapping otomatis:

**Cara Kerja:**
1. **Auto-mapping saat kirim pesan**: Bot otomatis menyimpan mapping device ID saat mengirim notifikasi ke target
   - Contoh: Kirim ke `6285723060629@c.us` → WhatsApp route ke device `92913614725156@lid`
   - Mapping disimpan di cache: `92913614725156@lid → 6285723060629@c.us`

2. **Three-tier authentication** untuk command:
   - ✅ Direct ID match (cek langsung dengan ID di targets/admin)
   - ✅ Cache lookup (cek mapping device ID)
   - ✅ Number extraction fallback (bandingkan nomor telepon)

3. **Cache cleanup otomatis**: Saat target dihapus dengan `/targets remove`, mapping device-nya juga otomatis terhapus

**Keuntungan:**
- Target bisa menggunakan command dari device manapun (HP, Desktop, Web) setelah menerima notifikasi pertama
- Admin tidak perlu manual mapping device ID
- Security tetap terjaga karena hanya device yang pernah menerima pesan bot yang ter-map

**Debug Command:**
- `/debug` — Tampilkan Chat ID, status admin, status target, dan cache device mapping (tersedia untuk semua user)

### Logging
Bot menampilkan log informatif untuk monitoring:
```
🔍 Memulai pengecekan alert...
✅ Berhasil mengambil data offline: 23 user
✅ Link BRN online kembali (12 user)
📝 Device mapping: 92913614725156@lid → 6285723060629@c.us
🗑️ Cleared cache mapping: 92913614725156@lid → 6285135911726@c.us
✅ Pengecekan alert selesai
```

## Catatan Operasional
- Pastikan koneksi stabil; jika push ke GitHub gagal karena file besar, hapus `node_modules/` dari commit dan push ulang.
- Jika mau ganti nomor admin/target, edit `ADMIN_CHAT_IDS` di `index.js` atau gunakan command `/targets`.
- Waktu memakai TZ `Asia/Jakarta`.
- Prefix detection: Username harus format `XXX-` (huruf kapital + tanda hubung) untuk di-grup, contoh: `BRN-User1`, `PGK-Afdika`.
