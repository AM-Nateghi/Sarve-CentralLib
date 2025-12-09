# راهنمای استفاده از دیتابیس MariaDB

## تغییرات انجام شده

پروژه از استفاده از فایل‌های JSON (`store.json` و `logs/history.json`) به دیتابیس MariaDB منتقل شده.

## ساختار دیتابیس

### جدول `settings`
تنظیمات برنامه رو ذخیره می‌کنه (جایگزین `store.json`):
- `id`: شناسه یکتا
- `key_name`: نام کلید تنظیمات (username, passwd, seat_number و...)
- `value`: مقدار (JSON string)
- `updated_at`: زمان آخرین به‌روزرسانی

### جدول `reservation_logs`
لاگ رزروها رو ذخیره می‌کنه (جایگزین `logs/history.json`):
- `id`: شناسه یکتا
- `entry_id`: شناسه منحصر به فرد ورودی
- `date`: تاریخ رزرو (YYYY-MM-DD)
- `window`: بازه زمانی (مثلاً "8-11")
- `status`: وضعیت (success یا failed)
- `message`: پیام سرور
- `error`: متن خطا (در صورت وجود)
- `timestamp`: زمان دقیق
- `jalali_date`: تاریخ شمسی
- `created_at`: زمان ثبت در دیتابیس

## فایل‌های جدید

### `db.js`
ماژول مدیریت دیتابیس که شامل:
- اتصال به MariaDB
- ایجاد خودکار جداول
- توابع خواندن/نوشتن تنظیمات
- توابع مدیریت لاگ‌ها

### تغییرات `main.js`
- حذف استفاده از `fs` برای خواندن/نوشتن فایل
- تبدیل تمام endpoint‌ها به async
- استفاده از توابع دیتابیس به جای فایل

### تغییرات `logs.js`
- ساده‌سازی به یک wrapper برای `db.js`
- حذف مدیریت فایل

## نصب و اجرا

### 1. نصب پکیج‌ها
```bash
npm install
```

پکیج `mysql2` به `package.json` اضافه شده.

### 2. اتصال به دیتابیس در Liara

اطلاعات اتصال در `db.js` به صورت hardcode وارد شده:
```javascript
host: 'anti-kokh-db',
port: 3306,
user: 'root',
password: '4uHnk3KMtz5QJlO7MJWYHpzO',
database: 'blissful_lewin'
```

### 3. اجرا
```bash
npm start
```

برنامه خودکار:
1. به دیتابیس متصل می‌شه
2. جداول رو می‌سازه (اگر وجود نداشته باشند)
3. سرور رو روی پورت 3000 راه‌اندازی می‌کنه

## مهاجرت داده‌ها (اختیاری)

اگر داده‌های قبلی رو دارید:

### مهاجرت `store.json`:
```javascript
const fs = require('fs');
const { writeStore } = require('./db');

const oldStore = JSON.parse(fs.readFileSync('store.json', 'utf8'));
await writeStore(oldStore);
```

### مهاجرت `logs/history.json`:
```javascript
const fs = require('fs');
const { logReservation } = require('./db');

const oldLogs = JSON.parse(fs.readFileSync('logs/history.json', 'utf8'));
for (const entry of oldLogs.entries) {
    await logReservation(entry);
}
```

## مزایا

✅ **بدون مشکل Read-Only**: دیگه با خطای `EROFS` مواجه نمی‌شید
✅ **مقیاس‌پذیری**: دیتابیس برای حجم بالای داده مناسب‌تر
✅ **ایمن‌تر**: Connection pooling و transaction support
✅ **پرس‌وجو سریع‌تر**: Index روی فیلدهای مهم
✅ **بکاپ آسان‌تر**: از ابزارهای استاندارد دیتابیس

## توجه

- دیتابیس خودکار جداول رو می‌سازه (نیازی به migration نیست)
- تنظیمات پیش‌فرض در اولین اجرا وارد دیتابیس می‌شن
- لاگ‌ها نامحدود ذخیره می‌شن (پاکسازی دستی در صورت نیاز)
