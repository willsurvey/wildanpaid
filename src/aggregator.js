// =============================================================================
// AGGREGATOR — Signal Router & Batch Table Builder
// =============================================================================
// Duduk di antara Analytics Engine dan Notifier.
// Tugas:
//   - HIGH PRIORITY (WHALE, BSM, INSTITUTIONAL, DISTRIBUTION):
//       Langsung diteruskan ke Notifier tanpa delay.
//   - LIVE SIGNALS (MF+, GAIN, REBOUND, MF-):
//       Dikumpulkan dalam buffer per tipe.
//       Setelah 500ms tanpa sinyal baru (debounce), atau max 2 detik,
//       dikirim sebagai 1 TABEL RANGKUMAN ke Notifier.
//       Jika symbol yang sama masuk lagi → data di-UPDATE (tidak duplikat).
// =============================================================================

const { AGGREGATOR: AGG, TELEGRAM } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('AGGREGATOR');

// Tipe sinyal yang langsung dikirim individual (event langka & sangat penting)
const HP_TYPES = new Set([
  'WHALE_BUY',
  'BIG_SMART_MONEY',
  'INSTITUTIONAL_BUYING',
  'DISTRIBUTION_WARNING',
]);

// Tipe sinyal yang di-batch jadi tabel
const BATCH_TYPES = new Set([
  'LIVE_MONEY_FLOW',
  'LIVE_GAIN',
  'LIVE_REBOUND',
  'LIVE_MF_MINUS',
]);

class Aggregator {
  constructor(notifier) {
    this._notifier = notifier;

    // Buffer per tipe: Map<symbol, signalData> — deduplicate otomatis
    this._buffers = {};
    // Debounce timer per tipe
    this._timers = {};
    // Waktu mulai buffer per tipe (untuk MAX_WAIT_MS)
    this._bufferStart = {};

    for (const type of BATCH_TYPES) {
      this._buffers[type] = new Map();
      this._timers[type]  = null;
      this._bufferStart[type] = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Public: Terima sinyal dari Analytics Engine
  // -------------------------------------------------------------------------

  /**
   * Route sinyal ke jalur yang sesuai.
   * @param {Object} signal - Sinyal dari Analytics Engine
   */
  route(signal) {
    const { type } = signal;

    if (HP_TYPES.has(type)) {
      // High Priority: teruskan langsung tanpa delay
      this._notifier.sendHighPriority(signal);

    } else if (BATCH_TYPES.has(type)) {
      // Batch: kumpulkan dulu, kirim sebagai tabel
      this._addToBuffer(signal);

    } else {
      log.warn(`⚠️ Tipe sinyal tidak dikenal: ${type}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private: Buffer & Debounce
  // -------------------------------------------------------------------------

  _addToBuffer(signal) {
    const { type, symbol } = signal;
    const buf = this._buffers[type];

    // Catat waktu pertama kali buffer menerima data (untuk max-wait)
    if (buf.size === 0) {
      this._bufferStart[type] = Date.now();
    }

    // Update atau insert — satu baris per symbol (dedup)
    buf.set(symbol, signal);

    // Reset debounce timer
    if (this._timers[type]) {
      clearTimeout(this._timers[type]);
      this._timers[type] = null;
    }

    // Jika sudah menunggu terlalu lama (MAX_WAIT_MS), paksa flush sekarang
    const elapsed = Date.now() - this._bufferStart[type];
    const delay = elapsed >= AGG.MAX_WAIT_MS ? 0 : AGG.DEBOUNCE_MS;

    this._timers[type] = setTimeout(() => this._flush(type), delay);
  }

  _flush(type) {
    const buf = this._buffers[type];
    if (buf.size === 0) return;

    const signals = Array.from(buf.values());

    // Bersihkan buffer sebelum async send (hindari race condition)
    buf.clear();
    this._timers[type] = null;
    this._bufferStart[type] = 0;

    log.info(`📊 Flush [${type}]: ${signals.length} saham → 1 tabel`);

    // Sort berdasarkan tipe
    const sorted = this._sort(type, signals);

    // Ambil top N
    const top = sorted.slice(0, AGG.MAX_TABLE_ROWS);

    // Kirim ke notifier sebagai tabel rangkuman
    this._notifier.sendTable(type, top);
  }

  _sort(type, signals) {
    switch (type) {
      case 'LIVE_MONEY_FLOW':
        // Sort: net inflow terbesar di atas
        return signals.sort((a, b) => b.netInflow - a.netInflow);

      case 'LIVE_GAIN':
        // Sort: kenaikan harga terbesar, lalu net inflow sebagai tiebreaker
        return signals.sort((a, b) =>
          b.pctChange - a.pctChange || b.netInflow - a.netInflow
        );

      case 'LIVE_REBOUND':
        // Sort: net inflow terbesar (yang paling aktif dibeli dari bottom)
        return signals.sort((a, b) => b.netInflow - a.netInflow);

      case 'LIVE_MF_MINUS':
        // Sort: net outflow terbesar (paling negatif) di atas
        return signals.sort((a, b) => a.netInflow - b.netInflow);

      default:
        return signals;
    }
  }
}

module.exports = Aggregator;
