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
const DEFAULT_ALERT_DELAY_MS = 30 * 1000; // Jeda antar notifikasi down
const TZ = "Asia/Jakarta";
const DEFAULT_SCHEDULES = ["07:00", "15:00"]; // WIB, mudah diubah lewat /jadwal
const DEFAULT_THRESHOLD = { minMinutes: 15, maxMinutes: 300 };
const DEFAULT_TARGETS = ["120363406015508176@g.us"]; // Contoh grup WA
const ADMIN_CHAT_IDS = ["6287715308060@c.us"]; // Isi dengan chat (grup/nomor) yang boleh pakai perintah admin

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
	notificationDelayMs: DEFAULT_ALERT_DELAY_MS,
});

if (!state.threshold) {
	state.threshold = DEFAULT_THRESHOLD;
}

if (!state.scheduleTimes || !state.scheduleTimes.length) {
	state.scheduleTimes = DEFAULT_SCHEDULES.slice();
}

if (!state.notificationDelayMs) {
	state.notificationDelayMs = DEFAULT_ALERT_DELAY_MS;
	saveJson(STATE_FILE, state);
}

let blacklist = ensureJson(BLACKLIST_FILE, { users: [] });
let targets = ensureJson(TARGETS_FILE, { ids: DEFAULT_TARGETS });
let scheduledJobs = []; // Cron jobs aktif untuk laporan terjadwal

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

async function sendToTargets(client, message, perTargetDelayMs = 500) {
	for (const id of targets.ids) {
		try {
			await client.sendMessage(id, message);
			await delay(perTargetDelayMs);
		} catch (err) {
			console.error(`Gagal kirim ke ${id}:`, err.message);
		}
	}
}

// === FORMAT PESAN ===
function buildOfflineMessage(entry) {
    const since = entry.offlineSince
        ? formatDateTime(entry.offlineSince)
        : "(waktu tidak diketahui)";

    return `💥 User: ${entry.user}\n⏰ Down sejak: ${since}`;
}

function buildGroupedOfflineMessage(entries) {
    const lines = [];

    for (const entry of entries) {
        const since = entry.offlineSince ? formatDateTime(entry.offlineSince) : "(waktu tidak diketahui)";
        lines.push(`💥 User: ${entry.user}`);
        lines.push(`⏰ Down sejak: ${since}`);
        lines.push(""); // separator antar user
    }

    return lines.join("\n").trim();
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
async function fetchStatuses() {
	const responses = await Promise.all(
		ROUTERS.map((router) => axios.get(STATUS_ENDPOINT(router), { timeout: 10000 }))
	);
	return responses.map((r) => r.data);
}

async function fetchOfflineAll() {
	const res = await axios.get(OFFLINE_ENDPOINT, { timeout: 10000 });
	return res.data?.users || [];
}

// === LOGIKA ALERT ===
async function checkAlerts(client) {
	try {
		const offlineUsers = await fetchOfflineAll();
		const activeKeys = new Set();
		const newAlerts = [];

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

		if (newAlerts.length >= 3) {
			const groupedMessage = buildGroupedOfflineMessage(newAlerts);
			await sendToTargets(client, groupedMessage, state.notificationDelayMs || DEFAULT_ALERT_DELAY_MS);
		} else {
			for (let i = 0; i < newAlerts.length; i++) {
				if (i > 0) await delay(state.notificationDelayMs || DEFAULT_ALERT_DELAY_MS);
				await sendToTargets(client, buildOfflineMessage(newAlerts[i]), state.notificationDelayMs || DEFAULT_ALERT_DELAY_MS);
			}
		}

		for (const entry of newAlerts) {
			upsertNotified(entry.router, entry.user, entry.offlineSince);
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
		const message = buildReport(statuses);
		await sendToTargets(client, message);

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
		"2. `/cmd` - Menampilkan bantuan ini agar Anda memahami cara memakai perintah lain dan memecahkan masalah umum.";

	if (!includeAdmin) {
		return umum;
	}

	const admin =
		"*Perintah Admin:*\n\n" +
		"1. `/targets <add|remove|list> [id]` - Mengelola target pada sistem dengan opsi:\n" +
		" * `add [id]`: Menambahkan target baru dengan ID tertentu.\n" +
		" * `remove [id]`: Menghapus target dengan ID tersebut.\n" +
		" * `list`: Menampilkan daftar target aktif.\n" +
		"2. `/threshold <min> <max>` - Menyetel batas waktu minimum dan maksimum downtime yang akan dipantau.\n" +
		"3. `/blacklist <add|remove|list> [nama]` - Mengelola daftar user yang diabaikan dengan opsi:\n" +
		" * `add [nama]`: Menambahkan nama ke blacklist.\n" +
		" * `remove [nama]`: Menghapus nama dari blacklist.\n" +
		" * `list`: Menampilkan daftar user yang diabaikan.\n" +
		"4. `/jadwal [jam...]` - Mengatur jam laporan monitoring otomatis (contoh: `/jadwal 07:00 15:00`).\n" +
		"5. `/delay [detik]` - Melihat atau mengubah jeda antar notifikasi down (detik).";

	return `${umum}\n\n${admin}`;
}

function isAdminChat(chatId) {
	if (!ADMIN_CHAT_IDS.length) return true;
	return ADMIN_CHAT_IDS.includes(chatId);
}

function isTargetChat(chatId) {
	return targets.ids.includes(chatId);
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

	if (lower.startsWith("/targets")) {
		if (!isAdminContext) return true;

		const parts = body.split(" ");
		const action = parts[1];
		const value = parts.slice(2).join(" ");

		if (action === "list" || !action) {
			const text = targets.ids.length
				? "Target saat ini:\n" + targets.ids.map((id, i) => `${i + 1}. ${id}`).join("\n")
				: "Belum ada target.";
			await msg.reply(text);
			return true;
		}

		if (action === "add" && value) {
			if (!targets.ids.includes(value)) {
				targets.ids.push(value);
				saveJson(TARGETS_FILE, targets);
				await msg.reply(`Target ditambahkan: ${value}`);
			} else {
				await msg.reply("Target sudah ada.");
			}
			return true;
		}

		if (action === "remove" && value) {
			targets.ids = targets.ids.filter((id) => id !== value);
			saveJson(TARGETS_FILE, targets);
			await msg.reply(`Target dihapus: ${value}`);
			return true;
		}

		await msg.reply("Format: /targets <add|remove|list> [id]");
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

	if (lower.startsWith("/delay")) {
		if (!isAdminContext) return true;

		const parts = body.split(/\s+/);
		const value = parts[1];

		if (!value) {
			const seconds = Math.round((state.notificationDelayMs || DEFAULT_ALERT_DELAY_MS) / 1000);
			await msg.reply(`Delay notifikasi saat ini: ${seconds} detik`);
			return true;
		}

		const seconds = Number(value);
		if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
			await msg.reply("Format: /delay <detik> (0-600)");
			return true;
		}

		state.notificationDelayMs = seconds * 1000;
		saveJson(STATE_FILE, state);
		await msg.reply(`Delay notifikasi diset ke ${seconds} detik`);
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
	authStrategy: new LocalAuth(),
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
