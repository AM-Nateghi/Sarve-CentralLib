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

const LOCAL_DB_CONFIG = {
    host: 'localhost',
    port: 3306,
    user: 'devspace',
    password: 'dfd404gk5$G%$V^Iv5y6',
    database: 'blissful_lewin',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

const env = (process.env.NODE_ENV || '').trim();

// ایجاد connection pool
if (env === 'development') {
    console.log('[DB] Using local database configuration');
    pool = mysql.createPool(LOCAL_DB_CONFIG);
}
else {
    console.log('[DB] Using production database configuration');
    pool = mysql.createPool(DB_CONFIG);
}

// -------------------- ایجاد جداول --------------------
async function initDatabase() {
    try {
        const connection = await pool.getConnection();

        // جدول تنظیمات (settings) - برای مقادیر سراسری
        await connection.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT PRIMARY KEY AUTO_INCREMENT,
                key_name VARCHAR(100) UNIQUE NOT NULL,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // جدول کاربران (users)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                sampl_password VARCHAR(255),
                phone_number VARCHAR(15), 
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_username (username),
                INDEX idx_status (status)
            )
        `);

        // جدول تنظیمات کاربران (user_configs)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS user_configs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL UNIQUE,
                seat_priority VARCHAR(255),
                sc VARCHAR(255),
                sampl_password VARCHAR(255),
                concurrency INT DEFAULT 3,
                requestStartSpreadMs INT DEFAULT 400,
                reserveDateMode VARCHAR(20) DEFAULT 'tomorrow',
                call_on_failure BOOLEAN DEFAULT FALSE,
                selectedWindows JSON,
                scheduledDays JSON,
                customSchedules JSON,
                lastMonthQuota TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user (user_id)
            )
        `);

        // جدول لاگ رزروها (reservation_logs)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS reservation_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT,
                username VARCHAR(100),
                entry_id VARCHAR(100),
                date DATE NOT NULL,
                window VARCHAR(20),
                status ENUM('success', 'failed', 'scheduled') NOT NULL,
                message TEXT,
                error TEXT,
                timestamp DATETIME NOT NULL,
                jalali_date VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_date (date),
                INDEX idx_status (status),
                INDEX idx_entry (entry_id),
                INDEX idx_user_id (user_id),
                INDEX idx_username (username)
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
        user_id,
        username,
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
            (user_id, username, entry_id, date, window, status, message, error, timestamp, jalali_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id || null, username || null, entryId, date, window, status, message || '', error || null, datetimeValue, jalaliDate]
        );
    } catch (err) {
        console.error('[DB] Failed to log reservation:', err.message);
    }
}

async function getHistory(limit = 50) {
    try {
        const [rows] = await pool.query(
            `SELECT entry_id, date, window, status, message, error, timestamp, jalali_date, username
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
            jalaliDate: row.jalali_date,
            username: row.username
        }));
    } catch (error) {
        console.error('[DB] Failed to get history:', error.message);
        return [];
    }
}

async function getHistoryForUser(userId, limit = 50) {
    try {
        const [rows] = await pool.query(
            `SELECT entry_id, date, window, status, message, error, timestamp, jalali_date
             FROM reservation_logs
             WHERE user_id = ?
             ORDER BY timestamp DESC
             LIMIT ?`,
            [userId, limit]
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
        console.error('[DB] Failed to get history for user:', error.message);
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

// -------------------- توابع مدیریت کاربران --------------------
async function getAllUsersWithConfigs() {
    try {
        const [rows] = await pool.query(`
            SELECT u.id, u.username, u.status, u.phone_number, c.* 
            FROM users u
            JOIN user_configs c ON u.id = c.user_id
            WHERE u.status = 'approved'
        `);
        return rows.map(row => ({
            id: row.id,
            username: row.username,
            phone_number: row.phone_number,
            config: {
                user_id: row.user_id,
                seat_priority: row.seat_priority ? row.seat_priority.split(',').map(s => parseInt(s, 10)) : [],
                sc: row.sc,
                sampl_password: row.sampl_password,
                concurrency: row.concurrency,
                requestStartSpreadMs: row.requestStartSpreadMs,
                reserveDateMode: row.reserveDateMode,
                call_on_failure: !!row.call_on_failure,
                selectedWindows: row.selectedWindows ? JSON.parse(row.selectedWindows) : [],
                scheduledDays: row.scheduledDays ? JSON.parse(row.scheduledDays) : {},
                customSchedules: row.customSchedules ? JSON.parse(row.customSchedules) : [],
                lastMonthQuota: row.lastMonthQuota
            }
        }));
    } catch (error) {
        console.error('[DB] Failed to get all users with configs:', error.message);
        return [];
    }
}

async function createUser(username, passwordHash, phoneNumber) {
    try {
        const [result] = await pool.query(
            `INSERT INTO users (username, password, phone_number, status) VALUES (?, ?, ?, 'pending')`,
            [username, passwordHash, phoneNumber]
        );
        return result.insertId;
    } catch (error) {
        console.error('[DB] Failed to create user:', error.message);
        throw error;
    }
}

async function getUserByUsername(username) {
    try {
        const [rows] = await pool.query(
            `SELECT id, username, password, phone_number, status, created_at FROM users WHERE username = ?`,
            [username]
        );
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error('[DB] Failed to get user by username:', error.message);
        return null;
    }
}

async function getUserById(userId) {
    try {
        const [rows] = await pool.query(
            `SELECT id, username, phone_number, status, created_at FROM users WHERE id = ?`,
            [userId]
        );
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error('[DB] Failed to get user by id:', error.message);
        return null;
    }
}

async function getAllUsers(statusFilter = null) {
    try {
        let query = `SELECT id, username, status, created_at FROM users`;
        let params = [];

        if (statusFilter) {
            query += ` WHERE status = ?`;
            params.push(statusFilter);
        }

        query += ` ORDER BY created_at DESC`;
        const [rows] = await pool.query(query, params);
        return rows;
    } catch (error) {
        console.error('[DB] Failed to get all users:', error.message);
        return [];
    }
}

async function updateUserStatus(userId, status) {
    try {
        await pool.query(
            `UPDATE users SET status = ? WHERE id = ?`,
            [status, userId]
        );
    } catch (error) {
        console.error('[DB] Failed to update user status:', error.message);
        throw error;
    }
}

async function deleteUser(userId) {
    try {
        await pool.query(`DELETE FROM users WHERE id = ?`, [userId]);
    } catch (error) {
        console.error('[DB] Failed to delete user:', error.message);
        throw error;
    }
}

// -------------------- توابع مدیریت تنظیمات کاربر --------------------
async function createUserConfig(userId, config) {
    try {
        await pool.query(
            `INSERT INTO user_configs (
                user_id, seat_priority, sc, sampl_password, concurrency, 
                requestStartSpreadMs, reserveDateMode, call_on_failure, selectedWindows, 
                scheduledDays, customSchedules, lastMonthQuota
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                config.seat_priority ? config.seat_priority.join(',') : '',
                config.sc || '',
                config.sampl_password || '',
                config.concurrency || 3,
                config.requestStartSpreadMs || 400,
                config.reserveDateMode || 'tomorrow',
                config.call_on_failure ? 1 : 0,
                JSON.stringify(config.selectedWindows || []),
                JSON.stringify(config.scheduledDays || {}),
                JSON.stringify(config.customSchedules || []),
                config.lastMonthQuota || null
            ]
        );
    } catch (error) {
        console.error('[DB] Failed to create user config:', error.message);
        throw error;
    }
}

async function getUserConfig(userId) {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM user_configs WHERE user_id = ?`,
            [userId]
        );
        if (rows.length === 0) return null;

        const row = rows[0];
        return {
            user_id: row.user_id,
            seat_priority: row.seat_priority ? row.seat_priority.split(',').map(s => parseInt(s, 10)) : [],
            sc: row.sc,
            sampl_password: row.sampl_password,
            concurrency: row.concurrency,
            requestStartSpreadMs: row.requestStartSpreadMs,
            reserveDateMode: row.reserveDateMode,
            call_on_failure: !!row.call_on_failure,
            selectedWindows: row.selectedWindows ? JSON.parse(row.selectedWindows) : [],
            scheduledDays: row.scheduledDays ? JSON.parse(row.scheduledDays) : {},
            customSchedules: row.customSchedules ? JSON.parse(row.customSchedules) : [],
            lastMonthQuota: row.lastMonthQuota
        };
    } catch (error) {
        console.error('[DB] Failed to get user config:', error.message);
        return null;
    }
}

async function updateUserConfig(userId, config) {
    try {
        await pool.query(
            `UPDATE user_configs SET 
                seat_priority = ?, 
                sc = ?, 
                sampl_password = ?,
                concurrency = ?, 
                requestStartSpreadMs = ?, 
                reserveDateMode = ?, 
                call_on_failure = ?,
                selectedWindows = ?, 
                scheduledDays = ?, 
                customSchedules = ?, 
                lastMonthQuota = ?
            WHERE user_id = ?`,
            [
                config.seat_priority ? config.seat_priority.join(',') : '',
                config.sc || '',
                config.sampl_password || '',
                config.concurrency || 3,
                config.requestStartSpreadMs || 400,
                config.reserveDateMode || 'tomorrow',
                config.call_on_failure ? 1 : 0,
                JSON.stringify(config.selectedWindows || []),
                JSON.stringify(config.scheduledDays || {}),
                JSON.stringify(config.customSchedules || []),
                config.lastMonthQuota !== undefined ? config.lastMonthQuota : null,
                userId
            ]
        );
    } catch (error) {
        console.error('[DB] Failed to update user config:', error.message);
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
    getHistoryForUser,
    getHistoryByDate,
    readStore,
    writeStore,
    getAllUsersWithConfigs,
    createUser,
    getUserByUsername,
    getUserById,
    getAllUsers,
    updateUserStatus,
    deleteUser,
    createUserConfig,
    getUserConfig,
    updateUserConfig
};
