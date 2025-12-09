// scheduler.js - مدیریت automatic scheduling با node-cron
const cron = require('node-cron');
const dayjs = require('dayjs');

/**
 * شروع scheduler برای اجرای خودکار رزروها
 * @param {Object} store - تنظیمات ذخیره شده
 * @param {Function} reserveSeatFlow - تابع رزرو
 * @param {Function} readStore - تابع خواندن store
 * @param {Function} writeStore - تابع نوشتن store
 * @param {Function} logReservation - تابع لاگ کردن
 */
function startScheduler(store, reserveSeatFlow, readStore, writeStore, logReservation, toJalaliString) {
    let task = null;

    function scheduleCheck() {
        // تمام 5 دقیقه چک کن آیا زمان رزرو رسیده یا نه
        if (task) task.stop();
        
        task = cron.schedule('*/5 * * * *', async () => {
            try {
                const currentStore = await readStore();
                const now = dayjs();
                const todayIso = now.format('YYYY-MM-DD');
                const tomorrowIso = now.add(1, 'day').format('YYYY-MM-DD');

                // چک کن آیا امروز یا فردا برای رزرو تایم‌بندی شده است
                const scheduledToday = currentStore.scheduledDays?.[todayIso] || [];
                const scheduledTomorrow = currentStore.scheduledDays?.[tomorrowIso] || [];

                if (scheduledToday.length > 0 || scheduledTomorrow.length > 0) {
                    console.log(`[Scheduler] Found scheduled days - Today: ${scheduledToday.join(', ') || 'none'}, Tomorrow: ${scheduledTomorrow.join(', ') || 'none'}`);

                    // اجرا برای امروز
                    if (scheduledToday.length > 0) {
                        console.log(`[Scheduler] Running reservation for today (${todayIso})...`);
                        try {
                            const { results } = await reserveSeatFlow(currentStore, scheduledToday);
                            console.log(`[Scheduler] Today results:`, results);

                            // پاک کردن از scheduled بعد از اجرا
                            delete currentStore.scheduledDays[todayIso];
                            await writeStore(currentStore);
                        } catch (e) {
                            console.error(`[Scheduler] Error running today reservation:`, e.message);
                        }
                    }
                }
            } catch (error) {
                console.error('[Scheduler] Error in scheduled task:', error.message);
            }
        });

        console.log('[Scheduler] Task scheduler started (checks every 5 minutes)');
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
