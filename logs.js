// logs.js - پل بین main.js و db.js
// این فایل فقط برای سازگاری با کد قبلی نگه داشته شده
// همه کارها رو به db.js منتقل می‌کنه

const { logReservation, getHistory, getHistoryByDate } = require("./db");

module.exports = {
    logReservation,
    getHistory,
    getHistoryByDate
};
