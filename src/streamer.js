// =============================================================================
// STREAMER — WebSocket Connection Manager
// =============================================================================
// Modul ini mengelola koneksi WebSocket ke Stockbit:
//   - Handshake & autentikasi menggunakan Protobuf manual
//   - Heartbeat (Ping setiap 5 detik)
//   - Watchdog (Force reconnect jika 10 detik sunyi)
//   - Auto-reconnect dengan exponential backoff
//   - Penanganan Error 401 (trigger re-auth)
// =============================================================================

const WebSocket = require('ws');
const EventEmitter = require('events');
const { STOCKBIT, CONNECTION } = require('./config');
const { getCredentials, forceRefreshCredentials } = require('./auth');
const { decodeMessage } = require('./decoder');
const { createLogger } = require('./logger');

const log = createLogger('WS');

// ---------------------------------------------------------------------------
// Protobuf Encoder Helpers — Membuat pesan biner untuk dikirim ke server
// ---------------------------------------------------------------------------

/**
 * Encode integer menjadi varint bytes.
 */
function encodeVarint(value) {
  const bytes = [];
  value = value >>> 0; // Pastikan unsigned
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Encode string field: [tag | wire_type=2] [length] [utf8 bytes]
 */
function encodeStringField(fieldNumber, value) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const valueBytes = Buffer.from(value, 'utf-8');
  const length = encodeVarint(valueBytes.length);
  return Buffer.concat([tag, length, valueBytes]);
}

/**
 * Encode nested message field: [tag | wire_type=2] [length] [inner bytes]
 */
function encodeBytesField(fieldNumber, innerBuf) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const length = encodeVarint(innerBuf.length);
  return Buffer.concat([tag, length, innerBuf]);
}

/**
 * Bangun pesan autentikasi WebSocket (Protobuf manual).
 * Struktur: { userId=1, key=3, accessToken=5 }
 */
function buildAuthMessage(userId, wsKey, jwtToken) {
  const parts = [];
  if (userId) parts.push(encodeStringField(1, userId));
  if (wsKey) parts.push(encodeStringField(3, wsKey));
  if (jwtToken) parts.push(encodeStringField(5, jwtToken));
  return Buffer.concat(parts);
}

/**
 * Bangun pesan subscribe channel (Protobuf manual).
 * Struktur: { userId=1, channel=2{ runningTradeBatch=5: "*" }, key=3, accessToken=5 }
 */
function buildSubscribeMessage(userId, wsKey, jwtToken) {
  // Channel inner: Tag 5 = "*" (runningTradeBatch = semua saham)
  const channelInner = encodeStringField(5, '*');

  const parts = [];
  if (userId) parts.push(encodeStringField(1, userId));
  parts.push(encodeBytesField(2, channelInner)); // channel
  if (wsKey) parts.push(encodeStringField(3, wsKey));
  if (jwtToken) parts.push(encodeStringField(5, jwtToken));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Streamer Class
// ---------------------------------------------------------------------------

class Streamer extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._credentials = null;

    // State
    this._isConnecting = false;
    this._reconnectAttempt = 0;
    this._lastDataTime = Date.now();

    // Timers
    this._pingInterval = null;
    this._watchdogInterval = null;
    this._reconnectTimeout = null;

    // Stats
    this._totalMessages = 0;
    this._totalTrades = 0;
    this._connectTime = 0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Mulai koneksi ke Stockbit WebSocket.
   * Mengambil credentials, konek, auth, subscribe.
   */
  async start() {
    if (this._isConnecting) {
      log.warn('⚠️ Koneksi sedang berlangsung, skip duplikat');
      return;
    }

    this._isConnecting = true;

    try {
      // 1. Dapatkan credentials
      log.info('🔐 Mengambil credentials...');
      this._credentials = await getCredentials();
      if (!this._credentials) {
        log.error('❌ Gagal mendapatkan credentials. Retry dalam 10 detik...');
        this._isConnecting = false;
        this._scheduleReconnect(10_000);
        return;
      }

      // 2. Buka WebSocket
      log.info(`🔌 Menghubungkan ke ${STOCKBIT.WS_URL}...`);
      this._ws = new WebSocket(STOCKBIT.WS_URL, {
        headers: {
          'User-Agent': STOCKBIT.LOGIN_HEADERS['User-Agent'],
          Origin: 'https://stockbit.com',
        },
      });

      // Event handlers
      this._ws.on('open', () => this._onOpen());
      this._ws.on('message', (data) => this._onMessage(data));
      this._ws.on('close', (code, reason) => this._onClose(code, reason));
      this._ws.on('error', (err) => this._onError(err));

    } catch (err) {
      log.error(`❌ Gagal inisialisasi koneksi: ${err.message}`);
      this._isConnecting = false;
      this._scheduleReconnect();
    }
  }

  /**
   * Hentikan koneksi dan semua timer.
   */
  stop() {
    log.info('🛑 Menghentikan streamer...');
    this._clearAllTimers();

    if (this._ws) {
      this._ws.removeAllListeners();
      if (this._ws.readyState === WebSocket.OPEN ||
          this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close(1000, 'Manual stop');
      }
      this._ws = null;
    }

    this._isConnecting = false;
    this._reconnectAttempt = 0;
  }

  /**
   * Apakah WebSocket sedang terhubung?
   */
  get isConnected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  // -------------------------------------------------------------------------
  // Private: WebSocket Event Handlers
  // -------------------------------------------------------------------------

  _onOpen() {
    this._isConnecting = false;
    this._connectTime = Date.now();
    log.info('✅ WebSocket terhubung!');

    const { userId, wsKey, jwtToken } = this._credentials;

    // 3. Kirim pesan autentikasi
    const authMsg = buildAuthMessage(userId, wsKey, jwtToken);
    this._ws.send(authMsg);
    log.info('📤 Pesan autentikasi terkirim');

    // 4. Kirim subscribe Running Trade (semua saham)
    setTimeout(() => {
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      const subMsg = buildSubscribeMessage(userId, wsKey, jwtToken);
      this._ws.send(subMsg);
      log.info('📤 Subscribe Running Trade (Global: *) terkirim');

      // 5. Mulai heartbeat & watchdog
      this._startHeartbeat();
      this._startWatchdog();

      // Reset reconnect counter setelah koneksi stabil
      this._reconnectAttempt = 0;

      this.emit('connected');
    }, 500); // Delay 500ms agar auth sempat diproses server
  }

  _onMessage(data) {
    this._lastDataTime = Date.now();
    this._totalMessages++;

    try {
      const result = decodeMessage(data);

      if (result.type === 'runningTrade' && result.trades?.length > 0) {
        this._totalTrades += result.trades.length;

        // Emit setiap trade ke Analytics Engine
        for (const trade of result.trades) {
          this.emit('trade', trade);
        }
      }
      // Pesan lain (ping response, etc.) diabaikan secara diam-diam
    } catch (err) {
      log.debug(`⚠️ Gagal decode pesan: ${err.message}`);
    }
  }

  _onClose(code, reason) {
    const reasonStr = reason?.toString() || 'unknown';
    log.warn(`🔌 WebSocket ditutup (code: ${code}, reason: ${reasonStr})`);

    this._isConnecting = false;
    this._clearAllTimers();
    this.emit('disconnected', code);

    // Jangan reconnect jika ditutup manual (code 1000)
    if (code === 1000) return;

    // Reconnect otomatis
    this._scheduleReconnect();
  }

  _onError(err) {
    log.error(`❌ WebSocket error: ${err.message}`);
    // Event 'close' akan otomatis dipanggil setelah error
  }

  // -------------------------------------------------------------------------
  // Private: Heartbeat & Watchdog
  // -------------------------------------------------------------------------

  _startHeartbeat() {
    this._clearTimer('_pingInterval');

    this._pingInterval = setInterval(() => {
      if (this._ws?.readyState !== WebSocket.OPEN) return;

      try {
        // Kirim ping sederhana (WebSocket-level ping)
        // Dimatikan sementara karena server Stockbit memutus koneksi (Code 1006)
        // jika dikirimi ping manual. ws-library akan otomatis merespon
        // incoming ping dari server.
        // this._ws.ping(); 
      } catch {
        log.warn('⚠️ Gagal kirim ping');
      }
    }, CONNECTION.PING_INTERVAL_MS);
  }

  _startWatchdog() {
    this._clearTimer('_watchdogInterval');

    this._watchdogInterval = setInterval(() => {
      const silenceMs = Date.now() - this._lastDataTime;

      if (silenceMs > CONNECTION.WATCHDOG_TIMEOUT_MS) {
        log.warn(
          `⏰ Watchdog: ${(silenceMs / 1000).toFixed(1)}s tanpa data ` +
          `(batas: ${CONNECTION.WATCHDOG_TIMEOUT_MS / 1000}s). Force reconnect!`
        );
        this._forceReconnect();
      }
    }, 1000); // Cek setiap 1 detik
  }

  // -------------------------------------------------------------------------
  // Private: Reconnection Logic
  // -------------------------------------------------------------------------

  async _forceReconnect() {
    this._clearAllTimers();

    if (this._ws) {
      this._ws.removeAllListeners();
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }

    this._isConnecting = false;

    // Cek apakah perlu refresh credentials (misal token expired)
    const { isCurrentTokenValid } = require('./auth');
    if (!isCurrentTokenValid()) {
      log.warn('🔄 Token tidak valid, meminta token baru...');
      const newCreds = await forceRefreshCredentials();
      if (!newCreds) {
        log.error('❌ Gagal refresh token. Retry dalam 30 detik...');
        this._scheduleReconnect(30_000);
        return;
      }
    }

    // Reconnect segera
    this.start();
  }

  _scheduleReconnect(customDelayMs) {
    this._clearTimer('_reconnectTimeout');

    if (this._reconnectAttempt >= CONNECTION.MAX_RECONNECT_ATTEMPTS) {
      log.error(
        `❌ Menyerah setelah ${CONNECTION.MAX_RECONNECT_ATTEMPTS}x reconnect. ` +
        `Restart manual diperlukan.`
      );
      this.emit('fatal', new Error('Max reconnect exceeded'));
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ...
    const delay = customDelayMs ||
      CONNECTION.BASE_RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempt);
    this._reconnectAttempt++;

    log.info(
      `🔄 Reconnect #${this._reconnectAttempt} dalam ${(delay / 1000).toFixed(1)}s...`
    );

    this._reconnectTimeout = setTimeout(() => {
      this.start();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Private: Timer Management
  // -------------------------------------------------------------------------

  _clearTimer(name) {
    if (this[name]) {
      if (name.includes('Interval')) clearInterval(this[name]);
      else clearTimeout(this[name]);
      this[name] = null;
    }
  }

  _clearAllTimers() {
    this._clearTimer('_pingInterval');
    this._clearTimer('_watchdogInterval');
    this._clearTimer('_reconnectTimeout');
  }

  // -------------------------------------------------------------------------
  // Public: Diagnostik
  // -------------------------------------------------------------------------

  getStats() {
    const uptimeMs = this._connectTime ? Date.now() - this._connectTime : 0;
    return {
      connected: this.isConnected,
      uptimeMinutes: (uptimeMs / 60_000).toFixed(1),
      totalMessages: this._totalMessages,
      totalTrades: this._totalTrades,
      reconnectAttempt: this._reconnectAttempt,
      lastDataAgo: `${((Date.now() - this._lastDataTime) / 1000).toFixed(1)}s`,
    };
  }
}

module.exports = Streamer;
