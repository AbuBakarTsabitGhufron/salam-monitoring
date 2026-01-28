const {
	default: makeWASocket,
	fetchLatestBaileysVersion,
	DisconnectReason,
	useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// === KONFIGURASI UTAMA ===
const ROUTERS = ["SALAM-UTAMA-INDI", "SALAM-UTAMA-METRO"];
const ROUTER_LABELS = {
	"SALAM-UTAMA-METRO": "SALAM 1",
	"SALAM-UTAMA-INDI": "SALAM 2",
};
const STATUS_ENDPOINT = (router) => `https://api.wikolabs.biz.id/api/status/${router}`;
const OFFLINE_ENDPOINT = "https://api.wikolabs.biz.id/api/offline/all";
const CHECK_INTERVAL_MS = 30 * 1000; // Polling downtime
const TZ = "Asia/Jakarta";
const DEFAULT_SCHEDULES = ["07:00", "15:00"]; // WIB, mudah diubah lewat /jadwal
const DEFAULT_THRESHOLD = { minMinutes: 15, maxMinutes: 300 };
const DEFAULT_TARGETS = [{ id: "120363406015508176@g.us", type: "all" }]; // Contoh grup WA
const ADMIN_CHAT_IDS = ["6287715308060@c.us"]; // Isi dengan chat (grup/nomor) yang boleh pakai perintah admin
const GROUPING_THRESHOLD = 10; // Minimum jumlah user dengan prefix sama untuk di-grup
const SESSION_NAME = "salam-monitoring-bot"; // Nama folder session Baileys
const AUTH_DIR = path.join(__dirname, `${SESSION_NAME}_auth`); // Folder auth Baileys

// === LOKASI FILE ===
const STATE_FILE = path.join(__dirname, "state.json");
const BLACKLIST_FILE = path.join(__dirname, "blacklist.json");
const TARGETS_FILE = path.join(__dirname, "targets.json");

// === UTILITAS FILE ===
function ensureJson(filePath, fallback) {
	try {
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf8"));
		}
	} catch (err) {
		console.error(`Gagal membaca ${filePath}:`, err.message);
	}

	fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
	return fallback;
}

function saveJson(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// === DATA PERSISTEN ===
let state = ensureJson(STATE_FILE, {
	notified: {}, // { [router]: { [user]: offlineSince } }
	lastReports: {}, // { "07:00": "2025-12-11T07:00:00.000Z" }
	threshold: DEFAULT_THRESHOLD,
	scheduleTimes: DEFAULT_SCHEDULES,
});

if (!state.threshold) {
	state.threshold = DEFAULT_THRESHOLD;
}

if (!state.scheduleTimes || !state.scheduleTimes.length) {
	state.scheduleTimes = DEFAULT_SCHEDULES.slice();
}

let blacklist = ensureJson(BLACKLIST_FILE, { users: [] });
let targets = ensureJson(TARGETS_FILE, { ids: DEFAULT_TARGETS });

// Migrasi format lama ke format baru
if (targets.ids.length > 0 && typeof targets.ids[0] === 'string') {
	targets.ids = targets.ids.map(id => ({ id, type: 'all' }));
	saveJson(TARGETS_FILE, targets);
}

// Log targets yang ter-load
console.log(`📋 Loaded ${targets.ids.length} target(s):`, targets.ids.map(t => `${t.id} (${t.type})`).join(", "));

let scheduledJobs = []; // Cron jobs aktif untuk laporan terjadwal
let alertInterval = null; // Interval aktif untuk pengecekan alert
let lastGroupedAlerts = {}; // Menyimpan grouped alerts terakhir untuk command /detail
let lastGroupedRecovery = {}; // Menyimpan grouped recovery (online) untuk command /detail
const deviceToTargetCache = new Map(); // Cache mapping device ID ke target ID asli

// === HELPER DEVICE ID ===
function extractPhoneNumber(chatId) {
	// Extract numeric part from chatId (support @c.us, @g.us, @lid formats)
	const match = chatId.match(/^(\d+)@/);
	return match ? match[1] : chatId;
}

function normalizePhoneNumber(value) {
	const digits = String(value || "").replace(/\D/g, "");
	return digits.replace(/^(62|0)/, "");
}

function normalizeChatId(chatId) {
	if (!chatId) return chatId;
	if (chatId.endsWith("@c.us")) return chatId.replace("@c.us", "@s.whatsapp.net");
	return chatId;
}

function toBaileysId(chatId) {
	return normalizeChatId(chatId);
}

function unwrapMessage(message) {
	if (!message) return message;
	if (message.ephemeralMessage?.message) return message.ephemeralMessage.message;
	if (message.viewOnceMessage?.message) return message.viewOnceMessage.message;
	return message;
}

function getMessageText(message) {
	const unwrapped = unwrapMessage(message);
	return (
		unwrapped?.conversation ||
		unwrapped?.extendedTextMessage?.text ||
		unwrapped?.imageMessage?.caption ||
		unwrapped?.videoMessage?.caption ||
		""
	);
}

// === HELPER WAKTU ===
function formatDate(date = new Date()) {
	return new Intl.DateTimeFormat("id-ID", {
		timeZone: TZ,
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	}).format(date);
}

function formatTime(date = new Date()) {
	return new Intl.DateTimeFormat("id-ID", {
		timeZone: TZ,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})
		.format(date)
		.replace(/\./g, ":");
}

function formatDateTime(dateLike) {
	const date = new Date(dateLike);
	return `${formatDate(date)} ${formatTime(date)} WIB`;
}

// === HELPER DATA ===
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKey(router, user) {
	return `${router}::${user}`;
}

function isBlacklisted(user) {
	return blacklist.users.map((u) => u.toLowerCase()).includes(user.toLowerCase());
}

function toDisplayRouterName(routerName = "") {
	return ROUTER_LABELS[routerName] || routerName;
}

function upsertNotified(router, user, offlineSince) {
	if (!state.notified[router]) state.notified[router] = {};
	state.notified[router][user] = offlineSince;
	saveJson(STATE_FILE, state);
}

function removeClearedNotified(activeKeys) {
	const next = {};

	for (const router of Object.keys(state.notified)) {
		for (const user of Object.keys(state.notified[router])) {
			const key = normalizeKey(router, user);
			if (activeKeys.has(key)) {
				if (!next[router]) next[router] = {};
				next[router][user] = state.notified[router][user];
			}
		}
	}

	state.notified = next;
	saveJson(STATE_FILE, state);
}

function getTargetsByType(type) {
	// type: 'all' (semua notifikasi), 'link' (hanya grouped link down), 'report' (laporan terjadwal)
	if (type === 'all') {
		return targets.ids.filter(t => t.type === 'all').map(t => t.id);
	} else if (type === 'link') {
		// Target 'link' hanya menerima grouped link down
		// Target 'all' menerima semua termasuk link down
		return targets.ids.filter(t => t.type === 'all' || t.type === 'link').map(t => t.id);
	} else if (type === 'report') {
		// Laporan terjadwal hanya ke target 'all'
		return targets.ids.filter(t => t.type === 'all').map(t => t.id);
	}
	return [];
}

async function sendToTargets(client, message, notificationType = 'all') {
	// notificationType: 'individual' (user down individual), 'grouped' (link down), 'report' (laporan)
	let targetIds = [];
	
	if (notificationType === 'grouped') {
		// Grouped link down: kirim ke target 'all' dan 'link'
		targetIds = getTargetsByType('link');
	} else if (notificationType === 'report') {
		// Laporan terjadwal: hanya ke target 'all'
		targetIds = getTargetsByType('report');
	} else {
		// Individual user down: hanya ke target 'all'
		targetIds = getTargetsByType('all');
	}
	
	for (const id of targetIds) {
		try {
			const sendId = toBaileysId(id);
			const sentMsg = await client.sendMessage(sendId, { text: message });
			
			// Simpan mapping: jika ID berubah setelah normalisasi
			if (sendId !== id) {
				console.log(`📝 Device mapping: ${sendId} → ${id}`);
				deviceToTargetCache.set(sendId, id);
			}
			
			await delay(500);
		} catch (err) {
			console.error(`Gagal kirim ke ${id}:`, err.message);
		}
	}
}

async function sendText(client, chatId, text, quotedMessage) {
	const sendId = toBaileysId(chatId);
	const options = quotedMessage ? { quoted: quotedMessage } : undefined;
	return client.sendMessage(sendId, { text }, options);
}

// === FORMAT PESAN ===
function extractPrefix(username) {
	// Ambil prefix sebelum tanda "-" (huruf besar)
	const match = username.match(/^([A-Z]+)-/);
	return match ? match[1] : null;
}

function buildOfflineMessage(entry) {
	const since = entry.offlineSince
		? formatDateTime(entry.offlineSince)
		: "(waktu tidak diketahui)";

	return (
		`👤 User: ${entry.user}\n` +
		`⏰ Down sejak: ${since}`
	);
}

function buildGroupedOfflineMessage(prefix, entries) {
	// Ambil waktu down terbaru
	const latestTime = entries.reduce((latest, entry) => {
		const time = new Date(entry.offlineSince);
		return time > latest ? time : latest;
	}, new Date(entries[0].offlineSince));

	const router = toDisplayRouterName(entries[0].router);

	return (
		`💥 Link ${prefix} Down\n` +
		`📟 Router: ${router}\n` +
		`👥 Jumlah: ${entries.length} user\n` +
		`⏰ Down sejak: ${formatDateTime(latestTime)}`
	);
}

function buildGroupedOnlineMessage(prefix, entries, router) {
	const now = formatDateTime(new Date());

	return (
		`✅ Link ${prefix} Online Kembali\n` +
		`📟 Router: ${toDisplayRouterName(router)}\n` +
		`👥 Jumlah: ${entries.length} user\n` +
		`⏰ Online kembali: ${now}`
	);
}

function buildOnlineMessage(user, router) {
	const now = formatDateTime(new Date());

	return (
		`✅ User Online Kembali\n` +
		// `📟 Router: ${toDisplayRouterName(router)}\n` +
		`👤 User: ${user}\n` +
		`⏰ Online kembali: ${now}`
	);
}

function buildReport(statuses) {
	const nowDate = formatDate();
	const nowTime = formatTime();

	let text = `Monitoring Salam, ${nowDate}\n${nowTime} WIB\n\n`;

	let totalActive = 0;
	let totalInterfaces = 0;

	for (const status of statuses) {
		const offlineList = (status.offlineList || []).filter((name) => !isBlacklisted(name));
		const offlineCount = offlineList.length;
		const total = Number(status.totalInterfaces) || offlineCount + (Number(status.runningInterfaces) || 0);
		const active = Number.isFinite(Number(status.runningInterfaces))
			? Number(status.runningInterfaces)
			: Math.max(total - offlineCount, 0);

		totalActive += active;
		totalInterfaces += total;

		const routerDisplay = toDisplayRouterName(status.routerName || status.router);
		text += `${routerDisplay}\n`;
		text += `${active}/${total} aktif | Offline ${offlineCount}\n`;

		if (offlineList.length) {
			text += "Offline list:\n";
			for (const user of offlineList) {
				text += `- ${user}\n`;
			}
		} else {
			text += "Tidak ada user offline\n";
		}

		text += "\n";
	}

	text += `Total aktif: ${totalActive}/${totalInterfaces} koneksi`;
	return text.trim();
}

// === PENGAMBILAN DATA ===
async function fetchWithRetry(url, retries = 3, timeout = 30000) {
	for (let i = 0; i < retries; i++) {
		try {
			const res = await axios.get(url, { timeout });
			return res.data;
		} catch (err) {
			if (i === retries - 1) throw err;
			const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
			const errorMsg = isTimeout ? 'timeout' : err.message;
			console.log(`⚠️  Retry ${i + 1}/${retries} untuk ${url.split('/').pop()} (${errorMsg})`);
			await delay(2000); // Tunggu 2 detik sebelum retry
		}
	}
}

async function fetchStatuses() {
	try {
		const responses = await Promise.all(
			ROUTERS.map((router) => fetchWithRetry(STATUS_ENDPOINT(router)))
		);
		console.log(`✅ Berhasil mengambil status ${responses.length} router`);
		return responses;
	} catch (err) {
		console.error("⚠️  Gagal mengambil status router:", err.message);
		return [];
	}
}

async function fetchOfflineAll() {
	try {
		const data = await fetchWithRetry(OFFLINE_ENDPOINT);
		const users = data?.users || [];
		console.log(`✅ Berhasil mengambil data offline: ${users.length} user`);
		return users;
	} catch (err) {
		if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
			console.error("⚠️  Timeout: API offline terlalu lama merespons (>30s)");
		} else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
			console.error("⚠️  Tidak dapat terhubung ke API offline");
		} else {
			console.error("⚠️  Gagal mengambil data offline:", err.message);
		}
		return [];
	}
}

// === LOGIKA ALERT ===
async function checkAlerts(client) {
	try {
		console.log("🔍 Memulai pengecekan alert...");
		const offlineUsers = await fetchOfflineAll();
		
		// Jika gagal fetch, skip cycle ini tetapi cek recovery
		if (!offlineUsers || offlineUsers.length === 0) {
			await checkLinkRecovery(client, new Set());
			return;
		}
		
		const activeKeys = new Set();
		const newAlerts = [];

		// Kumpulkan alert baru
		for (const user of offlineUsers) {
			if (!ROUTERS.includes(user.router)) continue;
			if (isBlacklisted(user.user)) continue;

			const duration = Number(user.durationMinutes) || 0;
			if (duration < state.threshold.minMinutes) continue;
			if (duration > state.threshold.maxMinutes) continue;

			const key = normalizeKey(user.router, user.user);
			activeKeys.add(key);

			const already = state.notified[user.router]?.[user.user];
			if (already && already === user.offlineSince) continue;

			newAlerts.push(user);
		}

		// Kelompokkan berdasarkan prefix
		const grouped = {};
		const standalone = [];

		for (const user of newAlerts) {
			const prefix = extractPrefix(user.user);
			
			if (prefix) {
				const groupKey = `${user.router}::${prefix}`;
				if (!grouped[groupKey]) {
					grouped[groupKey] = {
						router: user.router,
						prefix: prefix,
						users: []
					};
				}
				grouped[groupKey].users.push(user);
			} else {
				// User tanpa prefix (tidak ada format XXX-)
				standalone.push(user);
			}
		}

		// Kirim notifikasi
		const messages = [];

		// 1. Kirim grouped messages (10+ user dengan prefix sama)
		for (const groupKey in grouped) {
			const group = grouped[groupKey];
			
			if (group.users.length >= GROUPING_THRESHOLD) {
				// Kirim sebagai grup
				const message = buildGroupedOfflineMessage(group.prefix, group.users);
				messages.push({ type: 'grouped', message, users: group.users });
			} else {
				// Kirim individual (kurang dari 10)
				for (const user of group.users) {
					const message = buildOfflineMessage(user);
					messages.push({ type: 'individual', message, user });
				}
			}
		}

		// 2. Kirim standalone messages
		for (const user of standalone) {
			const message = buildOfflineMessage(user);
			messages.push({ type: 'individual', message, user });
		}

		// 3. Kirim semua message
		for (const item of messages) {
			// Tentukan tipe notifikasi untuk routing
			const notificationType = item.type === 'grouped' ? 'grouped' : 'individual';
			await sendToTargets(client, item.message, notificationType);
			
			// Update state
			if (item.type === 'grouped') {
				// Simpan untuk command /detail
				const prefix = item.users[0] ? extractPrefix(item.users[0].user) : null;
				if (prefix) {
					lastGroupedAlerts[prefix] = item.users.map(u => ({
						user: u.user,
						router: u.router,
						offlineSince: u.offlineSince
					}));
				}
				
				for (const user of item.users) {
					upsertNotified(user.router, user.user, user.offlineSince);
				}
			} else {
				upsertNotified(item.user.router, item.user.user, item.user.offlineSince);
			}
		}

		// Cek link yang online kembali sebelum cleanup
		await checkLinkRecovery(client, activeKeys);
		
		removeClearedNotified(activeKeys);
		console.log("✅ Pengecekan alert selesai\n");
	} catch (err) {
		console.error("Gagal cek alert:", err.message);
	}
}

// === DETEKSI LINK ONLINE KEMBALI ===
async function checkLinkRecovery(client, activeKeys) {
	// Kelompokkan user yang sudah tidak offline berdasarkan prefix
	const recoveredByPrefix = {};
	const recoveredIndividual = [];
	
	for (const router of Object.keys(state.notified)) {
		for (const user of Object.keys(state.notified[router])) {
			const key = normalizeKey(router, user);
			
			// Jika tidak ada di activeKeys = sudah online kembali
			if (!activeKeys.has(key)) {
				const prefix = extractPrefix(user);
				
				if (prefix) {
					const groupKey = `${router}::${prefix}`;
					if (!recoveredByPrefix[groupKey]) {
						recoveredByPrefix[groupKey] = {
							router: router,
							prefix: prefix,
							users: []
						};
					}
					recoveredByPrefix[groupKey].users.push({
						user: user,
						router: router
					});
				} else {
					// User tanpa prefix
					recoveredIndividual.push({ user, router });
				}
			}
		}
	}
	
	// Kirim notifikasi untuk link yang online kembali (≥10 user)
	for (const groupKey in recoveredByPrefix) {
		const group = recoveredByPrefix[groupKey];
		
		if (group.users.length >= GROUPING_THRESHOLD) {
			// Kirim grouped notification
			const message = buildGroupedOnlineMessage(group.prefix, group.users, group.router);
			await sendToTargets(client, message, 'grouped');
			console.log(`✅ Link ${group.prefix} online kembali (${group.users.length} user)`);
			
			// Simpan untuk command /detail up
			lastGroupedRecovery[group.prefix] = group.users.map(u => ({
				user: u.user,
				router: u.router,
				onlineSince: new Date().toISOString()
			}));
		} else {
			// Kirim individual notification untuk setiap user
			for (const u of group.users) {
				const message = buildOnlineMessage(u.user, u.router);
				await sendToTargets(client, message, 'individual');
			}
		}
	}
	
	// Kirim notifikasi individual untuk user tanpa prefix
	for (const u of recoveredIndividual) {
		const message = buildOnlineMessage(u.user, u.router);
		await sendToTargets(client, message, 'individual');
	}
}

// === MANAJEMEN JADWAL ===
function parseScheduleTime(raw) {
	const cleaned = (raw || "").trim().replace(/\./g, ":");
	const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;

	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

	return {
		hour,
		minute,
		label: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
	};
}

function getScheduleTimes() {
	const list = state.scheduleTimes && state.scheduleTimes.length ? state.scheduleTimes : DEFAULT_SCHEDULES;
	return Array.from(new Set(list));
}

function scheduleReportJobs(client) {
	scheduledJobs.forEach((job) => job.stop());
	scheduledJobs = [];

	for (const time of getScheduleTimes()) {
		const parsed = parseScheduleTime(time);
		if (!parsed) continue;

		const cronExpr = `${parsed.minute} ${parsed.hour} * * *`;
		const job = cron.schedule(
			cronExpr,
			() => runScheduledReport(client, parsed.label),
			{ timezone: TZ }
		);

		scheduledJobs.push(job);
	}
}

async function runScheduledReport(client, timeLabel) {
	try {
		const statuses = await fetchStatuses();
		
		if (!statuses || statuses.length === 0) {
			console.error(`⚠️  Gagal mengambil data untuk laporan ${timeLabel}, skip laporan ini.`);
			return;
		}
		
		const message = buildReport(statuses);
		await sendToTargets(client, message, 'report');

		state.lastReports[timeLabel] = new Date().toISOString();
		saveJson(STATE_FILE, state);
		console.log(`📊 Laporan terjadwal ${timeLabel} terkirim.`);
	} catch (err) {
		console.error("Gagal kirim laporan terjadwal:", err.message);
	}
}

// === COMMAND HELPERS ===
function buildCmdMessage(includeAdmin) {
	const umum =
		"*Perintah Umum:*\n\n" +
		"1. `/register <nomor>` - Daftarkan device linked (LID) agar bisa memakai command.\n" +
		"2. `/salam` - Menampilkan status router saat ini. Perintah ini membantu memantau kondisi router dan memastikan semuanya berjalan baik.\n" +
		"3. `/detail <down|up> <prefix>` - Menampilkan daftar user yang down/online dari notifikasi Link XXX terakhir (contoh: `/detail down BRN` atau `/detail up PGK`).\n" +
		"4. `/cmd` - Menampilkan bantuan ini agar Anda memahami cara memakai perintah lain dan memecahkan masalah umum.";

	if (!includeAdmin) {
		return umum;
	}

	const admin =
		"*Perintah Admin:*\n\n" +
		"1. `/targets <add|remove|list> [id] [all|link]` - Mengelola target pada sistem dengan opsi:\n" +
		" * `add [id] all`: Menambahkan target yang menerima semua notifikasi (default).\n" +
		" * `add [id] link`: Menambahkan target yang hanya menerima notifikasi link down (≥10 user).\n" +
		" * `remove [id]`: Menghapus target dengan ID tersebut.\n" +
		" * `list`: Menampilkan daftar target aktif beserta tipenya.\n" +
		"2. `/threshold <min> <max>` - Menyetel batas waktu minimum dan maksimum downtime yang akan dipantau.\n" +
		"3. `/blacklist <add|remove|list> [nama]` - Mengelola daftar user yang diabaikan dengan opsi:\n" +
		" * `add [nama]`: Menambahkan nama ke blacklist.\n" +
		" * `remove [nama]`: Menghapus nama dari blacklist.\n" +
		" * `list`: Menampilkan daftar user yang diabaikan.\n" +
		"4. `/jadwal [jam...]` - Mengatur jam laporan monitoring otomatis (contoh: `/jadwal 07:00 15:00`).";

	return `${umum}\n\n${admin}`;
}

function isAdminChat(chatId) {
	if (!ADMIN_CHAT_IDS.length) return true;
	
	// 1. Cek langsung dengan ID asli
	const normalizedChatId = normalizeChatId(chatId);
	const directMatch = ADMIN_CHAT_IDS.some((id) => normalizeChatId(id) === normalizedChatId);
	if (directMatch) return true;
	
	// 2. Cek dengan ekstraksi nomor (support linked device)
	const chatNumber = extractPhoneNumber(normalizedChatId);
	return ADMIN_CHAT_IDS.some(adminId => {
		const adminNumber = extractPhoneNumber(normalizeChatId(adminId));
		return chatNumber === adminNumber;
	});
}

function isTargetChat(chatId) {
	// 1. Cek langsung dengan ID asli
	const normalizedChatId = normalizeChatId(chatId);
	const directMatch = targets.ids.some(t => normalizeChatId(t.id) === normalizedChatId);
	if (directMatch) {
		console.log(`✅ isTargetChat(${chatId}): true (direct match)`);
		return true;
	}
	
	// 2. Cek dengan cache device ID
	if (deviceToTargetCache.has(normalizedChatId)) {
		console.log(`✅ isTargetChat(${chatId}): true (cached as ${deviceToTargetCache.get(normalizedChatId)})`);
		return true;
	}
	
	// 3. Cek dengan ekstraksi nomor (fallback untuk linked device)
	const chatNumber = extractPhoneNumber(normalizedChatId);
	const numberMatch = targets.ids.some(t => {
		const targetNumber = extractPhoneNumber(normalizeChatId(t.id));
		return chatNumber === targetNumber;
	});
	
	if (numberMatch) {
		console.log(`✅ isTargetChat(${chatId}): true (number match)`);
		return true;
	}
	
	// Debug jika tidak match
	console.log(`🔍 isTargetChat(${chatId}): false`);
	console.log(`   Extracted: ${chatNumber}`);
	console.log(`   Target IDs: ${targets.ids.map(t => t.id).join(", ")}`);
	console.log(`   Cached devices: ${Array.from(deviceToTargetCache.keys()).join(", ") || "none"}`);
	
	return false;
}

// === COMMAND HANDLER ===
async function handleCommands(client, msg) {
	const body = msg.body.trim();
	if (!body.startsWith("/")) return false;

	const chatId = msg.from;
	const isAdminContext = isAdminChat(chatId);
	const isTargetContext = isTargetChat(chatId);
	const lower = body.toLowerCase();

	// Log semua command yang masuk
	console.log(`\n📥 Command masuk: "${body}" dari ${chatId}`);
	console.log(`   Admin: ${isAdminContext}, Target: ${isTargetContext}`);

	if (lower.startsWith("/register")) {
		const parts = body.split(/\s+/);
		const inputNumber = normalizePhoneNumber(parts[1]);

		if (!inputNumber) {
			await msg.reply(
				"Format: /register <nomor>\n\n" +
				"Contoh:\n/register 6285137387227"
			);
			return true;
		}

		const normalizedChatId = normalizeChatId(chatId);
		const matchedTarget = targets.ids.find((t) => {
			const targetNumber = normalizePhoneNumber(
				extractPhoneNumber(normalizeChatId(t.id))
			);
			return targetNumber === inputNumber;
		});

		if (!matchedTarget) {
			await msg.reply(
				"❌ Nomor belum terdaftar sebagai target.\n" +
				"Hubungi admin untuk menambahkan nomor Anda terlebih dahulu."
			);
			return true;
		}

		deviceToTargetCache.set(normalizedChatId, matchedTarget.id);
		await msg.reply(
			"✅ Device berhasil didaftarkan.\n\n" +
			`Device: ${chatId}\n` +
			`Target: ${matchedTarget.id}`
		);
		console.log(`✅ Manual mapping: ${normalizedChatId} → ${matchedTarget.id}`);
		return true;
	}

	// DEBUG: Command untuk cek ID dan akses
	if (lower === "/debug") {
		const info = 
			`🔍 *Debug Info*\n\n` +
			`Chat ID: ${chatId}\n` +
			`Is Admin: ${isAdminContext}\n` +
			`Is Target: ${isTargetContext}\n\n` +
			`Admin IDs:\n${ADMIN_CHAT_IDS.join("\n")}\n\n` +
			`Target IDs:\n${targets.ids.map(t => `${t.id} (${t.type})`).join("\n")}\n\n` +
			`Pesan ini bisa dilihat siapa saja untuk debugging.`;
		await msg.reply(info);
		return true;
	}

	if (lower === "/cmd") {
		console.log(`📝 Command /cmd dari ${chatId} - Admin: ${isAdminContext}, Target: ${isTargetContext}`);
		
		if (!isAdminContext && !isTargetContext) {
			console.log(`❌ Akses ditolak untuk ${chatId}`);
			return true;
		}

		await msg.reply(buildCmdMessage(isAdminContext));
		return true;
	}

	if (lower === "/salam") {
		console.log(`📝 Command /salam dari ${chatId} - Admin: ${isAdminContext}, Target: ${isTargetContext}`);
		
		if (!isAdminContext && !isTargetContext) {
			console.log(`❌ Akses ditolak untuk ${chatId}`);
			return true;
		}
		try {
			const statuses = await fetchStatuses();
			await msg.reply(buildReport(statuses));
		} catch (err) {
			await msg.reply("Gagal mengambil data monitoring.");
		}
		return true;
	}

	if (lower.startsWith("/detail")) {
		console.log(`📝 Command /detail dari ${chatId} - Admin: ${isAdminContext}, Target: ${isTargetContext}`);
		
		if (!isAdminContext && !isTargetContext) {
			console.log(`❌ Akses ditolak untuk ${chatId}`);
			return true;
		}
		
		const parts = body.split(" ");
		const statusOrPrefix = parts[1]?.toLowerCase();
		const prefix = parts[2]?.toUpperCase();
		
		// Jika tidak ada parameter atau hanya 1 parameter (backward compatible)
		if (!statusOrPrefix) {
			const availableDown = Object.keys(lastGroupedAlerts);
			const availableUp = Object.keys(lastGroupedRecovery);
			
			if (availableDown.length > 0 || availableUp.length > 0) {
				let text = "Format: /detail <down|up> <prefix>\n\n";
				if (availableDown.length > 0) {
					text += "Prefix Down tersedia:\n" + availableDown.map(p => `- ${p}`).join("\n") + "\n\n";
				}
				if (availableUp.length > 0) {
					text += "Prefix Up tersedia:\n" + availableUp.map(p => `- ${p}`).join("\n");
				}
				await msg.reply(text.trim());
			} else {
				await msg.reply("Belum ada notifikasi Link Down/Up yang di-grup. Format: /detail <down|up> <prefix>");
			}
			return true;
		}
		
		// Cek apakah format lama /detail <prefix> (backward compatible)
		if (!prefix && statusOrPrefix) {
			const oldPrefix = statusOrPrefix.toUpperCase();
			const users = lastGroupedAlerts[oldPrefix] || [];
			
			if (users.length > 0) {
				const router = toDisplayRouterName(users[0].router);
				const text = 
					`📋 *Detail Link ${oldPrefix} Down*\n` +
					`📟 Router: ${router}\n` +
					`👥 Total: ${users.length} user\n\n` +
					"Daftar user:\n" +
					users.map((u, i) => `${i + 1}. ${u.user}`).join("\n");
				await msg.reply(text);
				return true;
			}
		}
		
		// Format baru: /detail <down|up> <prefix>
		if (statusOrPrefix === 'down' || statusOrPrefix === 'up') {
			if (!prefix) {
				const available = statusOrPrefix === 'down' 
					? Object.keys(lastGroupedAlerts)
					: Object.keys(lastGroupedRecovery);
				
				if (available.length > 0) {
					await msg.reply(
						`Format: /detail ${statusOrPrefix} <prefix>\n\n` +
						`Prefix ${statusOrPrefix === 'down' ? 'Down' : 'Up'} tersedia:\n` +
						available.map(p => `- ${p}`).join("\n")
					);
				} else {
					await msg.reply(`Belum ada notifikasi Link ${statusOrPrefix === 'down' ? 'Down' : 'Up'} yang di-grup.`);
				}
				return true;
			}
			
			const dataSource = statusOrPrefix === 'down' ? lastGroupedAlerts : lastGroupedRecovery;
			const users = dataSource[prefix] || [];
			
			if (users.length > 0) {
				const router = toDisplayRouterName(users[0].router);
				const statusEmoji = statusOrPrefix === 'down' ? '💥' : '✅';
				const statusText = statusOrPrefix === 'down' ? 'Down' : 'Online Kembali';
				
				const text = 
					`📋 *Detail Link ${prefix} ${statusText}*\n` +
					`📟 Router: ${router}\n` +
					`👥 Total: ${users.length} user\n\n` +
					"Daftar user:\n" +
					users.map((u, i) => `${i + 1}. ${u.user}`).join("\n");
				await msg.reply(text);
			} else {
				const available = Object.keys(dataSource);
				if (available.length > 0) {
					await msg.reply(
						`Tidak ada data untuk prefix "${prefix}" yang ${statusOrPrefix === 'down' ? 'down' : 'online'}.\n\n` +
						`Prefix ${statusOrPrefix === 'down' ? 'Down' : 'Up'} tersedia:\n` +
						available.map(p => `- ${p}`).join("\n")
					);
				} else {
					await msg.reply(`Tidak ada data link ${statusOrPrefix === 'down' ? 'down' : 'up'} untuk prefix tersebut.`);
				}
			}
			return true;
		}
		
		// Jika format tidak sesuai
		await msg.reply("Format: /detail <down|up> <prefix>\n\nContoh:\n/detail down BRN\n/detail up PGK");
		return true;
	}

	if (lower.startsWith("/targets")) {
		if (!isAdminContext) return true;

		const parts = body.split(" ");
		const action = parts[1];
		const targetId = parts[2];
		const targetType = parts[3]?.toLowerCase();

		if (action === "list" || !action) {
			if (targets.ids.length) {
				const text = "Target saat ini:\n" + targets.ids.map((t, i) => {
					const typeLabel = t.type === 'all' ? '(semua notifikasi)' : '(hanya link down)';
					return `${i + 1}. ${t.id} ${typeLabel}`;
				}).join("\n");
				await msg.reply(text);
			} else {
				await msg.reply("Belum ada target.");
			}
			return true;
		}

		if (action === "add" && targetId) {
			const type = (targetType === 'link' || targetType === 'all') ? targetType : 'all';
			const exists = targets.ids.find(t => t.id === targetId);
			
			if (!exists) {
				targets.ids.push({ id: targetId, type });
				saveJson(TARGETS_FILE, targets);
				const typeLabel = type === 'all' ? 'semua notifikasi' : 'hanya link down';
				await msg.reply(`Target ditambahkan: ${targetId} (${typeLabel})`);
			} else {
				await msg.reply("Target sudah ada.");
			}
			return true;
		}

		if (action === "remove" && targetId) {
			targets.ids = targets.ids.filter((t) => t.id !== targetId);
			saveJson(TARGETS_FILE, targets);
			
			// Clear cache untuk device ID yang terkait dengan target ini
			for (const [deviceId, mappedTargetId] of deviceToTargetCache.entries()) {
				if (mappedTargetId === targetId) {
					deviceToTargetCache.delete(deviceId);
					console.log(`🗑️ Cleared cache mapping: ${deviceId} → ${mappedTargetId}`);
				}
			}
			
			await msg.reply(`Target dihapus: ${targetId}`);
			return true;
		}

		await msg.reply("Format: /targets <add|remove|list> [id] [all|link]\n\nContoh:\n/targets add 6287715308060@c.us all\n/targets add 6287715308060@c.us link");
		return true;
	}

	if (lower.startsWith("/threshold")) {
		if (!isAdminContext) return true;

		const parts = body.split(/\s+/);
		const min = Number(parts[1]);
		const max = Number(parts[2]);

		if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
			await msg.reply("Format: /threshold <min_menit> <max_menit>");
			return true;
		}

		state.threshold = { minMinutes: min, maxMinutes: max };
		saveJson(STATE_FILE, state);
		await msg.reply(`Threshold diset: ${min}-${max} menit`);
		return true;
	}

	if (lower.startsWith("/blacklist")) {
		if (!isAdminContext) return true;

		const tokens = body.split(" ");
		const action = tokens[1];
		const name = tokens.slice(2).join(" ");

		if (action === "list" || !action) {
			const text = blacklist.users.length
				? "Blacklist:\n" + blacklist.users.map((u, i) => `${i + 1}. ${u}`).join("\n")
				: "Blacklist kosong.";
			await msg.reply(text);
			return true;
		}

		if (action === "add" && name) {
			if (!isBlacklisted(name)) {
				blacklist.users.push(name);
				saveJson(BLACKLIST_FILE, blacklist);
				await msg.reply(`Ditambahkan ke blacklist: ${name}`);
			} else {
				await msg.reply("Sudah ada di blacklist.");
			}
			return true;
		}

		if (action === "remove" && name) {
			blacklist.users = blacklist.users.filter((u) => u.toLowerCase() !== name.toLowerCase());
			saveJson(BLACKLIST_FILE, blacklist);
			await msg.reply(`Dihapus dari blacklist: ${name}`);
			return true;
		}

		await msg.reply("Format: /blacklist <add|remove|list> [nama]");
		return true;
	}

	if (lower.startsWith("/jadwal")) {
		if (!isAdminContext) return true;

		const tokens = body.split(/\s+/).slice(1).filter(Boolean);
		if (!tokens.length) {
			await msg.reply(`Jadwal saat ini: ${getScheduleTimes().join(", ")}`);
			return true;
		}

		const validTimes = [];
		for (const token of tokens) {
			const parsed = parseScheduleTime(token);
			if (!parsed) {
				await msg.reply("Format jam tidak valid. Gunakan HH:MM, contoh: /jadwal 07:00 15:00");
				return true;
			}
			validTimes.push(parsed.label);
		}

		state.scheduleTimes = Array.from(new Set(validTimes));
		saveJson(STATE_FILE, state);
		scheduleReportJobs(client);
		await msg.reply(`Jadwal laporan diperbarui: ${state.scheduleTimes.join(", ")}`);
		return true;
	}

	return false;
}

// === LOOP UTAMA ===
function startLoops(client) {
	checkAlerts(client);
	if (alertInterval) clearInterval(alertInterval);
	alertInterval = setInterval(() => checkAlerts(client), CHECK_INTERVAL_MS);
	scheduleReportJobs(client);
}

// === INISIALISASI BOT ===
console.log("🚀 Memulai bot WhatsApp Salam...");

async function startSock() {
	const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();

	const sock = makeWASocket({
		version,
		auth: authState,
		logger: pino({ level: "silent" }),
		browser: ["Salam Monitoring Bot", "Chrome", "1.0.0"],
		printQRInTerminal: false,
	});

	sock.ev.on("creds.update", saveCreds);

	sock.ev.on("connection.update", (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			console.clear();
			console.log("📱 Scan QR berikut:");
			qrcode.generate(qr, { small: true });
		}

		if (connection === "open") {
			console.log("✅ Bot siap. Memulai monitoring...");
			startLoops(sock);
		}

		if (connection === "close") {
			const statusCode = lastDisconnect?.error?.output?.statusCode;
			const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
			console.log("❌ WhatsApp terputus:", lastDisconnect?.error?.message || "unknown");
			if (shouldReconnect) {
				setTimeout(() => {
					startSock();
				}, 5000);
			} else {
				console.log("⚠️  Logged out. Hapus folder auth dan scan QR ulang.");
			}
		}
	});

	sock.ev.on("messages.upsert", async (event) => {
		if (event.type !== "notify") return;

		for (const msg of event.messages) {
			if (!msg.message) continue;
			if (msg.key.fromMe) continue;
			const chatId = msg.key.remoteJid;
			if (!chatId || chatId === "status@broadcast") continue;

			const body = getMessageText(msg.message);
			if (!body) continue;

			const normalizedMsg = {
				body,
				from: chatId,
				reply: (text) => sendText(sock, chatId, text, msg),
			};

			await handleCommands(sock, normalizedMsg);
		}
	});
}

startSock().catch((err) => {
	console.error("❌ Gagal memulai Baileys:", err.message);
});