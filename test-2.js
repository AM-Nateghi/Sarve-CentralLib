// Install:
// npm install express axios tough-cookie axios-cookiejar-support cheerio dayjs cors

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const dayjs = require("dayjs");

// ---------- Global config ----------
const CONFIG = {
    username: process.env.SAMAN_USER || "0928731571",
    passwd: process.env.SAMAN_PASS || "AmN!@#27",
    seat_number: parseInt(process.env.SEAT_NUMBER || "33", 10),
    // sc is the session code (same as ps value seen in URLs)
    sc: process.env.SAMAN_SC || "ktDKKeFZe5lkOhWTITfdmQ==",
    reserveDateMode: process.env.RESERVE_DATE_MODE || "today", // "today" | "tomorrow"
    baseUrl: "https://110129.samanpl.ir",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
};

// Time windows map (label -> startHour, endHour)
const TIME_WINDOWS = {
    "8-11": { start: 8, end: 11 },
    "11-14": { start: 11, end: 14 },
    "14-17": { start: 14, end: 17 },
    "17-20": { start: 17, end: 20 },
    "20-21": { start: 20, end: 21 }
};

// ---------- Utilities ----------
function computeReserveDate(mode = CONFIG.reserveDateMode) {
    const now = dayjs();
    const target = mode === "tomorrow" ? now.add(1, "day") : now;
    // Server expects US-style string in the payload (e.g., "11/26/2025 12:00:00 AM")
    // We’ll format month/day/year and stick 12:00:00 AM to match page behavior.
    const mm = String(target.month() + 1).padStart(2, "0");
    const dd = String(target.date()).padStart(2, "0");
    const yyyy = String(target.year());
    return {
        slashDate: `${mm}/${dd}/${yyyy}`,                 // e.g., "11/26/2025"
        fullDateString: `${mm}/${dd}/${yyyy} 12:00:00 AM`,// e.g., "11/26/2025 12:00:00 AM"
        year: yyyy,
        month: mm
    };
}

function buildClient() {
    const jar = new tough.CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));
    client.defaults.headers.common["User-Agent"] = CONFIG.userAgent;
    return { client, jar };
}

// ---------- Core steps ----------
async function login(client) {
    // Prime session
    await client.get(`${CONFIG.baseUrl}/Account/Login`, {
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    });

    // Perform login (302 expected)
    const res = await client.post(
        `${CONFIG.baseUrl}/Account/Login`,
        new URLSearchParams({
            returnUrl: `/Home/ReserveService?ps=${CONFIG.sc}`,
            UserName: CONFIG.username,
            Password: CONFIG.passwd
        }),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: CONFIG.baseUrl,
                Referer: `${CONFIG.baseUrl}/Account/Login/?returnUrl=%2fHome%2fReserveService%3fps%3d${encodeURIComponent(CONFIG.sc)}`,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400
        }
    );

    const location = res.headers.location || `/Home/ReserveService?ps=${CONFIG.sc}`;
    await client.get(`${CONFIG.baseUrl}${location}`, {
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    });

    return true;
}

async function fetchTimeButtonsHTML(client, slashDate) {
    // POST /Home/GetHoursNew?SC=...&&d=YYYY/MM/DD
    const url = `${CONFIG.baseUrl}/Home/GetHoursNew?SC=${encodeURIComponent(CONFIG.sc)}&&d=${slashDate}`;
    const res = await client.post(url, null, {
        headers: {
            Origin: CONFIG.baseUrl,
            Referer: `${CONFIG.baseUrl}/Home/ReserveService?ps=${CONFIG.sc}`,
            "X-Requested-With": "XMLHttpRequest",
            Accept: "*/*"
        }
    });
    return res.data; // HTML with <button id="17">20-17</button>, etc.
}

async function openSeatPopupHTML(client, dateInfo, timeLabel) {
    const w = TIME_WINDOWS[timeLabel];
    if (!w) throw new Error(`Unknown time window: ${timeLabel}`);

    const payload = new URLSearchParams({
        sc: CONFIG.sc,
        Sdate: dateInfo.fullDateString,
        Shour: String(w.start),
        Thour: String(w.end),
        year: dateInfo.year,
        month: dateInfo.month
    });

    const res = await client.post(`${CONFIG.baseUrl}/Home/ReserveDetail`, payload, {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: CONFIG.baseUrl,
            Referer: `${CONFIG.baseUrl}/Home/ReserveService?ps=${CONFIG.sc}`,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
    });

    return { html: res.data, window: w, dateInfo };
}

function extractCsrfAndSeatId(html, desiredSeatNumber = CONFIG.seat_number) {
    const $ = cheerio.load(html);
    const token = $("input[name='__RequestVerificationToken']").val() || "";

    // Find seat by visible number text
    const seatDiv = $("div.block").filter((i, el) => $(el).text().trim() === String(desiredSeatNumber)).first();
    const seatId = seatDiv.attr("id");

    if (!token) throw new Error("CSRF token not found in popup HTML");
    if (!seatId) throw new Error(`Seat ${desiredSeatNumber} not found in popup HTML`);

    // Try extracting userId if embedded
    // In many pages it’s in script; if not found, you may need to fetch it server-side elsewhere.
    let userId = "";
    const scriptText = $("script").map((i, el) => $(el).html() || "").get().join("\n");
    const guidMatch =
        scriptText.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (guidMatch) userId = guidMatch[0];

    return { token, seatId, userId };
}

async function reserveSeat(client, token, seatId, dateInfo, window, userId) {
    // POST /Common/Portal/ReservesLibraryNew
    const payload = new URLSearchParams({
        __RequestVerificationToken: token,
        Id: seatId,
        date: dateInfo.fullDateString,
        SHour: String(window.start),
        THour: String(window.end),
        userId: userId
    });

    const res = await client.post(`${CONFIG.baseUrl}/Common/Portal/ReservesLibraryNew`, payload, {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: CONFIG.baseUrl,
            Referer: `${CONFIG.baseUrl}/Home/ReserveDetail`,
            Accept: "application/json,*/*"
        }
    });

    return res.data; // { Success: boolean, Message: string }
}

// ---------- Orchestrator ----------
async function reserveSeatFlow({ timeLabel }) {
    const { client } = buildClient();

    await login(client);

    const dateInfo = computeReserveDate(CONFIG.reserveDateMode);

    // Optional: you can call GetHoursNew if you want to validate time availability first
    await fetchTimeButtonsHTML(client, dateInfo.slashDate);

    const { html } = await openSeatPopupHTML(client, dateInfo, timeLabel);
    const { token, seatId, userId } = extractCsrfAndSeatId(html, CONFIG.seat_number);

    // If userId wasn’t found, you may set it via env/config (GUID from page if known)
    const finalUserId = userId || (process.env.SAMAN_USER_ID || "");
    if (!finalUserId) {
        throw new Error("userId was not found. Set SAMAN_USER_ID env or extract it from page script.");
    }

    const result = await reserveSeat(client, token, seatId, dateInfo, TIME_WINDOWS[timeLabel], finalUserId);
    return { result, seatId, seatNumber: CONFIG.seat_number, timeLabel, date: dateInfo.fullDateString };
}

// ---------- Express API ----------
const app = express();
app.use(cors());
app.use(express.json());

// GET config
app.get("/config", (req, res) => {
    res.json({
        username: CONFIG.username,
        seat_number: CONFIG.seat_number,
        reserveDateMode: CONFIG.reserveDateMode,
        timeWindows: Object.keys(TIME_WINDOWS),
        sc: CONFIG.sc
    });
});

// POST /login (optional sanity check)
app.post("/login", async (req, res) => {
    try {
        const { client } = buildClient();
        await login(client);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /reserve
// body: { timeLabel: "17-20" } one of: "8-11","11-14","14-17","17-20","20-21"
app.post("/reserve", async (req, res) => {
    try {
        const timeLabel = req.body.timeLabel || "17-20";
        if (!TIME_WINDOWS[timeLabel]) {
            return res.status(400).json({ ok: false, error: "Invalid timeLabel" });
        }
        const data = await reserveSeatFlow({ timeLabel });
        res.json({ ok: true, ...data });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Local run
if (require.main === module) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Server listening on ${port}`));
}

module.exports = { app, reserveSeat: reserveSeatFlow };
