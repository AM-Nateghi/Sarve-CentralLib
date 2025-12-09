// server.js
// Install: npm install express cors body-parser dayjs fs axios tough-cookie axios-cookiejar-support cheerio node-cron mysql2
// Run: node server.js

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dayjs = require("dayjs");
const axios = require("axios");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const { initDatabase, logReservation, getHistory, getHistoryByDate, readStore, writeStore } = require("./db");
const { startScheduler } = require("./scheduler");
const { Server } = require("socket.io");

// Global WebSocket instance
let io = null;

// Emit progress updates over WebSocket if available
function emitProgress(runId, label, step, totalSteps, message, status = "progress") {
    if (!io) return;
    io.emit("reserve:progress", { runId, label, step, totalSteps, message, status, ts: new Date().toISOString() });
}

// -------------------- Persian date helper (very lightweight) --------------------
function toJalaliString(d) {
    // Accept both Date and dayjs objects
    const gy = typeof d.getFullYear === "function" ? d.getFullYear() : d.year();
    const gm = typeof d.getMonth === "function" ? d.getMonth() + 1 : d.month() + 1;
    const gd = typeof d.getDate === "function" ? d.getDate() : d.date();
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
// توابع readStore و writeStore از db.js می‌آیند

// -------------------- Reservation core (login/reserve) --------------------
let GLOBAL_CLIENT = null;  // Global client for session persistence

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
    return computeReserveDateFromISO(target.format("YYYY-MM-DD"));
}

function computeReserveDateFromISO(isoDate) {
    const target = dayjs(isoDate);
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
        timeout: 45000  // 45 seconds
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

// انتخاب صندلی بر اساس اولویت
function selectSeatByPriority(allSeats, priorityList) {

    // ابتدا صندلی‌های موجود رو فیلتر می‌کنیم
    const availableSeats = allSeats.filter(s => s.available);

    if (availableSeats.length === 0) {
        throw new Error("No seats available");
    }

    // در اولویت‌ها جستجو می‌کنیم
    for (const prioritySeatNum of priorityList) {
        const seat = availableSeats.find(s => s.number === prioritySeatNum);
        if (seat) {
            console.log(`[selectSeatByPriority] Selected seat ${seat.number} (in priority list)`);
            return seat;
        }
    }

    // اگر هیچ کدام از اولویت‌ها موجود نبود، اولین صندلی‌ موجود رو انتخاب می‌کنیم
    const selectedSeat = availableSeats[0];
    console.log(`[selectSeatByPriority] No priority seats available, selected seat ${selectedSeat.number}`);
    return selectedSeat;
}
function extractCsrfSeatAndUser(html, seatNumber) {
    const $ = cheerio.load(html);
    const token = $("input[name='__RequestVerificationToken']").val() || "";

    // تمام صندلی‌های موجود رو پیدا می‌کنیم
    const allSeats = [];
    $("div.block").each((i, el) => {
        const $seat = $(el);
        const seatText = $seat.text().trim();
        const seatId = $seat.attr("id");
        const classes = $seat.attr("class") || "";

        // بررسی وضعیت: اگر کلاس شامل "disable" یا "unavailable" باشه یعنی قفل شده
        const isAvailable = !classes.includes("reserve");
        if (seatText && seatId) {
            allSeats.push({
                number: parseInt(seatText, 10),
                id: seatId,
                available: isAvailable,
                classes: classes
            });
        }
    });

    if (!token) throw new Error("CSRF token not found");

    let userId = "";
    const scripts = $("script").map((i, el) => $(el).html() || "").get().join("\n");
    const m = scripts.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (m) userId = m[0];

    return {
        token,
        allSeats,  // همه صندلی‌ها رو هم برمی‌گردانیم برای اولویت‌بندی
        userId,
    };
}
async function reserveOnce(client, store, dateInfo, label, runId) {
    try {
        console.log(`[reserveOnce] Starting reservation for ${label}...`);
        emitProgress(runId, label, 1, 5, "درخواست صفحه پاپ‌آپ");
        const html = await openSeatPopupHTML(client, store, dateInfo, label);
        const { token, allSeats, userId } = extractCsrfSeatAndUser(html, store.seat_number);

        emitProgress(runId, label, 2, 5, "انتخاب صندلی بر اساس اولویت");

        // اولویت صندلی‌ها رو از store میگیریم (یا دفلت رو استفاده می‌کنیم)
        const seatPriority = store.seat_priority;
        const selectedSeat = selectSeatByPriority(allSeats, seatPriority);

        emitProgress(runId, label, 3, 5, `ارسال درخواست برای صندلی ${selectedSeat.number}`);

        const w = TIME_WINDOWS[label];
        const payload = new URLSearchParams({
            __RequestVerificationToken: token,
            Id: selectedSeat.id,
            date: dateInfo.fullDateString,
            SHour: String(w.start),
            THour: String(w.end),
            userId: userId || ""
        }).toString();

        console.log(`[reserveOnce] Posting reservation for seat ${selectedSeat.number}...`);
        const res = await client.post(`https://110129.samanpl.ir/Common/Portal/ReservesLibraryNew`, payload, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: "https://110129.samanpl.ir",
                Referer: `https://110129.samanpl.ir/Home/ReserveDetail`,
                Accept: "application/json,*/*"
            }
        });

        console.log(`[reserveOnce] Response:`, res.data);
        emitProgress(runId, label, 4, 5, res.data?.Message || "پاسخ دریافت شد");
        return res.data;
    } catch (e) {
        console.error(`[reserveOnce] Error for ${label}:`, e.message);
        emitProgress(runId, label, 5, 5, e.message || "خطا", "error");
        throw e;
    }
}
// Helper: run tasks (functions returning promises) with limited concurrency
async function runWithConcurrency(tasks, concurrency) {
    const results = new Array(tasks.length);
    let idx = 0;

    async function worker() {
        while (true) {
            const i = idx++;
            if (i >= tasks.length) return;
            try {
                results[i] = await tasks[i]();
            } catch (e) {
                results[i] = { error: e };
            }
        }
    }

    const workers = [];
    const n = Math.max(1, Math.min(concurrency, tasks.length));
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

async function reserveSeatFlow(store, labels, runId, dateInfoOverride = null) {
    // ensure global client exists
    if (!GLOBAL_CLIENT) GLOBAL_CLIENT = buildClient();

    // attempt login once (refresh client on failure)
    try {
        emitProgress(runId, "login", 0, 3, "شروع لاگین");
        await login(GLOBAL_CLIENT, store);
        emitProgress(runId, "login", 3, 3, "لاگین موفق", "done");
    } catch (e) {
        console.log("[reserveSeatFlow] Login failed, retrying with fresh client...");
        GLOBAL_CLIENT = buildClient();
        await login(GLOBAL_CLIENT, store);
        emitProgress(runId, "login", 3, 3, "لاگین مجدد موفق", "done");
    }

    const dateInfo = dateInfoOverride || computeReserveDate(store.reserveDateMode);

    // Concurrency and spread come from store (safe defaults in defaultStore)
    const concurrency = parseInt(store.concurrency || store.concurrency === 0 ? store.concurrency : store.concurrency) || store.concurrency || 3;
    const requestStartSpreadMs = parseInt(store.requestStartSpreadMs || store.requestStartSpreadMs === 0 ? store.requestStartSpreadMs : store.requestStartSpreadMs) || store.requestStartSpreadMs || 400;

    // Build task functions for each label
    const tasks = labels.map(label => {
        return async () => {
            // small randomized stagger before starting to avoid a single burst
            const startDelay = Math.floor(Math.random() * requestStartSpreadMs);
            await new Promise(r => setTimeout(r, startDelay));

            // basic retry strategy (1 retry) with small backoff
            const maxAttempts = 2;
            let attempt = 0;
            let lastError = null;
            while (attempt < maxAttempts) {
                attempt++;
                try {
                    const r = await reserveOnce(GLOBAL_CLIENT, store, dateInfo, label, runId);
                    return { label, success: !!r.Success, message: r.Message || "", raw: r };
                } catch (e) {
                    lastError = e;
                    // small backoff before retry
                    const backoff = 200 + attempt * 200 + Math.floor(Math.random() * 200);
                    await new Promise(r => setTimeout(r, backoff));
                }
            }
            // all attempts failed
            throw lastError || new Error("Unknown reservation error");
        };
    });

    // run with controlled concurrency
    const taskResults = await runWithConcurrency(tasks, concurrency);

    const results = [];
    for (const tr of taskResults) {
        if (tr && tr.error) {
            const err = tr.error;
            const windowLabel = err.label || "unknown";
            results.push({ label: windowLabel, success: false, message: err.message || String(err) });
            await logReservation({
                date: dateInfo.iso,
                window: windowLabel,
                status: "failed",
                message: "",
                error: err.message || String(err),
                timestamp: new Date().toISOString(),
                jalaliDate: toJalaliString(dayjs(dateInfo.iso))
            });
            emitProgress(runId, windowLabel, 5, 5, err.message || "خطا", "error");
        } else if (tr) {
            results.push({ label: tr.label, success: tr.success, message: tr.message });
            await logReservation({
                date: dateInfo.iso,
                window: tr.label || "unknown",
                status: tr.success ? "success" : "failed",
                message: tr.message || "",
                timestamp: new Date().toISOString(),
                jalaliDate: toJalaliString(dayjs(dateInfo.iso))
            });
            emitProgress(runId, tr.label || "unknown", 5, 5, tr.message || "پایان", tr.success ? "done" : "error");
        } else {
            results.push({ label: "unknown", success: false, message: "Unknown result" });
            emitProgress(runId, "unknown", 5, 5, "نتیجه نامشخص", "error");
        }
    }

    // optional: parse quota from messages
    const quotaMsg = results.find(x => x.success && /سهم|باقی مانده/.test(x.message));
    if (quotaMsg) {
        store.lastMonthQuota = quotaMsg.message;
        await writeStore(store);
    }

    return { dateInfo, results };
}

// -------------------- Scheduler (07:01 daily for selected day mode) --------------------
let schedulerTimer = null;
function scheduleDaily() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(async () => {
        const store = await readStore();
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
            await writeStore(store);
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
app.use(express.static("public"));

// Serve the index.html for root path
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// ==================== WebSocket Setup ====================
// Socket.io will be initialized after server starts
function initSocketIO(httpServer) {
    io = new Server(httpServer, {
        cors: { origin: "*", methods: ["GET", "POST"] }
    });

    io.on("connection", (socket) => {
        console.log(`[WebSocket] Client connected: ${socket.id}`);
        
        socket.on("disconnect", () => {
            console.log(`[WebSocket] Client disconnected: ${socket.id}`);
        });
    });

    return io;
}

// Get full config
app.get("/api/config", async (req, res) => {
    const st = await readStore();
    res.json({
        username: st.username,
        passwd: st.passwd,
        seat_number: st.seat_number,
        seat_priority: st.seat_priority || [33, 32, 34, 37, 42],
        concurrency: st.concurrency || 5,
        requestStartSpreadMs: st.requestStartSpreadMs || 400,
        sc: st.sc,
        reserveDateMode: st.reserveDateMode,
        selectedWindows: st.selectedWindows || [],
        scheduledDays: st.scheduledDays || {},
        lastMonthQuota: st.lastMonthQuota || null
    });
});

// Update main config (seat_number, seat_priority, reserveDateMode, selectedWindows)
app.post("/api/config", async (req, res) => {
    const st = await readStore();
    const { seat_number, seat_priority, reserveDateMode, selectedWindows, concurrency, requestStartSpreadMs } = req.body || {};

    if (seat_number) st.seat_number = parseInt(seat_number, 10);
    if (Array.isArray(seat_priority)) st.seat_priority = seat_priority.map(s => parseInt(s, 10));
    if (typeof concurrency !== 'undefined') st.concurrency = parseInt(concurrency, 10) || st.concurrency;
    if (typeof requestStartSpreadMs !== 'undefined') st.requestStartSpreadMs = parseInt(requestStartSpreadMs, 10) || st.requestStartSpreadMs;
    if (reserveDateMode && ["today", "tomorrow"].includes(reserveDateMode)) st.reserveDateMode = reserveDateMode;
    if (Array.isArray(selectedWindows)) st.selectedWindows = selectedWindows.filter(w => TIME_WINDOWS[w]);

    await writeStore(st);
    res.json({ ok: true });
});

// Update advanced settings (username, password, sc, etc)
app.post("/api/settings", async (req, res) => {
    const st = await readStore();
    const { username, passwd, seat_number, seat_priority, sc, reserveDateMode, concurrency, requestStartSpreadMs } = req.body || {};

    if (username) st.username = username;
    if (passwd) st.passwd = passwd;
    if (seat_number) st.seat_number = parseInt(seat_number, 10);
    if (Array.isArray(seat_priority)) st.seat_priority = seat_priority.map(s => parseInt(s, 10));
    if (typeof concurrency !== 'undefined') st.concurrency = parseInt(concurrency, 10) || st.concurrency;
    if (typeof requestStartSpreadMs !== 'undefined') st.requestStartSpreadMs = parseInt(requestStartSpreadMs, 10) || st.requestStartSpreadMs;
    if (sc) st.sc = sc;
    if (reserveDateMode && ["today", "tomorrow"].includes(reserveDateMode)) st.reserveDateMode = reserveDateMode;

    await writeStore(st);
    res.json({ ok: true });
});

// Schedule a specific day with windows
app.post("/api/schedule-day", async (req, res) => {
    const st = await readStore();
    const { date, windows } = req.body || {};

    if (!date) return res.status(400).json({ ok: false, error: "date required" });

    if (!Array.isArray(windows) || windows.length === 0) {
        // Delete if empty
        delete st.scheduledDays[date];
    } else {
        const validWindows = windows.filter(w => TIME_WINDOWS[w]);
        st.scheduledDays[date] = validWindows;
        
        // Log scheduled status for each window
        for (const w of validWindows) {
            await logReservation({
                date: date,
                window: w,
                status: "scheduled",
                message: "تایم‌بندی شده برای اجرای خودکار",
                timestamp: new Date().toISOString(),
                jalaliDate: toJalaliString(new Date(date))
            });
        }
    }

    await writeStore(st);
    res.json({ ok: true });
});

// Reserve immediately for selected windows (or provided windows)
app.post("/api/reserve", async (req, res) => {
    try {
        const st = await readStore();
        const windows = Array.isArray(req.body.windows) ? req.body.windows.filter(w => TIME_WINDOWS[w]) : (st.selectedWindows || []);
        if (!windows.length) return res.status(400).json({ ok: false, error: "No windows selected" });
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
        
        // ارسال شروع رزرو به کلاینت‌ها
        if (io) io.emit("reserve:start", { runId, date: new Date().toISOString(), windows });
        
        const { results, dateInfo } = await reserveSeatFlow(st, windows, runId);
        
        // ارسال نتایج
        if (io) io.emit("reserve:complete", { runId, dateInfo, results });
        
        // Mark scheduledDays for the date
        const key = dateInfo.iso;
        st.scheduledDays[key] = windows;
        await writeStore(st);
        res.json({ ok: true, runId, date: dateInfo, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Get reservation history
app.get("/api/history", async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = await getHistory(limit);
    res.json({ ok: true, entries: history });
});

// Get history for a specific date
app.get("/api/history/:date", async (req, res) => {
    const { date } = req.params;
    const history = await getHistoryByDate(date);
    res.json({ ok: true, entries: history });
});

// Test/Gamble reserve (شنگول بازی) - بدون توجه به محدودیت‌های زمانی
app.post("/api/test-reserve", async (req, res) => {
    try {
        const st = await readStore();
        const { date, windows } = req.body || {};
        
        if (!date || !Array.isArray(windows) || windows.length === 0) {
            return res.status(400).json({ ok: false, error: "date and windows required" });
        }
        const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
        
        // اطلاع به کلاینت‌ها (شنگول بازی شروع شد)
        if (io) io.emit("test-reserve:start", { runId, date, windows });
        const dateInfo = computeReserveDateFromISO(date);
        const { results, dateInfo: usedDateInfo } = await reserveSeatFlow(st, windows, runId, dateInfo);

        if (io) io.emit("test-reserve:complete", { runId, dateInfo: usedDateInfo, results });
        res.json({ ok: true, runId, date, results });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Start
const port = process.env.PORT || 3000;
const http = require('http');

// Initialize database and start server
(async () => {
    try {
        await initDatabase();
        console.log('[DB] Database initialized');
        
        // ایجاد HTTP server برای Socket.io
        const httpServer = http.createServer(app);
        initSocketIO(httpServer);
        
        // شروع task scheduler
        const scheduler = startScheduler(
            null,
            reserveSeatFlow,
            readStore,
            writeStore,
            logReservation
        );
        console.log('[Scheduler] Task scheduler started');
        
        httpServer.listen(port, () => console.log(`Anti-Kokh listening on http://localhost:${port}`));
    } catch (error) {
        console.error('[DB] Failed to start:', error.message);
        process.exit(1);
    }
})();
