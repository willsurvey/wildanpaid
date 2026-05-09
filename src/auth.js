// =============================================================================
// AUTH MANAGER — Login API Stockbit & JWT Token Management
// =============================================================================
// Diadaptasi dari logika screener.py (_login_via_api).
// Fitur:
//   1. Login via POST /login/v6/username → ambil JWT
//   2. Ambil WS Trading Key (untuk autentikasi WebSocket)
//   3. Cache token di memori (23 jam) agar tidak login berulang
//   4. Validasi JWT expiry secara proaktif
//   5. Force-refresh saat menerima Error 401 dari WebSocket
// =============================================================================

const axios = require('axios');
const { STOCKBIT } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('AUTH');

// ---------------------------------------------------------------------------
// State: In-memory token cache
// ---------------------------------------------------------------------------
let _jwtToken = null;
let _jwtExpiry = 0; // Unix timestamp (seconds)
let _wsKey = null;
let _userId = null;

// ---------------------------------------------------------------------------
// JWT Utilities
// ---------------------------------------------------------------------------

/**
 * Decode JWT payload (bagian tengah) tanpa verifikasi signature.
 * @param {string} token - JWT string
 * @returns {Object|null} Payload object atau null jika gagal
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Base64url → Base64 standard, lalu decode
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // Tambah padding jika kurang
    const pad = payload.length % 4;
    if (pad) payload += '='.repeat(4 - pad);

    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Cek apakah JWT masih valid (belum expired).
 * @param {string} token - JWT string
 * @param {number} [bufferSeconds=300] - Buffer keamanan (default 5 menit)
 * @returns {boolean}
 */
function isTokenValid(token, bufferSeconds = 300) {
  if (!token || token.length < 100) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const exp = payload.exp || 0;
  return Date.now() / 1000 < exp - bufferSeconds;
}

/**
 * Ambil sisa waktu token dalam jam.
 * @param {string} token
 * @returns {number} Sisa waktu dalam jam
 */
function getTokenRemainingHours(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return 0;
  return (payload.exp - Date.now() / 1000) / 3600;
}

/**
 * Ekstrak userId dari JWT payload.
 * @param {string} token
 * @returns {string|null}
 */
function extractUserId(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  // Stockbit menyimpan uid di payload.data.uid
  const uid = payload?.data?.uid || payload?.uid || payload?.sub || null;
  return uid ? String(uid) : null;
}

// ---------------------------------------------------------------------------
// Login API
// ---------------------------------------------------------------------------

/**
 * Login ke Stockbit API dan dapatkan JWT access token.
 * Retry policy: 429→tunggu, timeout→retry, 4xx→gagal, 5xx→retry.
 * @returns {Promise<string|null>} JWT token atau null jika gagal
 */
async function loginViaApi() {
  // 1. Cek cache dulu
  if (_jwtToken && Date.now() / 1000 < _jwtExpiry && isTokenValid(_jwtToken)) {
    log.debug('🔄 Token dari cache in-memory');
    return _jwtToken;
  }

  // 2. Cek override manual dari env
  if (STOCKBIT.BEARER_TOKEN && isTokenValid(STOCKBIT.BEARER_TOKEN)) {
    log.info('🔑 Menggunakan STOCKBIT_BEARER_TOKEN dari environment');
    _jwtToken = STOCKBIT.BEARER_TOKEN;
    _jwtExpiry = Date.now() / 1000 + 23 * 3600;
    _userId = extractUserId(_jwtToken);
    return _jwtToken;
  }

  // 3. Login API
  const { USERNAME, PASSWORD, PLAYER_ID } = STOCKBIT;
  if (!USERNAME || !PASSWORD) {
    log.error('❌ STOCKBIT_USERNAME/PASSWORD tidak diset — tidak bisa login');
    return null;
  }

  const maskedUser = USERNAME.substring(0, 3) + '***';
  log.info(`🔑 Login Stockbit API sebagai '${maskedUser}'...`);

  const body = {
    player_id: PLAYER_ID || '',
    user: USERNAME,
    password: PASSWORD,
  };

  for (let attempt = 1; attempt <= STOCKBIT.MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(STOCKBIT.LOGIN_URL, body, {
        headers: STOCKBIT.LOGIN_HEADERS,
        timeout: STOCKBIT.LOGIN_TIMEOUT_MS,
      });

      // Parse response: data.login.token_data.access.token
      const token =
        response.data?.data?.login?.token_data?.access?.token || '';

      if (!token) {
        const topKeys = Object.keys(response.data?.data || response.data || {}).slice(0, 8);
        log.warn(`⚠️ Token tidak ditemukan di response. Keys: [${topKeys.join(', ')}]`);
        return null;
      }

      if (!isTokenValid(token)) {
        log.warn(`⚠️ Token diterima tapi sudah expired (len=${token.length})`);
        return null;
      }

      // Simpan ke cache (23 jam — token Stockbit berlaku 24 jam)
      _jwtToken = token;
      _jwtExpiry = Date.now() / 1000 + 23 * 3600;
      _userId = extractUserId(token);

      const remaining = getTokenRemainingHours(token);
      log.info(
        `✅ Login berhasil — token valid ${remaining.toFixed(1)} jam ` +
        `(${token.length} karakter, userId: ${_userId})`
      );
      return token;

    } catch (err) {
      const status = err.response?.status;

      // 429: Rate limited
      if (status === 429) {
        const wait = 15 * attempt;
        log.warn(
          `⚠️ Login 429 rate-limit (attempt ${attempt}/${STOCKBIT.MAX_LOGIN_ATTEMPTS}) — tunggu ${wait}s...`
        );
        if (attempt < STOCKBIT.MAX_LOGIN_ATTEMPTS) {
          await sleep(wait * 1000);
        }
        continue;
      }

      // 4xx selain 429: credentials salah, jangan retry
      if (status && status >= 400 && status < 500) {
        const msg = err.response?.data
          ? JSON.stringify(err.response.data).substring(0, 200)
          : err.message;
        log.error(`❌ Login HTTP ${status}: ${msg}`);
        return null;
      }

      // 5xx atau network error: retry
      const errMsg = status ? `HTTP ${status}` : err.code || err.message;
      log.warn(
        `⚠️ Login error (attempt ${attempt}/${STOCKBIT.MAX_LOGIN_ATTEMPTS}): ${errMsg}`
      );
      if (attempt < STOCKBIT.MAX_LOGIN_ATTEMPTS) {
        await sleep(attempt * 3000);
      }
    }
  }

  log.error(`❌ Login gagal setelah ${STOCKBIT.MAX_LOGIN_ATTEMPTS} percobaan`);
  return null;
}

// ---------------------------------------------------------------------------
// WS Trading Key
// ---------------------------------------------------------------------------

/**
 * Ambil WS Trading Key dari API Stockbit.
 * Key ini diperlukan untuk autentikasi WebSocket (Tag 3 di protobuf).
 * @returns {Promise<string|null>}
 */
async function getWsTradingKey() {
  if (!_jwtToken) {
    log.warn('⚠️ Belum ada JWT token — tidak bisa ambil WS key');
    return null;
  }

  try {
    const response = await axios.get(STOCKBIT.WS_KEY_URL, {
      headers: {
        ...STOCKBIT.LOGIN_HEADERS,
        Authorization: `Bearer ${_jwtToken}`,
      },
      timeout: 15_000,
    });

    const key = response.data?.data?.key || response.data?.key || '';
    if (!key) {
      log.warn('⚠️ WS Trading Key tidak ditemukan di response');
      log.debug('   Response:', JSON.stringify(response.data).substring(0, 300));
      return null;
    }

    _wsKey = key;
    log.info(`✅ WS Trading Key diperoleh (${key.length} karakter)`);
    return key;

  } catch (err) {
    const status = err.response?.status;
    log.warn(`⚠️ Gagal ambil WS Key: ${status || err.code || err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: Orchestrator — dapatkan semua credential yang dibutuhkan
// ---------------------------------------------------------------------------

/**
 * Dapatkan semua credential yang dibutuhkan untuk koneksi WebSocket.
 * Urutan: cache → env → login → ws_key.
 * @returns {Promise<{jwtToken: string, wsKey: string, userId: string}|null>}
 */
async function getCredentials() {
  const token = await loginViaApi();
  if (!token) return null;

  const wsKey = await getWsTradingKey();
  // wsKey bisa null — kita tetap coba konek tanpa wsKey sebagai fallback

  return {
    jwtToken: _jwtToken,
    wsKey: _wsKey || '',
    userId: _userId || '',
  };
}

/**
 * Force refresh semua credential (dipanggil saat Error 401 dari WebSocket).
 * Menghapus cache dan memaksa login ulang.
 * @returns {Promise<{jwtToken: string, wsKey: string, userId: string}|null>}
 */
async function forceRefreshCredentials() {
  log.warn('🔄 Force refresh credentials (kemungkinan token expired/revoked)...');
  _jwtToken = null;
  _jwtExpiry = 0;
  _wsKey = null;
  _userId = null;
  return getCredentials();
}

/**
 * Cek apakah token saat ini masih valid.
 * @returns {boolean}
 */
function isCurrentTokenValid() {
  return _jwtToken ? isTokenValid(_jwtToken) : false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getCredentials,
  forceRefreshCredentials,
  isCurrentTokenValid,
  decodeJwtPayload,
};
