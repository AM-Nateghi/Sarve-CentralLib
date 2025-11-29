// server.js
// Install: npm install express cors body-parser dayjs fs axios tough-cookie axios-cookiejar-support cheerio
// Run: node server.js

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const axios = require("axios");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const { logReservation, getHistory, getHistoryByDate } = require("./logs");

// -------------------- Persian date helper (very lightweight) --------------------
function toJalaliString(d) {
    // Minimal Jalali converter for display; you can swap with a lib if you prefer.
    // Algorithm adapted (light) — not exact for edge centuries but fine for current usage:
    // For production-grade accuracy, use 'jalaali-js' or 'moment-jalaali'.
    const gy = d.year(), gm = d.month() + 1, gd = d.date();
    function div(a, b) { return Math.floor(a / b); }
    const g_d_m = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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

// -------------------- Config and storage --------------------
const STORE_PATH = path.join(__dirname, "store.json");
const defaultStore = {
    username: "0928731571",
    passwd: "AmN!@#27",
    seat_number: 33,
    sc: "ktDKKeFZe5lkOhWTITfdmQ==",
    reserveDateMode: "today", // today | tomorrow
    selectedWindows: [], // e.g., ["8-11","17-20"]
    scheduledDays: {},   // { "YYYY-MM-DD": ["8-11","20-21"] }
    lastMonthQuota: null // optional server-reported quota
};
function readStore() {
    try {
        return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    } catch {
        fs.writeFileSync(STORE_PATH, JSON.stringify(defaultStore, null, 2));
        return { ...defaultStore };
    }
}
function writeStore(st) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(st, null, 2));
}

// -------------------- Reservation core (login/reserve) --------------------
const TIME_WINDOWS = {
    "8-11": { start: 8, end: 11 },
    "11-14": { start: 11, end: 14 },
    "14-17": { start: 14, end: 17 },
    "17-20": { start: 17, end: 20 },
    "20-21": { start: 20, end: 21 }
};
function computeReserveDate(mode) {
    const now = dayjs();
    const target = mode === "tomorrow" ? now.add(1, "day") : now;
    const mm = String(target.month() + 1).padStart(2, "0");
    const dd = String(target.date()).padStart(2, "0");
    const yyyy = String(target.year());
    return {
        slashDate: `${mm}/${dd}/${yyyy}`,
        fullDateString: `${mm}/${dd}/${yyyy} 12:00:00 AM`,
        year: yyyy,
        month: mm,
        iso: target.format("YYYY-MM-DD"),
        jalali: toJalaliString(target)
    };
}
function buildClient() {
    const jar = new tough.CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        timeout: 15000
    }));
    client.defaults.headers.common["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    return client;
}
async function login(client, store) {
    try {
        console.log("[Login] Getting login page...");
        await client.get(`https://110129.samanpl.ir/Account/Login`, {
            headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
        });

        console.log("[Login] Posting credentials...");
        const res = await client.post(
            `https://110129.samanpl.ir/Account/Login`,
            new URLSearchParams({
                returnUrl: `/Home/ReserveService?ps=${store.sc}`,
                UserName: store.username,
                Password: store.passwd
            }).toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Origin: "https://110129.samanpl.ir",
                    Referer: `https://110129.samanpl.ir/Account/Login/?returnUrl=%2fHome%2fReserveService%3fps%3d${encodeURIComponent(store.sc)}`,
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
                maxRedirects: 0,
                validateStatus: (s) => s >= 200 && s < 400
            }
        );

        const location = res.headers.location || `/Home/ReserveService?ps=${store.sc}`;
        console.log("[Login] Redirecting to:", location);
        // اصلاح: اگر location شامل https:// باشد، مستقیم استفاده کن
        const fullUrl = location.startsWith("http") ? location : `https://110129.samanpl.ir${location}`;
        await client.get(fullUrl, {
            headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
        });

        console.log("[Login] Login successful!");
        return true;
    } catch (e) {
        console.error("[Login] Error:", e.message);
        throw e;
    }
}
async function openSeatPopupHTML(client, store, dateInfo, label) {
    const w = TIME_WINDOWS[label];
    const payload = new URLSearchParams({
        sc: store.sc,
        Sdate: dateInfo.fullDateString,
        Shour: String(w.start),
        Thour: String(w.end),
        year: dateInfo.year,
        month: dateInfo.month
    }).toString();
    try {
        console.log(`[openSeatPopupHTML] Requesting popup for ${label}...`);
        const res = await client.post(`https://110129.samanpl.ir/Home/ReserveDetail`, payload, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: "https://110129.samanpl.ir",
                Referer: `https://110129.samanpl.ir/Home/ReserveService?ps=${store.sc}`,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
        });
        return res.data;
    } catch (e) {
        console.error(`[openSeatPopupHTML] Error: ${e.message}`);
        throw new Error(`Failed to get seat popup for ${label}: ${e.message}`);
    }
}
function extractCsrfSeatAndUser(html, seatNumber) {
    const $ = cheerio.load(html);
    const token = $("input[name='__RequestVerificationToken']").val() || "";
    const seatDiv = $("div.block").filter((i, el) => $(el).text().trim() === String(seatNumber)).first();
    const seatId = seatDiv.attr("id");
    let userId = "";
    const scripts = $("script").map((i, el) => $(el).html() || "").get().join("\n");
    const m = scripts.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (m) userId = m[0];
    if (!token) throw new Error("CSRF token not found");
    if (!seatId) throw new Error(`Seat ${seatNumber} not found`);
    return { token, seatId, userId };
}
async function reserveOnce(client, store, dateInfo, label) {
    try {
        console.log(`[reserveOnce] Starting reservation for ${label}...`);
        const html = await openSeatPopupHTML(client, store, dateInfo, label);
        const { token, seatId, userId } = extractCsrfSeatAndUser(html, store.seat_number);
        const w = TIME_WINDOWS[label];
        const payload = new URLSearchParams({
            __RequestVerificationToken: token,
            Id: seatId,
            date: dateInfo.fullDateString,
            SHour: String(w.start),
            THour: String(w.end),
            userId: userId || ""
        }).toString();

        console.log(`[reserveOnce] Posting reservation...`);
        const res = await client.post(`https://110129.samanpl.ir/Common/Portal/ReservesLibraryNew`, payload, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: "https://110129.samanpl.ir",
                Referer: `https://110129.samanpl.ir/Home/ReserveDetail`,
                Accept: "application/json,*/*"
            }
        });

        console.log(`[reserveOnce] Response:`, res.data);
        return res.data;
    } catch (e) {
        console.error(`[reserveOnce] Error for ${label}:`, e.message);
        throw e;
    }
}
async function reserveSeatFlow(store, labels) {
    const client = buildClient();
    await login(client, store);
    const dateInfo = computeReserveDate(store.reserveDateMode);
    const results = [];
    for (const label of labels) {
        try {
            const r = await reserveOnce(client, store, dateInfo, label);
            const success = !!r.Success;
            const message = r.Message || "";

            results.push({ label, success, message });

            // ثبت لاگ
            logReservation({
                date: dateInfo.iso,
                window: label,
                status: success ? "success" : "failed",
                message: message,
                timestamp: new Date().toISOString()
            });

            // small jitter
            await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
        } catch (e) {
            results.push({ label, success: false, message: e.message });

            // ثبت خطا در لاگ
            logReservation({
                date: dateInfo.iso,
                window: label,
                status: "failed",
                message: "",
                error: e.message,
                timestamp: new Date().toISOString()
            });
        }
    }
    // optional: parse quota from messages
    const quotaMsg = results.find(x => x.success && /سهم|باقی مانده/.test(x.message));
    if (quotaMsg) {
        store.lastMonthQuota = quotaMsg.message;
        writeStore(store);
    }
    return { dateInfo, results };
}

// -------------------- Scheduler (07:01 daily for selected day mode) --------------------
let schedulerTimer = null;
function scheduleDaily() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(async () => {
        const store = readStore();
        const now = dayjs();
        const target = now.hour() === 7 && now.minute() === 1;
        if (!target) return;
        const labels = store.selectedWindows && store.selectedWindows.length ? store.selectedWindows : [];
        if (!labels.length) return;
        try {
            const { results, dateInfo } = await reserveSeatFlow(store, labels);
            console.log(`[Scheduler] ${dateInfo.iso} ->`, results);
            // mark scheduledDays
            const key = dateInfo.iso;
            store.scheduledDays[key] = labels;
            writeStore(store);
        } catch (e) {
            console.error("[Scheduler] error:", e.message);
        }
    }, 10 * 1000); // check every 10s (you can change to 30s/60s)
}
scheduleDaily();

// No embedded HTML - serving from public/index.html now

// -------------------- Express API --------------------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

// Serve the index.html for root path
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==================== API Routes ====================

// Get full config
app.get("/api/config", (req, res) => {
    const st = readStore();
    res.json({
        username: st.username,
        passwd: st.passwd,
        seat_number: st.seat_number,
        sc: st.sc,
        reserveDateMode: st.reserveDateMode,
        selectedWindows: st.selectedWindows || [],
        scheduledDays: st.scheduledDays || {},
        lastMonthQuota: st.lastMonthQuota || null
    });
});

// Update main config (seat_number, reserveDateMode, selectedWindows)
app.post("/api/config", (req, res) => {
    const st = readStore();
    const { seat_number, reserveDateMode, selectedWindows } = req.body || {};

    if (seat_number) st.seat_number = parseInt(seat_number, 10);
    if (reserveDateMode && ["today", "tomorrow"].includes(reserveDateMode)) st.reserveDateMode = reserveDateMode;
    if (Array.isArray(selectedWindows)) st.selectedWindows = selectedWindows.filter(w => TIME_WINDOWS[w]);

    writeStore(st);
    res.json({ ok: true });
});

// Update advanced settings (username, password, sc, etc)
app.post("/api/settings", (req, res) => {
    const st = readStore();
    const { username, passwd, seat_number, sc, reserveDateMode } = req.body || {};

    if (username) st.username = username;
    if (passwd) st.passwd = passwd;
    if (seat_number) st.seat_number = parseInt(seat_number, 10);
    if (sc) st.sc = sc;
    if (reserveDateMode && ["today", "tomorrow"].includes(reserveDateMode)) st.reserveDateMode = reserveDateMode;

    writeStore(st);
    res.json({ ok: true });
});

// Schedule a specific day with windows
app.post("/api/schedule-day", (req, res) => {
    const st = readStore();
    const { date, windows } = req.body || {};

    if (!date) return res.status(400).json({ ok: false, error: "date required" });

    if (!Array.isArray(windows) || windows.length === 0) {
        // Delete if empty
        delete st.scheduledDays[date];
    } else {
        st.scheduledDays[date] = windows.filter(w => TIME_WINDOWS[w]);
    }

    writeStore(st);
    res.json({ ok: true });
});

// Reserve immediately for selected windows (or provided windows)
app.post("/api/reserve", async (req, res) => {
    try {
        const st = readStore();
        const windows = Array.isArray(req.body.windows) ? req.body.windows.filter(w => TIME_WINDOWS[w]) : (st.selectedWindows || []);
        if (!windows.length) return res.status(400).json({ ok: false, error: "No windows selected" });
        const { results, dateInfo } = await reserveSeatFlow(st, windows);
        // Mark scheduledDays for the date
        const key = dateInfo.iso;
        st.scheduledDays[key] = windows;
        writeStore(st);
        res.json({ ok: true, date: dateInfo, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Get reservation history
app.get("/api/history", (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = getHistory(limit);
    res.json({ ok: true, entries: history });
});

// Get history for a specific date
app.get("/api/history/:date", (req, res) => {
    const { date } = req.params;
    const history = getHistoryByDate(date);
    res.json({ ok: true, entries: history });
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Anti-Kokh listening on http://localhost:${port}`));
