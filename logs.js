// logs.js - سیستم logging برای رزروها
const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "logs");
const HISTORY_FILE = path.join(LOGS_DIR, "history.json");

// ایجاد پوشه logs اگر وجود ندارد
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getOrCreateHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    } catch {
        return { entries: [] };
    }
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

function logReservation(data) {
    const {
        date,           // YYYY-MM-DD
        window,         // e.g., "20-21"
        status,         // "success" | "failed"
        message,        // پیام سرور
        error,          // خطای اختیاری
        timestamp       // ISO datetime
    } = data;

    const history = getOrCreateHistory();

    const entry = {
        id: `${date}-${window}-${Date.now()}`,
        date,
        window,
        status,
        message: message || "",
        error: error || null,
        timestamp: timestamp || new Date().toISOString(),
        jalaliDate: toJalaliString(new Date(date))
    };

    history.entries.push(entry);

    // نگه‌داشتن تنها ۹۰ روز آخر
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    history.entries = history.entries.filter(e => new Date(e.timestamp) > cutoffDate);

    saveHistory(history);
    return entry;
}

function getHistory(limit = 50) {
    const history = getOrCreateHistory();
    return history.entries.reverse().slice(0, limit);
}

function getHistoryByDate(date) {
    const history = getOrCreateHistory();
    return history.entries.filter(e => e.date === date);
}

function toJalaliString(d) {
    const gy = d.getFullYear(), gm = d.getMonth() + 1, gd = d.getDate();
    function div(a, b) { return Math.floor(a / b); }
    const g_d_m = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gy2 = gy - 1600, gm2 = gm - 1, gd2 = gd - 1;
    let g_day_no = 365 * gy2 + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400);
    for (let i = 0; i < gm2; i++) g_day_no += g_d_m[i + 1];
    g_day_no += gd2;
    let j_day_no = g_day_no - 79;
    const j_np = div(j_day_no, 12053); j_day_no %= 12053;
    let jy = 979 + 33 * j_np + 4 * div(j_day_no, 1461); j_day_no %= 1461;
    if (j_day_no >= 366) { jy += div(j_day_no - 366, 365); j_day_no = (j_day_no - 366) % 365; }
    const jm_list = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
    let jm = 0; for (; jm < 12 && j_day_no >= jm_list[jm]; jm++) j_day_no -= jm_list[jm];
    const jd = j_day_no + 1;
    return `${jy}/${String(jm + 1).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;
}

module.exports = {
    logReservation,
    getHistory,
    getHistoryByDate
};
