// scheduler.js - مدیریت automatic scheduling با node-cron
const cron = require('node-cron');
const dayjs = require('dayjs');

/**
 * Helper برای تبدیل روز ISO به تاریخ شمسی
 */
function toJalaliFromISO(isoDateStr) {
    const [year, month, day] = isoDateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);

    const gy = d.getFullYear();
    const gm = d.getMonth() + 1;
    const gd = d.getDate();

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
    let jm = 0;
    for (; jm < 12 && j_day_no >= jm_list[jm]; jm++) j_day_no -= jm_list[jm];
    const jd = j_day_no + 1;

    return `${jy}/${String(jm + 1).padStart(2, "0")}/${String(jd).padStart(2, "0")}`;
}

/**
 * شروع scheduler برای اجرای خودکار رزروها
 * @param {Object} store - تنظیمات ذخیره شده
 * @param {Function} reserveSeatFlow - تابع رزرو
 * @param {Function} readStore - تابع خواندن store
 * @param {Function} writeStore - تابع نوشتن store
 * @param {Function} logReservation - تابع لاگ کردن
 */
function startScheduler(store, reserveSeatFlow, getAllUsersWithConfigs, updateUserConfig, logReservation) {
    let task = null;

    function scheduleCheck() {
        if (task) task.stop();

        task = cron.schedule('* * * * *', async () => {
            try {
                const now = dayjs();
                const hour = now.hour();
                const minute = now.minute();
                const todayIso = now.format('YYYY-MM-DD');

                // گرفتن لیست تمام کاربران تایید شده و تنظیماتشان
                const users = await getAllUsersWithConfigs();

                for (const user of users) {
                    const currentConfig = user.config;

                    // 1. چک کن زمان‌بندی‌های دلخواه (Custom Schedules)
                    if (currentConfig.customSchedules && Array.isArray(currentConfig.customSchedules)) {
                        let configChanged = false;
                        for (const schedule of currentConfig.customSchedules) {
                            if (!schedule.executed && schedule.executionDate === todayIso &&
                                schedule.executionHour === hour && schedule.executionMinute === minute) {

                                console.log(`[Scheduler] User ${user.username}: Running custom schedule ${schedule.id}`);
                                try {
                                    const runId = `custom-sc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

                                    // ساخت شیء مشابه store برای الگوریتم رزرو
                                    const storeObj = {
                                        username: user.username,
                                        passwd: currentConfig.sampl_password,
                                        phone_number: user.phone_number,
                                        call_on_failure: currentConfig.call_on_failure,
                                        seat_priority: currentConfig.seat_priority,
                                        concurrency: currentConfig.concurrency,
                                        requestStartSpreadMs: currentConfig.requestStartSpreadMs,
                                        sc: currentConfig.sc,
                                        reserveDateMode: currentConfig.reserveDateMode
                                    };

                                    const { results } = await reserveSeatFlow(storeObj, schedule.windows, runId, null, user.id, user.username);

                                    if (results.some(r => r.success)) {
                                        schedule.executed = true;
                                        configChanged = true;
                                    }
                                } catch (e) {
                                    console.error(`[Scheduler] Error for ${user.username}:`, e.message);
                                }
                            }
                        }
                        if (configChanged) {
                            await updateUserConfig(user.id, currentConfig);
                        }
                    }

                    // 2. چک کن زمان‌بندی‌های روزانه (scheduledDays) - ساعت 7:00 صبح
                    if (hour === 7 && minute === 0) {
                        const tomorrowIso = now.add(1, 'day').format('YYYY-MM-DD');
                        const scheduledToday = currentConfig.scheduledDays?.[todayIso] || [];
                        const scheduledTomorrow = currentConfig.scheduledDays?.[tomorrowIso] || [];

                        const runSchedule = async (isoDate, windows) => {
                            if (windows.length > 0) {
                                console.log(`[Scheduler] User ${user.username}: Running daily for ${isoDate}`);
                                try {
                                    const runId = `daily-sc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                                    const storeObj = {
                                        username: user.username,
                                        passwd: currentConfig.sampl_password,
                                        phone_number: user.phone_number,
                                        call_on_failure: currentConfig.call_on_failure,
                                        seat_priority: currentConfig.seat_priority,
                                        concurrency: currentConfig.concurrency,
                                        requestStartSpreadMs: currentConfig.requestStartSpreadMs,
                                        sc: currentConfig.sc,
                                        reserveDateMode: currentConfig.reserveDateMode
                                    };
                                    // تاریخ را دستی می‌فرستیم چون scheduledDays برای تاریخ خاصی است
                                    const dateInfoOverride = { iso: isoDate };
                                    // توجه: reserveSeatFlow باید بتواند dateInfoOverride را هندل کند یا ما باید آبجکت کامل بسازیم
                                    // در main.js فعلی، reserveSeatFlow ورودی چهارم dateInfoOverride می‌گیرد
                                    await reserveSeatFlow(storeObj, windows, runId, null, user.id, user.username);

                                    delete currentConfig.scheduledDays[isoDate];
                                    return true;
                                } catch (e) {
                                    console.error(`[Scheduler] Daily error for ${user.username}:`, e.message);
                                }
                            }
                            return false;
                        };

                        const changed1 = await runSchedule(todayIso, scheduledToday);
                        const changed2 = await runSchedule(tomorrowIso, scheduledTomorrow);

                        if (changed1 || changed2) {
                            await updateUserConfig(user.id, currentConfig);
                        }
                    }
                }
            } catch (error) {
                console.error('[Scheduler] Error in scheduled task:', error.message);
            }
        });

        console.log('[Scheduler] Multi-user task scheduler started');
    }

    scheduleCheck();

    return {
        stop: () => {
            if (task) task.stop();
            console.log('[Scheduler] Task scheduler stopped');
        },
        restart: scheduleCheck
    };
}

module.exports = { startScheduler };
