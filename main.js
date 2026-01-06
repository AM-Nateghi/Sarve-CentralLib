// server.js
// Install: npm install express cors body-parser dayjs fs axios tough-cookie axios-cookiejar-support cheerio node-cron mysql2 dotenv bcryptjs cookie-parser
// Run: node server.js

// Load .env
const dotenv = require("dotenv");
dotenv.config();

console.log(`[Main] NODE_ENV: "${process.env.NODE_ENV}"`);

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const dayjs = require("dayjs");
const axios = require("axios");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const bcrypt = require("bcryptjs");
const {
    initDatabase, logReservation, getHistory, getHistoryByDate, readStore, writeStore,
    createUser, getUserByUsername, getUserById, getAllUsers, updateUserStatus, deleteUser,
    createUserConfig, getUserConfig, updateUserConfig, getAllUsersWithConfigs, getHistoryForUser
} = require("./db");
const { startScheduler } = require("./scheduler");
const { Server } = require("socket.io");

// Global WebSocket instance
let io = null;

// ==================== Avanak Voice Notification ====================
async function sendAvanakCall(phoneNumber) {
    const token = process.env.AVANAK_TOKEN;
    const messageId = process.env.AVANAK_MESSAGE_ID;

    if (!token || !messageId || token === 'your_avanak_token_here') {
        console.warn('[Avanak] Credentials not set. Skipping call.');
        return;
    }

    try {
        console.log(`[Avanak] Sending voice call alert to ${phoneNumber}...`);

        // طبق مستندات Avanak باید از URLSearchParams استفاده کنیم
        const response = await axios.post(
            'https://portal.avanak.ir/rest/QuickSend',
            new URLSearchParams({
                MessageID: messageId,
                Number: phoneNumber,
                Vote: 'false',
                ServerID: '0'
            }),
            {
                headers: {
                    'Authorization': token,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        // بررسی QuickSendID که اگر بزرگتر از 0 باشد یعنی موفق بوده
        if (response.data && response.data.QuickSendID > 0) {
            console.log(`[Avanak] ✅ Call scheduled successfully! QuickSendID: ${response.data.QuickSendID}`);
        } else if (response.data && response.data.ReturnValue !== undefined) {
            // برخی نسخه‌های API ممکن است ReturnValue برگردانند
            if (response.data.ReturnValue > 0) {
                console.log(`[Avanak] ✅ Call scheduled successfully! ID: ${response.data.ReturnValue}`);
            } else {
                console.error(`[Avanak] ❌ Failed to schedule call. Error code: ${response.data.ReturnValue}`, response.data);
            }
        } else {
            console.error(`[Avanak] ❌ Unexpected response:`, response.data);
        }
    } catch (error) {
        console.error(`[Avanak] ❌ API Error:`, error.response?.data || error.message);
    }
}
let ADMIN_PASSWORD_CACHED = null;

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

async function reserveSeatFlow(store, labels, runId, dateInfoOverride = null, userId = null, username = null) {
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
        try {
            await login(GLOBAL_CLIENT, store);
            emitProgress(runId, "login", 3, 3, "لاگین مجدد موفق", "done");
        } catch (e2) {
            emitProgress(runId, "login", 0, 3, `خطا در لاگین: ${e2.message}`, "error");
            throw e2;
        }
    }

    const dateInfo = dateInfoOverride || computeReserveDate(store.reserveDateMode);

    // Concurrency and spread come from store (safe defaults in defaultStore)
    const concurrency = parseInt(store.concurrency || store.concurrency === 0 ? store.concurrency : store.concurrency) || store.concurrency || 3;
    const requestStartSpreadMs = parseInt(store.requestStartSpreadMs || store.requestStartSpreadMs === 0 ? store.requestStartSpreadMs : store.requestStartSpreadMs) || store.requestStartSpreadMs || 400;

    // Build task functions for each label
    const tasks = labels.map(label => {
        return async () => {
            // Check if already reserved in this session/run to avoid duplicates
            // This is a basic session-level check

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

                    if (r && r.Success) {
                        return { label, success: true, message: r.Message || "رزرو موفق", raw: r };
                    } else {
                        // If API returned Success: false but no error was thrown
                        return { label, success: false, message: r?.Message || "پاسخ ناموفق از سامانه", raw: r };
                    }
                } catch (e) {
                    lastError = e;
                    console.error(`[reserveSeatFlow] Attempt ${attempt} failed for ${label}:`, e.message);
                    // small backoff before retry
                    const backoff = 500 + attempt * 500 + Math.floor(Math.random() * 500);
                    await new Promise(r => setTimeout(r, backoff));
                }
            }
            // all attempts failed
            throw lastError || new Error("خطای ناشناخته در فرآیند رزرو");
        };
    });

    // run with controlled concurrency
    const taskResults = await runWithConcurrency(tasks, concurrency);

    const results = [];
    let anyFailure = false;

    for (const tr of taskResults) {
        if (tr && tr.error) {
            anyFailure = true;
            const err = tr.error;
            const windowLabel = err.label || "unknown";
            results.push({ label: windowLabel, success: false, message: err.message || String(err) });
            await logReservation({
                user_id: userId,
                username: username,
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
            if (!tr.success) anyFailure = true;
            results.push({ label: tr.label, success: tr.success, message: tr.message });
            await logReservation({
                user_id: userId,
                username: username,
                date: dateInfo.iso,
                window: tr.label || "unknown",
                status: tr.success ? "success" : "failed",
                message: tr.message || "",
                timestamp: new Date().toISOString(),
                jalaliDate: toJalaliString(dayjs(dateInfo.iso))
            });
            emitProgress(runId, tr.label || "unknown", 5, 5, tr.message || "پایان", tr.success ? "done" : "error");
        } else {
            anyFailure = true;
            results.push({ label: "unknown", success: false, message: "Unknown result" });
            emitProgress(runId, "unknown", 5, 5, "نتیجه نامشخص", "error");
        }
    }

    // Trigger Avanak Call if enabled and any failed
    if (anyFailure && store.call_on_failure && store.phone_number) {
        console.log(`[reserveSeatFlow] Failures detected. Triggering Avanak call for ${username}...`);
        sendAvanakCall(store.phone_number).catch(e => console.error('[reserveSeatFlow] Avanak call failed:', e.message));
    }

    return { dateInfo, results };
}

// -------------------- Scheduler (new unified scheduler in scheduler.js is used) --------------------
// Legacy inline scheduler removed to prevent duplicate executions.

// No embedded HTML - serving from public/index.html now

// -------------------- Express API --------------------
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());

// ==================== Middleware ====================

// چک کردن دسترسی سراسری (برای صفحات و فایل‌های استاتیک)
app.use(async (req, res, next) => {
    // مسیرهای عمومی
    const publicPaths = ['/signin', '/admin', '/style.css', '/manifest.json'];
    const isPublicApi = req.path.startsWith('/api/auth/') || req.path.startsWith('/api/admin/') || req.path === '/health';

    if (publicPaths.includes(req.path) || isPublicApi) {
        return next();
    }

    // بررسی کوکی
    const userId = req.cookies.userId;
    const sessionToken = req.cookies.sessionToken;

    if (!userId || !sessionToken) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ ok: false, error: "Not authenticated" });
        }
        return res.redirect('/signin');
    }

    // تایید کاربر از دیتابیس (برای اطمینان از وضعیت approved)
    const user = await getUserById(userId);
    if (!user || user.status !== 'approved') {
        res.clearCookie('userId');
        res.clearCookie('sessionToken');
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ ok: false, error: "User not approved" });
        }
        return res.redirect('/signin');
    }

    req.userId = userId;
    req.username = user.username;
    next();
});

// Serve static files from public folder
app.use(express.static("public"));

// Auth Middleware - برای استفاده در APIها (حالا فقط چک می‌کند که req.userId ست شده باشد)
async function authMiddleware(req, res, next) {
    if (!req.userId) {
        return res.status(401).json({ ok: false, error: "Not authenticated" });
    }
    next();
}

// Admin Auth Middleware - بررسی رمز عبور ادمین
function adminAuthMiddleware(req, res, next) {
    const adminToken = req.cookies.adminToken;

    if (!adminToken || adminToken !== 'admin_verified') {
        return res.status(401).json({ ok: false, error: "Admin not authenticated" });
    }

    next();
}

// مسیرهای صفحات اصلی
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.get("/admin", (req, res) => {
    res.sendFile(__dirname + "/public/admin.html");
});

app.get("/signin", (req, res) => {
    res.sendFile(__dirname + "/public/signin.html");
});

// ==================== Auth Endpoints ====================
// Sign Up
app.post("/api/auth/signup", async (req, res) => {
    try {
        const { username, password, phone_number, sc, seat_priority } = req.body;

        // Validation
        if (!username || !password || !phone_number || !sc || !Array.isArray(seat_priority) || seat_priority.length === 0) {
            return res.status(400).json({ ok: false, error: "Missing required fields" });
        }

        // Check if user exists
        const existingUser = await getUserByUsername(username);
        if (existingUser) {
            return res.status(400).json({ ok: false, error: "User already exists" });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Create user
        const userId = await createUser(username, passwordHash, phone_number);

        // Create user config
        await createUserConfig(userId, {
            seat_priority,
            sc,
            sampl_password: password, // Store original password for library login
            concurrency: 3,
            requestStartSpreadMs: 400,
            reserveDateMode: 'tomorrow',
            call_on_failure: false,
            selectedWindows: [],
            scheduledDays: {},
            customSchedules: [],
            lastMonthQuota: null
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('[Auth] Sign up error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Sign In
app.post("/api/auth/signin", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ ok: false, error: "Username and password required" });
        }

        // Get user from database
        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }

        // Check status
        if (user.status !== 'approved') {
            return res.status(401).json({ ok: false, error: "User not approved yet" });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }

        // Set 7-day cookie
        const expiresIn = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
        const sessionToken = `token_${user.id}_${Date.now()}`;

        res.cookie('userId', user.id, {
            httpOnly: true,
            maxAge: expiresIn,
            sameSite: 'lax'
        });

        res.cookie('sessionToken', sessionToken, {
            httpOnly: true,
            maxAge: expiresIn,
            sameSite: 'lax'
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('[Auth] Sign in error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Sign Out
app.post("/api/auth/signout", (req, res) => {
    res.clearCookie('userId');
    res.clearCookie('sessionToken');
    res.json({ ok: true });
});

// ==================== Admin Endpoints ====================
// Admin Verify (read .env on each request for admin password)
app.post("/api/admin/verify", (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ ok: false, error: "Password required" });
        }

        // Read from .env on each request
        const envAdminPassword = process.env.ADMIN_PASSWORD;

        if (password !== envAdminPassword) {
            return res.status(401).json({ ok: false, error: "Invalid password" });
        }

        // Set 30-minute admin cookie
        const expiresIn = 30 * 60 * 1000; // 30 minutes in ms

        res.cookie('adminToken', 'admin_verified', {
            httpOnly: true,
            maxAge: expiresIn,
            sameSite: 'lax'
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('[Admin] Verify error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Get all users (with optional status filter)
app.get("/api/admin/users", adminAuthMiddleware, async (req, res) => {
    try {
        const status = req.query.status || null;
        const users = await getAllUsers(status);
        res.json({ ok: true, users });
    } catch (error) {
        console.error('[Admin] Get users error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Update user status
app.post("/api/admin/users/:userId/status", adminAuthMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { status } = req.body;

        if (!['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ ok: false, error: "Invalid status" });
        }

        await updateUserStatus(userId, status);
        res.json({ ok: true });
    } catch (error) {
        console.error('[Admin] Update user status error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Delete user
app.delete("/api/admin/users/:userId", adminAuthMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        await deleteUser(userId);
        res.json({ ok: true });
    } catch (error) {
        console.error('[Admin] Delete user error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ==================== WebSocket Setup ====================
// Socket.io will be initialized after server starts
function initSocketIO(httpServer) {
    io = new Server(httpServer, {
        cors: { origin: "*", methods: ["GET", "POST"] }
    });

    // Middleware برای احراز هویت وب‌ساکت
    io.use(async (socket, next) => {
        try {
            const cookieStr = socket.handshake.headers.cookie || "";
            const cookies = {};
            cookieStr.split(';').forEach(c => {
                const parts = c.trim().split('=');
                if (parts.length === 2) cookies[parts[0]] = parts[1];
            });

            const userId = cookies.userId;
            if (!userId) return next(new Error("unauthorized"));

            const user = await getUserById(userId);
            if (!user || user.status !== 'approved') {
                return next(new Error("unauthorized"));
            }

            socket.userId = userId;
            socket.username = user.username;
            next();
        } catch (err) {
            next(new Error("auth_error"));
        }
    });

    io.on("connection", (socket) => {
        console.log(`[WebSocket] Client connected: ${socket.id} (User: ${socket.username})`);

        socket.on("disconnect", () => {
            console.log(`[WebSocket] Client disconnected: ${socket.id}`);
        });
    });

    return io;
}

// Get full config (per user)
app.get("/api/config", authMiddleware, async (req, res) => {
    try {
        const user = await getUserById(req.userId);
        const userConfig = await getUserConfig(req.userId);
        if (!user || !userConfig) {
            return res.status(404).json({ ok: false, error: "User or config not found" });
        }

        res.json({
            username: req.username, // Include username for display
            phone_number: user.phone_number || '',
            seat_priority: userConfig.seat_priority || [33, 32, 34, 37, 42],
            concurrency: userConfig.concurrency || 3,
            requestStartSpreadMs: userConfig.requestStartSpreadMs || 400,
            sc: userConfig.sc,
            sampl_password: userConfig.sampl_password || '',
            reserveDateMode: userConfig.reserveDateMode,
            call_on_failure: userConfig.call_on_failure || false,
            selectedWindows: userConfig.selectedWindows || [],
            scheduledDays: userConfig.scheduledDays || {},
            customSchedules: userConfig.customSchedules || [],
            lastMonthQuota: userConfig.lastMonthQuota || null
        });
    } catch (error) {
        console.error('[API] Get config error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Update main config (seat_priority, reserveDateMode, selectedWindows)
app.post("/api/config", authMiddleware, async (req, res) => {
    try {
        const userConfig = await getUserConfig(req.userId);
        if (!userConfig) {
            return res.status(404).json({ ok: false, error: "User config not found" });
        }

        const { seat_priority, reserveDateMode, selectedWindows, concurrency, requestStartSpreadMs } = req.body || {};

        if (Array.isArray(seat_priority)) userConfig.seat_priority = seat_priority.map(s => parseInt(s, 10));
        if (typeof concurrency !== 'undefined') userConfig.concurrency = parseInt(concurrency, 10) || userConfig.concurrency;
        if (typeof requestStartSpreadMs !== 'undefined') userConfig.requestStartSpreadMs = parseInt(requestStartSpreadMs, 10) || userConfig.requestStartSpreadMs;
        if (reserveDateMode && ["today", "tomorrow"].includes(reserveDateMode)) userConfig.reserveDateMode = reserveDateMode;
        if (Array.isArray(selectedWindows)) userConfig.selectedWindows = selectedWindows.filter(w => TIME_WINDOWS[w]);

        await updateUserConfig(req.userId, userConfig);
        res.json({ ok: true });
    } catch (error) {
        console.error('[API] Update config error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Update advanced settings (sc, etc)
app.post("/api/settings", authMiddleware, async (req, res) => {
    try {
        const userConfig = await getUserConfig(req.userId);
        if (!userConfig) {
            return res.status(404).json({ ok: false, error: "User config not found" });
        }

        const { sc, seat_priority, reserveDateMode, concurrency, requestStartSpreadMs, call_on_failure } = req.body || {};

        if (sc) userConfig.sc = sc;
        if (Array.isArray(seat_priority)) userConfig.seat_priority = seat_priority.map(s => parseInt(s, 10));
        if (typeof concurrency !== 'undefined') userConfig.concurrency = parseInt(concurrency, 10) || userConfig.concurrency;
        if (typeof requestStartSpreadMs !== 'undefined') userConfig.requestStartSpreadMs = parseInt(requestStartSpreadMs, 10) || userConfig.requestStartSpreadMs;
        if (reserveDateMode && ["today", "tomorrow"].includes(reserveDateMode)) userConfig.reserveDateMode = reserveDateMode;
        if (typeof call_on_failure !== 'undefined') userConfig.call_on_failure = !!call_on_failure;

        await updateUserConfig(req.userId, userConfig);
        res.json({ ok: true });
    } catch (error) {
        console.error('[API] Update settings error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Schedule a specific day with windows
app.post("/api/schedule-day", authMiddleware, async (req, res) => {
    try {
        const userConfig = await getUserConfig(req.userId);
        if (!userConfig) {
            return res.status(404).json({ ok: false, error: "User config not found" });
        }

        const { date, windows } = req.body || {};

        if (!date) return res.status(400).json({ ok: false, error: "date required" });

        if (!Array.isArray(windows) || windows.length === 0) {
            delete userConfig.scheduledDays[date];
        } else {
            const validWindows = windows.filter(w => TIME_WINDOWS[w]);
            userConfig.scheduledDays[date] = validWindows;

            // Log scheduled status for each window
            for (const w of validWindows) {
                await logReservation({
                    user_id: req.userId,
                    username: req.username,
                    date: date,
                    window: w,
                    status: "scheduled",
                    message: "زمان‌بندی شده برای اجرای خودکار",
                    timestamp: new Date().toISOString(),
                    jalaliDate: toJalaliString(new Date(date))
                });
            }
        }

        await updateUserConfig(req.userId, userConfig);
        res.json({ ok: true });
    } catch (error) {
        console.error('[API] Schedule day error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Reserve immediately for selected windows
app.post("/api/reserve", authMiddleware, async (req, res) => {
    try {
        const user = await getUserById(req.userId);
        const userConfig = await getUserConfig(req.userId);
        if (!user || !userConfig) {
            return res.status(404).json({ ok: false, error: "User or config not found" });
        }

        const windows = Array.isArray(req.body.windows) ? req.body.windows.filter(w => TIME_WINDOWS[w]) : (userConfig.selectedWindows || []);
        if (!windows.length) return res.status(400).json({ ok: false, error: "No windows selected" });

        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        // ارسال شروع رزرو به کلاینت‌ها
        if (io) io.emit("reserve:start", { runId, date: new Date().toISOString(), windows });

        // Prepare store object from user config for reserveSeatFlow
        const storeForReserve = {
            username: req.username,
            passwd: userConfig.sampl_password || "",
            seat_priority: userConfig.seat_priority,
            concurrency: userConfig.concurrency,
            requestStartSpreadMs: userConfig.requestStartSpreadMs,
            sc: userConfig.sc,
            reserveDateMode: userConfig.reserveDateMode,
            call_on_failure: !!userConfig.call_on_failure,
            phone_number: user.phone_number,
            selectedWindows: windows
        };

        const { results, dateInfo } = await reserveSeatFlow(storeForReserve, windows, runId, null, req.userId, req.username);

        // ارسال نتایج
        if (io) io.emit("reserve:complete", { runId, dateInfo, results });

        // Mark scheduledDays for the date
        const key = dateInfo.iso;
        userConfig.scheduledDays[key] = windows;
        await updateUserConfig(req.userId, userConfig);
        res.json({ ok: true, runId, date: dateInfo, results });
    } catch (error) {
        console.error('[API] Reserve error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Get reservation history (user specific)
app.get("/api/history", authMiddleware, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = await getHistoryForUser(req.userId, limit);
        res.json({ ok: true, entries: history });
    } catch (error) {
        console.error('[API] Get history error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Get history for a specific date
app.get("/api/history/:date", authMiddleware, async (req, res) => {
    try {
        const { date } = req.params;
        const history = await getHistoryByDate(date);
        res.json({ ok: true, entries: history });
    } catch (error) {
        console.error('[API] Get history by date error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Custom schedule with execution date and time
app.post("/api/custom-schedule", authMiddleware, async (req, res) => {
    try {
        const userConfig = await getUserConfig(req.userId);
        if (!userConfig) {
            return res.status(404).json({ ok: false, error: "User config not found" });
        }

        const { reserveDate, windows, executionDate, executionHour, executionMinute } = req.body || {};

        if (!reserveDate || !Array.isArray(windows) || windows.length === 0) {
            return res.status(400).json({ ok: false, error: "reserveDate and windows required" });
        }

        if (!executionDate || typeof executionHour !== 'number' || typeof executionMinute !== 'number') {
            return res.status(400).json({ ok: false, error: "executionDate, executionHour, and executionMinute required" });
        }

        // Validate executionHour and executionMinute
        if (executionHour < 0 || executionHour > 23 || executionMinute < 0 || executionMinute > 59) {
            return res.status(400).json({ ok: false, error: "Invalid time values" });
        }

        // Store the custom schedule
        if (!userConfig.customSchedules) userConfig.customSchedules = [];

        const scheduleId = `cs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const schedule = {
            id: scheduleId,
            reserveDate: reserveDate,
            windows: windows.filter(w => TIME_WINDOWS[w]),
            executionDate: executionDate,
            executionHour: executionHour,
            executionMinute: executionMinute,
            created: new Date().toISOString(),
            executed: false
        };

        userConfig.customSchedules.push(schedule);
        await updateUserConfig(req.userId, userConfig);

        // Log for each window
        for (const w of schedule.windows) {
            await logReservation({
                user_id: req.userId,
                username: req.username,
                date: reserveDate,
                window: w,
                status: "scheduled",
                message: `زمان‌بندی دلخواه برای ${executionDate} ساعت ${String(executionHour).padStart(2, '0')}:${String(executionMinute).padStart(2, '0')}`,
                timestamp: new Date().toISOString(),
                jalaliDate: toJalaliString(new Date(reserveDate))
            });
        }

        res.json({ ok: true, scheduleId });
    } catch (error) {
        console.error('[API] Custom schedule error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Delete custom schedule
app.delete("/api/custom-schedule/:id", authMiddleware, async (req, res) => {
    try {
        const userConfig = await getUserConfig(req.userId);
        if (!userConfig) {
            return res.status(404).json({ ok: false, error: "User config not found" });
        }

        if (!userConfig.customSchedules) userConfig.customSchedules = [];

        const index = userConfig.customSchedules.findIndex(s => s.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ ok: false, error: "Schedule not found" });
        }

        userConfig.customSchedules.splice(index, 1);
        await updateUserConfig(req.userId, userConfig);

        res.json({ ok: true });
    } catch (error) {
        console.error('[API] Delete custom schedule error:', error.message);
        res.status(500).json({ ok: false, error: error.message });
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
            getAllUsersWithConfigs,
            updateUserConfig,
            logReservation
        );
        console.log('[Scheduler] Task scheduler started');

        httpServer.listen(port, () => console.log(`Anti-Kokh listening on http://localhost:${port}`));
    } catch (error) {
        console.error('[DB] Failed to start:', error.message);
        process.exit(1);
    }
})();
