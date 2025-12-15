// ===============================
//  WhatsApp Group ID Lister
//  Untuk menampilkan semua grup dan ID-nya
// ===============================

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

console.log("Menyiapkan WhatsApp Web, tunggu QR muncul...");

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// === QR LOGIN ===
client.on("qr", (qr) => {
  console.clear();
  console.log("📱 Scan QR berikut untuk login WhatsApp kamu:\n");
  qrcode.generate(qr, { small: true });
});

// === Ketika sudah login dan siap ===
client.on("ready", async () => {
  console.log("✅ Login berhasil, mengambil daftar grup...");

  try {
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    if (groups.length === 0) {
      console.log("⚠️ Tidak ada grup terdeteksi di akun ini.");
      process.exit(0);
    }

    console.log("\n=== DAFTAR GRUP TERDETEKSI ===");
    groups.forEach(g => {
      console.log(`Nama Grup : ${g.name}`);
      console.log(`ID Grup   : ${g.id._serialized}`);
      console.log("-----------------------------");
    });

    console.log("\n✅ Selesai. Gunakan ID grup di atas pada variabel TARGET_NUMBER.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Gagal mengambil daftar grup:", err.message);
    process.exit(1);
  }
});

client.initialize();
