const { Client, LocalAuth } = require("whatsapp-web.js");
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
const SESSION_NAME = "salam-monitoring-bot"; // Nama session untuk WhatsApp Web (akan muncul saat scan QR)

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

let scheduledJobs = []; // Cron jobs aktif untuk laporan terjadwal
let lastGroupedAlerts = {}; // Menyimpan grouped alerts terakhir untuk command /detail

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
			await client.sendMessage(id, message);
			await delay(500);
		} catch (err) {
			console.error(`Gagal kirim ke ${id}:`, err.message);
		}
	}
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
		return responses;
	} catch (err) {
		console.error("⚠️  Gagal mengambil status router:", err.message);
		return [];
	}
}

async function fetchOfflineAll() {
	try {
		const data = await fetchWithRetry(OFFLINE_ENDPOINT);
		return data?.users || [];
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
		const offlineUsers = await fetchOfflineAll();
		
		// Jika gagal fetch, skip cycle ini
		if (!offlineUsers || offlineUsers.length === 0) {
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

		removeClearedNotified(activeKeys);
	} catch (err) {
		console.error("Gagal cek alert:", err.message);
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
		"1. `/salam` - Menampilkan status router saat ini. Perintah ini membantu memantau kondisi router dan memastikan semuanya berjalan baik.\n" +
		"2. `/detail <prefix>` - Menampilkan daftar user yang down dari notifikasi Link XXX Down terakhir (contoh: `/detail BRN`).\n" +
		"3. `/cmd` - Menampilkan bantuan ini agar Anda memahami cara memakai perintah lain dan memecahkan masalah umum.";

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
	return ADMIN_CHAT_IDS.includes(chatId);
}

function isTargetChat(chatId) {
	return targets.ids.some(t => t.id === chatId);
}

// === COMMAND HANDLER ===
async function handleCommands(client, msg) {
	const body = msg.body.trim();
	if (!body.startsWith("/")) return false;

	const chatId = msg.from;
	const isAdminContext = isAdminChat(chatId);
	const isTargetContext = isTargetChat(chatId);
	const lower = body.toLowerCase();

	if (lower === "/cmd") {
		if (!isAdminContext && !isTargetContext) {
			return true;
		}

		await msg.reply(buildCmdMessage(isAdminContext));
		return true;
	}

	if (lower === "/salam") {
		if (!isAdminContext && !isTargetContext) return true;
		try {
			const statuses = await fetchStatuses();
			await msg.reply(buildReport(statuses));
		} catch (err) {
			await msg.reply("Gagal mengambil data monitoring.");
		}
		return true;
	}

	if (lower.startsWith("/detail")) {
		if (!isAdminContext && !isTargetContext) return true;
		
		const parts = body.split(" ");
		const prefix = parts[1]?.toUpperCase();
		
		if (!prefix) {
			const availablePrefixes = Object.keys(lastGroupedAlerts);
			if (availablePrefixes.length > 0) {
				await msg.reply(
					"Format: /detail <prefix>\n\n" +
					"Prefix yang tersedia:\n" +
					availablePrefixes.map(p => `- ${p}`).join("\n")
				);
			} else {
				await msg.reply("Belum ada notifikasi Link Down yang di-grup. Format: /detail <prefix>");
			}
			return true;
		}
		
		const users = lastGroupedAlerts[prefix] || [];
		
		if (users.length > 0) {
			const router = toDisplayRouterName(users[0].router);
			const text = 
				`📋 *Detail Link ${prefix} Down*\n` +
				`📟 Router: ${router}\n` +
				`👥 Total: ${users.length} user\n\n` +
				"Daftar user:\n" +
				users.map((u, i) => `${i + 1}. ${u.user}`).join("\n");
			await msg.reply(text);
		} else {
			const availablePrefixes = Object.keys(lastGroupedAlerts);
			if (availablePrefixes.length > 0) {
				await msg.reply(
					`Tidak ada data untuk prefix "${prefix}".\n\n` +
					"Prefix yang tersedia:\n" +
					availablePrefixes.map(p => `- ${p}`).join("\n")
				);
			} else {
				await msg.reply("Tidak ada data untuk prefix tersebut.");
			}
		}
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
	setInterval(() => checkAlerts(client), CHECK_INTERVAL_MS);
	scheduleReportJobs(client);
}

// === INISIALISASI BOT ===
console.log("🚀 Memulai bot WhatsApp Salam...");

const client = new Client({
	authStrategy: new LocalAuth({ clientId: SESSION_NAME }),
	puppeteer: {
		headless: true,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
	},
});

client.on("qr", (qr) => {
	console.clear();
	console.log("📱 Scan QR berikut:");
	qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
	console.log("✅ Bot siap. Memulai monitoring...");
	startLoops(client);
});

client.on("message", async (msg) => {
	await handleCommands(client, msg);
});

client.on("disconnected", (reason) => {
	console.log("❌ WhatsApp terputus:", reason);
});

client.on("auth_failure", (msg) => {
	console.error("❌ Autentikasi gagal:", msg);
});

client.initialize();