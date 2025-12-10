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
function startScheduler(store, reserveSeatFlow, readStore, writeStore, logReservation) {
    let task = null;

    function scheduleCheck() {
        // ساعت 7:00 صبح هر روز (به وقت تهران UTC+3:30)
        // برای Liara (سرور ایران) زمان محلی تهران است
        if (task) task.stop();
        
        // چک کن هر 1 دقیقه
        task = cron.schedule('* * * * *', async () => {
            try {
                const now = dayjs();
                const hour = now.hour();
                const minute = now.minute();
                const todayIso = now.format('YYYY-MM-DD');
                
                const currentStore = await readStore();

                // 1. چک کن تایم‌بندی‌های دلخواه (Custom Schedules)
                if (currentStore.customSchedules && Array.isArray(currentStore.customSchedules)) {
                    const schedules = currentStore.customSchedules.filter(s => !s.executed);
                    
                    for (const schedule of schedules) {
                        // چک کن آیا زمان اجرا رسیده است
                        if (schedule.executionDate === todayIso && schedule.executionHour === hour && schedule.executionMinute === minute) {
                            console.log(`[Scheduler] Running custom schedule: ${schedule.id} for ${schedule.reserveDate}`);
                            try {
                                const runId = `customsched-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
                                const { results } = await reserveSeatFlow(currentStore, schedule.windows, runId);
                                console.log(`[Scheduler] Custom schedule results:`, results);
                                
                                // علامت‌گذاری به عنوان اجرا شده
                                schedule.executed = true;
                                await writeStore(currentStore);
                            } catch (e) {
                                console.error(`[Scheduler] Error running custom schedule:`, e.message);
                            }
                        }
                    }
                }

                // 2. چک کن تایم‌بندی‌های روزانه (scheduledDays) - ساعت 7:00
                if (hour === 7 && minute === 0) {
                    console.log('[Scheduler] Running scheduled task at 07:00...');
                    
                    const tomorrowIso = now.add(1, 'day').format('YYYY-MM-DD');

                    // چک کن آیا امروز یا فردا برای رزرو تایم‌بندی شده است
                    const scheduledToday = currentStore.scheduledDays?.[todayIso] || [];
                    const scheduledTomorrow = currentStore.scheduledDays?.[tomorrowIso] || [];

                    if (scheduledToday.length > 0) {
                        console.log(`[Scheduler] Running reservation for today (${todayIso}): ${scheduledToday.join(', ')}`);
                        try {
                            const runId = `sched-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
                            const { results } = await reserveSeatFlow(currentStore, scheduledToday, runId);
                            console.log(`[Scheduler] Today results:`, results);
                            
                            // پاک کردن از scheduled بعد از اجرا
                            delete currentStore.scheduledDays[todayIso];
                            await writeStore(currentStore);
                        } catch (e) {
                            console.error(`[Scheduler] Error running today reservation:`, e.message);
                        }
                    }
                    
                    if (scheduledTomorrow.length > 0) {
                        console.log(`[Scheduler] Running reservation for tomorrow (${tomorrowIso}): ${scheduledTomorrow.join(', ')}`);
                        try {
                            const runId = `sched-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
                            const { results } = await reserveSeatFlow(currentStore, scheduledTomorrow, runId);
                            console.log(`[Scheduler] Tomorrow results:`, results);
                            
                            // پاک کردن از scheduled بعد از اجرا
                            delete currentStore.scheduledDays[tomorrowIso];
                            await writeStore(currentStore);
                        } catch (e) {
                            console.error(`[Scheduler] Error running tomorrow reservation:`, e.message);
                        }
                    }
                }
            } catch (error) {
                console.error('[Scheduler] Error in scheduled task:', error.message);
            }
        });

        console.log('[Scheduler] Task scheduler started (runs every 1 minute, checks custom schedules and daily tasks)');
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
