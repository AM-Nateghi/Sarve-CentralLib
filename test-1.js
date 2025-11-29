// نصب پکیج‌ها:
// npm install axios tough-cookie axios-cookiejar-support cheerio

const axios = require("axios");
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");

async function reserveSeat33() {
    const jar = new tough.CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    try {
        // مرحله 1: گرفتن صفحه لاگین برای ست شدن SessionId
        await client.get("https://110129.samanpl.ir/Account/Login", {
            headers: { "User-Agent": "Mozilla/5.0" }
        });

        // مرحله 2: لاگین
        await client.post(
            "https://110129.samanpl.ir/Account/Login",
            new URLSearchParams({
                returnUrl: "/Home/ReserveService?ps=ktDKKeFZe5lkOhWTITfdmQ==",
                UserName: "0928731571",
                Password: "AmN!@#27"
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://110129.samanpl.ir",
                    "Referer": "https://110129.samanpl.ir/Account/Login",
                    "User-Agent": "Mozilla/5.0"
                },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400
            }
        );

        // مرحله 3: رفتن به صفحه رزرو (پاپ‌آپ شبیه‌سازی شده)
        const reserveDetail = await client.post(
            "https://110129.samanpl.ir/Home/ReserveDetail",
            new URLSearchParams({
                sc: "ktDKKeFZe5lkOhWTITfdmQ==",
                Sdate: "11/26/2025 12:00:00 AM", // تاریخ مورد نظر
                Shour: "20", // ساعت شروع
                Thour: "21", // ساعت پایان
                year: "2025",
                month: "11"
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://110129.samanpl.ir",
                    "Referer": "https://110129.samanpl.ir/Home/ReserveService?ps=ktDKKeFZe5lkOhWTITfdmQ==",
                    "User-Agent": "Mozilla/5.0"
                }
            }
        );

        // مرحله 4: پارس HTML برای پیدا کردن صندلی 33 و توکن
        const $ = cheerio.load(reserveDetail.data);

        const token = $("input[name='__RequestVerificationToken']").val();
        const seatDiv = $("div.block").filter((i, el) => $(el).text().trim() === "33");
        const seatId = seatDiv.attr("id");

        if (!seatId) {
            console.error("Seat 33 not found!");
            return;
        }

        console.log("CSRF Token:", token);
        console.log("Seat ID:", seatId);

        // مرحله 5: ارسال درخواست رزرو نهایی
        const reserveResponse = await client.post(
            "https://110129.samanpl.ir/Common/Portal/ReservesLibraryNew",
            new URLSearchParams({
                __RequestVerificationToken: token,
                Id: seatId,
                date: "11/26/2025 12:00:00 AM",
                SHour: "20",
                THour: "21",
                userId: "bd93d03e-e2b0-4d64-aaf0-a5ac6138d12a" // باید از HTML یا سشن استخراج بشه
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": "https://110129.samanpl.ir",
                    "Referer": "https://110129.samanpl.ir/Home/ReserveDetail",
                    "User-Agent": "Mozilla/5.0"
                }
            }
        );

        console.log("Reserve response:", reserveResponse.data);

    } catch (err) {
        console.error("Error:", err.message);
    }
}

reserveSeat33();
