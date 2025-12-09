// db.js - مدیریت دیتابیس MariaDB
const mysql = require('mysql2/promise');

// اطلاعات اتصال به دیتابیس
const DB_CONFIG = {
    host: 'anti-kokh-db',
    port: 3306,
    user: 'root',
    password: '4uHnk3KMtz5QJlO7MJWYHpzO',
    database: 'blissful_lewin',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// ایجاد connection pool
const pool = mysql.createPool(DB_CONFIG);

// -------------------- ایجاد جداول --------------------
async function initDatabase() {
    try {
        const connection = await pool.getConnection();

        // جدول تنظیمات (settings)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT PRIMARY KEY AUTO_INCREMENT,
                key_name VARCHAR(100) UNIQUE NOT NULL,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // جدول لاگ رزروها (reservation_logs)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS reservation_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                entry_id VARCHAR(100),
                date DATE NOT NULL,
                window VARCHAR(20),
                status ENUM('success', 'failed', 'scheduled') NOT NULL,
                message TEXT,
                error TEXT,
                timestamp DATETIME NOT NULL,
                jalali_date VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_date (date),
                INDEX idx_status (status),
                INDEX idx_entry (entry_id)
            )
        `);

        connection.release();
        console.log('[DB] Database initialized successfully');
    } catch (error) {
        console.error('[DB] Failed to initialize database:', error.message);
        throw error;
    }
}

// -------------------- توابع مدیریت تنظیمات --------------------
async function getSetting(key) {
    try {
        const [rows] = await pool.query(
            'SELECT value FROM settings WHERE key_name = ?',
            [key]
        );
        if (rows.length > 0) {
            try {
                return JSON.parse(rows[0].value);
            } catch {
                return rows[0].value;
            }
        }
        return null;
    } catch (error) {
        console.error(`[DB] Failed to get setting ${key}:`, error.message);
        return null;
    }
}

async function setSetting(key, value) {
    try {
        const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
        await pool.query(
            'INSERT INTO settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
            [key, valueStr, valueStr]
        );
    } catch (error) {
        console.error(`[DB] Failed to set setting ${key}:`, error.message);
        throw error;
    }
}

async function getAllSettings() {
    try {
        const [rows] = await pool.query('SELECT key_name, value FROM settings');
        const settings = {};
        rows.forEach(row => {
            try {
                settings[row.key_name] = JSON.parse(row.value);
            } catch {
                settings[row.key_name] = row.value;
            }
        });
        return settings;
    } catch (error) {
        console.error('[DB] Failed to get all settings:', error.message);
        return {};
    }
}

// -------------------- توابع مدیریت لاگ‌ها --------------------
async function logReservation(data) {
    const {
        date,
        window,
        status,
        message,
        error,
        timestamp,
        jalaliDate
    } = data;

    const entryId = `${date}-${window}-${Date.now()}`;

    try {
        // تبدیل ISO timestamp به DATETIME format
        let datetimeValue = timestamp;
        if (typeof timestamp === 'string' && timestamp.includes('T')) {
            // تبدیل 2025-12-09T09:38:27.498Z به 2025-12-09 09:38:27
            datetimeValue = timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
        }

        await pool.query(
            `INSERT INTO reservation_logs 
            (entry_id, date, window, status, message, error, timestamp, jalali_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [entryId, date, window, status, message || '', error || null, datetimeValue, jalaliDate]
        );
    } catch (err) {
        console.error('[DB] Failed to log reservation:', err.message);
    }
}

async function getHistory(limit = 50) {
    try {
        const [rows] = await pool.query(
            `SELECT entry_id, date, window, status, message, error, timestamp, jalali_date
             FROM reservation_logs
             ORDER BY timestamp DESC
             LIMIT ?`,
            [limit]
        );
        return rows.map(row => ({
            id: row.entry_id,
            date: row.date,
            window: row.window,
            status: row.status,
            message: row.message,
            error: row.error,
            timestamp: row.timestamp,
            jalaliDate: row.jalali_date
        }));
    } catch (error) {
        console.error('[DB] Failed to get history:', error.message);
        return [];
    }
}

async function getHistoryByDate(date) {
    try {
        const [rows] = await pool.query(
            `SELECT entry_id, date, window, status, message, error, timestamp, jalali_date
             FROM reservation_logs
             WHERE date = ?
             ORDER BY timestamp DESC`,
            [date]
        );
        return rows.map(row => ({
            id: row.entry_id,
            date: row.date,
            window: row.window,
            status: row.status,
            message: row.message,
            error: row.error,
            timestamp: row.timestamp,
            jalaliDate: row.jalali_date
        }));
    } catch (error) {
        console.error('[DB] Failed to get history by date:', error.message);
        return [];
    }
}

// -------------------- Store management --------------------
const DEFAULT_STORE = {
    username: "0928731571",
    passwd: "AmN!@#27",
    seat_number: 33,
    seat_priority: [33, 32, 34, 37, 42],
    concurrency: 3,
    requestStartSpreadMs: 400,
    sc: "ktDKKeFZe5lkOhWTITfdmQ==",
    reserveDateMode: "today",
    selectedWindows: [],
    scheduledDays: {},
    lastMonthQuota: null
};

async function readStore() {
    try {
        const settings = await getAllSettings();

        // اگر هیچ تنظیماتی نیست، تنظیمات پیش‌فرض رو بریز
        if (Object.keys(settings).length === 0) {
            await writeStore(DEFAULT_STORE);
            return { ...DEFAULT_STORE };
        }

        // ترکیب تنظیمات موجود با پیش‌فرض
        return { ...DEFAULT_STORE, ...settings };
    } catch (error) {
        console.error('[DB] Failed to read store:', error.message);
        return { ...DEFAULT_STORE };
    }
}

async function writeStore(store) {
    try {
        // هر کلید رو جداگانه ذخیره می‌کنیم
        for (const [key, value] of Object.entries(store)) {
            await setSetting(key, value);
        }
    } catch (error) {
        console.error('[DB] Failed to write store:', error.message);
        throw error;
    }
}

module.exports = {
    pool,
    initDatabase,
    getSetting,
    setSetting,
    getAllSettings,
    logReservation,
    getHistory,
    getHistoryByDate,
    readStore,
    writeStore
};
