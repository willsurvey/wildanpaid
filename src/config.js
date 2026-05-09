// =============================================================================
// CONFIG — Satu Sumber Kebenaran untuk Semua Konfigurasi Sistem
// =============================================================================
// Semua angka, URL, dan parameter dikumpulkan di sini agar mudah di-tuning
// tanpa harus menyentuh logika bisnis di modul lain.
// =============================================================================

require('dotenv').config();

// ---------------------------------------------------------------------------
// Validasi wajib — sistem TIDAK BOLEH jalan tanpa ini
// ---------------------------------------------------------------------------
const REQUIRED_VARS = [
  'STOCKBIT_USERNAME',
  'STOCKBIT_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

for (const key of REQUIRED_VARS) {
  if (!process.env[key] || process.env[key].trim() === '') {
    console.error(`❌ FATAL: Environment variable "${key}" belum diset!`);
    console.error(`   Salin .env.example menjadi .env dan isi semua field.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Stockbit Auth
// ---------------------------------------------------------------------------
const STOCKBIT = {
  LOGIN_URL: 'https://exodus.stockbit.com/login/v6/username',
  WS_KEY_URL: 'https://exodus.stockbit.com/api/ws/trading-key',
  WS_URL: 'wss://wss-jkt.trading.stockbit.com/ws',

  USERNAME: process.env.STOCKBIT_USERNAME.trim(),
  PASSWORD: process.env.STOCKBIT_PASSWORD.trim(),
  PLAYER_ID: (process.env.STOCKBIT_PLAYER_ID || '').trim(),

  // Override manual — jika diset, skip login API
  BEARER_TOKEN: (process.env.STOCKBIT_BEARER_TOKEN || '').trim(),

  // Header HTTP identik Chrome agar tidak di-block
  LOGIN_HEADERS: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'X-DeviceType': 'Google Chrome',
    'X-Platform': 'PC',
    'X-AppVersion': '3.17.2',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': 'ID',
    Origin: 'https://stockbit.com',
    Referer: 'https://stockbit.com/',
  },

  // Retry & backoff
  MAX_LOGIN_ATTEMPTS: 3,
  LOGIN_TIMEOUT_MS: 30_000,
};

// ---------------------------------------------------------------------------
// WebSocket Connection
// ---------------------------------------------------------------------------
const CONNECTION = {
  // Heartbeat: kirim ping setiap 5 detik
  PING_INTERVAL_MS: 5_000,

  // Watchdog: jika 10 detik tidak ada data masuk, paksa reconnect
  WATCHDOG_TIMEOUT_MS: 10_000,

  // Reconnect: exponential backoff (1s, 2s, 4s, 8s)
  MAX_RECONNECT_ATTEMPTS: 10,
  BASE_RECONNECT_DELAY_MS: 1_000,

  // Jeda minimum antar percobaan koneksi
  MIN_CONNECT_GUARD_MS: 2_000,
};

// ---------------------------------------------------------------------------
// Analytics Engine — Parameter Sinyal Trading
// ---------------------------------------------------------------------------
const ANALYTICS = {
  // Sliding window: simpan data transaksi 60 detik terakhir
  WINDOW_DURATION_MS: 60_000,

  // Pembersihan data kadaluarsa setiap 1 detik
  CLEANUP_INTERVAL_MS: 1_000,

  // --- INSTITUTIONAL BUYING ---
  // Dominasi HK harus > 75% dari total transaksi (dalam Rupiah)
  INSTITUTIONAL_HK_DOMINANCE: 0.75,
  // Total akumulasi HK minimum Rp 2 Miliar dalam 1 menit
  INSTITUTIONAL_MIN_VALUE: 2_000_000_000,
  // Harga tidak boleh sudah naik > 5% (zona entry masih aman)
  INSTITUTIONAL_MAX_CHANGE_PCT: 5.0,
  // Ambang batas 1 transaksi dianggap "Block Trade" (Paus)
  WHALE_SINGLE_TRADE_VALUE: 250_000_000,   // Rp 250 Juta
  WHALE_MEGA_TRADE_VALUE: 1_000_000_000,   // Rp 1 Miliar

  // --- RAPID MOMENTUM ---
  // Jendela waktu pendek: 10 detik terakhir
  RAPID_WINDOW_MS: 10_000,
  // Minimum frekuensi HK dalam jendela 10 detik
  RAPID_MIN_FREQUENCY: 30,

  // --- DISTRIBUTION WARNING ---
  // Dominasi HAKI harus > 75%
  DISTRIBUTION_HAKI_DOMINANCE: 0.75,
  // Total guyuran HAKI minimum Rp 2 Miliar dalam 1 menit
  DISTRIBUTION_MIN_VALUE: 2_000_000_000,
};

// ---------------------------------------------------------------------------
// Telegram Notifier
// ---------------------------------------------------------------------------
const TELEGRAM = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN.trim(),
  CHAT_ID: process.env.TELEGRAM_CHAT_ID.trim(),
  API_BASE: 'https://api.telegram.org',

  // Cooldown: jeda antar alert untuk SAHAM YANG SAMA (5 menit)
  COOLDOWN_MS: 5 * 60 * 1_000,

  // ID Topik Telegram (message_thread_id)
  // Isi dengan angka ID Topik Anda. Jika ingin digabung semua (tanpa topik), biarkan null.
  TOPICS: {
    INSTITUTIONAL: process.env.TELEGRAM_TOPIC_INSTITUTIONAL || null,
    WHALE:         process.env.TELEGRAM_TOPIC_WHALE || null,
    MOMENTUM:      process.env.TELEGRAM_TOPIC_MOMENTUM || null,
    DISTRIBUTION:  process.env.TELEGRAM_TOPIC_DISTRIBUTION || null,
  },

  // Rate limit Telegram: max 30 pesan/detik ke grup
  // Kita batasi sendiri: max 1 pesan per 2 detik (sangat aman)
  MIN_SEND_INTERVAL_MS: 2_000,
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const LOG = {
  // Level: 'debug' | 'info' | 'warn' | 'error'
  LEVEL: process.env.LOG_LEVEL || 'info',

  // Simpan log sinyal ke file CSV untuk evaluasi/backtest
  SIGNAL_LOG_FILE: 'logs/signals.csv',
};

module.exports = { STOCKBIT, CONNECTION, ANALYTICS, TELEGRAM, LOG };
