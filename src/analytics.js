// =============================================================================
// ANALYTICS ENGINE — Otak Sistem: Deteksi Whale, Momentum & Distribusi
// =============================================================================
// Modul ini menerima setiap trade dari Streamer, menyimpannya di RAM
// menggunakan Sliding Window (60 detik), lalu menghitung metrik:
//   1. Order Flow Imbalance (OFI) — dominasi HK vs HAKI
//   2. Smart Money Footprint    — deteksi block trade raksasa
//   3. Rapid Momentum           — frekuensi HK dalam 10 detik
//
// Tidak ada database. Semua kalkulasi di memori. Data kadaluarsa dihapus
// setiap detik agar RAM tidak membengkak.
// =============================================================================

const EventEmitter = require('events');
const { ANALYTICS } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('ANALYTICS');

class AnalyticsEngine extends EventEmitter {
  constructor() {
    super();

    // ---------------------------------------------------------------------------
    // State utama: Map<symbol, Array<TradeEntry>>
    // Setiap symbol menyimpan array transaksi dalam 60 detik terakhir
    // ---------------------------------------------------------------------------
    this._windows = new Map();

    // Timer pembersihan data kadaluarsa
    this._cleanupTimer = null;

    // Statistik global
    this._stats = {
      totalProcessed: 0,
      signalsEmitted: 0,
      activeSymbols: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Mulai engine: aktifkan timer pembersihan.
   */
  start() {
    log.info('🧠 Analytics Engine aktif');
    this._cleanupTimer = setInterval(
      () => this._cleanup(),
      ANALYTICS.CLEANUP_INTERVAL_MS
    );
  }

  /**
   * Hentikan engine dan bersihkan semua data.
   */
  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._windows.clear();
    log.info('🧠 Analytics Engine berhenti');
  }

  /**
   * Proses satu trade baru dari Streamer.
   * Dipanggil setiap kali ada event 'trade'.
   * @param {Object} trade - Objek trade dari decoder
   */
  processTrade(trade) {
    if (!trade.symbol || !trade.price || !trade.lot) return;

    this._stats.totalProcessed++;
    const now = Date.now();

    // Masukkan trade ke sliding window
    const entry = {
      time: now,
      price: trade.price,
      lot: trade.lot,
      value: trade.value,
      action: trade.action,       // 1=BUY, 2=SELL
      pctChange: trade.pctChange,
      symbol: trade.symbol,
    };

    if (!this._windows.has(trade.symbol)) {
      this._windows.set(trade.symbol, []);
    }
    this._windows.get(trade.symbol).push(entry);

    // --- Deteksi 1: Single Whale Trade (setiap transaksi dicek) ---
    this._checkSingleWhale(trade);

    // --- Deteksi 2: Rapid Momentum (frekuensi tinggi) ---
    this._checkRapidMomentum(trade.symbol, now);

    // --- Deteksi 3: Institutional Buying / Distribution (OFI per menit) ---
    // Hanya cek setiap 5 trade baru per simbol agar tidak terlalu berat
    const windowData = this._windows.get(trade.symbol);
    if (windowData.length % 5 === 0) {
      this._checkOrderFlowImbalance(trade.symbol, now);
    }
  }

  /**
   * Ambil statistik engine.
   */
  getStats() {
    this._stats.activeSymbols = this._windows.size;
    return { ...this._stats };
  }

  // -------------------------------------------------------------------------
  // Private: Deteksi Sinyal
  // -------------------------------------------------------------------------

  /**
   * Deteksi 1: Apakah satu transaksi ini bernilai raksasa (Whale)?
   */
  _checkSingleWhale(trade) {
    // Hanya cek BUY (Hajar Kanan)
    if (trade.action !== 1) return;

    const value = trade.value;

    if (value >= ANALYTICS.WHALE_MEGA_TRADE_VALUE) {
      // MEGA WHALE: > Rp 1 Miliar sekali klik
      this._emitSignal('WHALE_BUY', {
        symbol: trade.symbol,
        price: trade.price,
        lot: trade.lot,
        value: value,
        pctChange: trade.pctChange,
        tier: 'MEGA',
        message: `Transaksi tunggal Rp ${this._formatRupiah(value)}`,
      });
    } else if (value >= ANALYTICS.WHALE_SINGLE_TRADE_VALUE) {
      // BIG WHALE: > Rp 250 Juta sekali klik
      this._emitSignal('WHALE_BUY', {
        symbol: trade.symbol,
        price: trade.price,
        lot: trade.lot,
        value: value,
        pctChange: trade.pctChange,
        tier: 'BIG',
        message: `Transaksi tunggal Rp ${this._formatRupiah(value)}`,
      });
    }
  }

  /**
   * Deteksi 2: Apakah ada ledakan frekuensi HK dalam 10 detik terakhir?
   */
  _checkRapidMomentum(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window) return;

    const cutoff = now - ANALYTICS.RAPID_WINDOW_MS;
    const recentBuys = window.filter(
      (t) => t.time >= cutoff && t.action === 1
    );

    if (recentBuys.length >= ANALYTICS.RAPID_MIN_FREQUENCY) {
      const totalValue = recentBuys.reduce((sum, t) => sum + t.value, 0);
      const lastTrade = recentBuys[recentBuys.length - 1];

      this._emitSignal('RAPID_MOMENTUM', {
        symbol: symbol,
        frequency: recentBuys.length,
        windowSeconds: ANALYTICS.RAPID_WINDOW_MS / 1000,
        totalValue: totalValue,
        price: lastTrade.price,
        pctChange: lastTrade.pctChange,
        message: `${recentBuys.length}x HK dalam ${ANALYTICS.RAPID_WINDOW_MS / 1000} detik`,
      });
    }
  }

  /**
   * Deteksi 3: Order Flow Imbalance — dominasi HK atau HAKI dalam 1 menit.
   */
  _checkOrderFlowImbalance(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return;

    // Hitung total nilai BUY vs SELL
    let totalBuyValue = 0;
    let totalSellValue = 0;
    let whaleCount = 0; // Jumlah block trade besar
    let totalBuyFreq = 0;

    for (const t of recent) {
      if (t.action === 1) {
        totalBuyValue += t.value;
        totalBuyFreq++;
        if (t.value >= ANALYTICS.WHALE_SINGLE_TRADE_VALUE) whaleCount++;
      } else if (t.action === 2) {
        totalSellValue += t.value;
      }
    }

    const totalValue = totalBuyValue + totalSellValue;
    if (totalValue === 0) return;

    const buyDominance = totalBuyValue / totalValue;
    const sellDominance = totalSellValue / totalValue;

    // Harga terakhir & persentase perubahan
    const lastTrade = recent[recent.length - 1];

    // --- INSTITUTIONAL BUYING ---
    if (
      buyDominance >= ANALYTICS.INSTITUTIONAL_HK_DOMINANCE &&
      totalBuyValue >= ANALYTICS.INSTITUTIONAL_MIN_VALUE &&
      Math.abs(lastTrade.pctChange) <= ANALYTICS.INSTITUTIONAL_MAX_CHANGE_PCT
    ) {
      this._emitSignal('INSTITUTIONAL_BUYING', {
        symbol: symbol,
        buyValue: totalBuyValue,
        sellValue: totalSellValue,
        netInflow: totalBuyValue - totalSellValue,
        buyDominance: buyDominance,
        buyFrequency: totalBuyFreq,
        whaleCount: whaleCount,
        price: lastTrade.price,
        pctChange: lastTrade.pctChange,
        message:
          `HK ${(buyDominance * 100).toFixed(0)}% dominasi, ` +
          `Net Inflow +Rp ${this._formatRupiah(totalBuyValue - totalSellValue)}`,
      });
    }

    // --- DISTRIBUTION WARNING ---
    if (
      sellDominance >= ANALYTICS.DISTRIBUTION_HAKI_DOMINANCE &&
      totalSellValue >= ANALYTICS.DISTRIBUTION_MIN_VALUE
    ) {
      this._emitSignal('DISTRIBUTION_WARNING', {
        symbol: symbol,
        buyValue: totalBuyValue,
        sellValue: totalSellValue,
        netOutflow: totalSellValue - totalBuyValue,
        sellDominance: sellDominance,
        price: lastTrade.price,
        pctChange: lastTrade.pctChange,
        message:
          `HAKI ${(sellDominance * 100).toFixed(0)}% dominasi, ` +
          `Net Outflow -Rp ${this._formatRupiah(totalSellValue - totalBuyValue)}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: Emit Signal
  // -------------------------------------------------------------------------

  _emitSignal(type, data) {
    this._stats.signalsEmitted++;
    this.emit('signal', { type, ...data, timestamp: new Date() });
  }

  // -------------------------------------------------------------------------
  // Private: Pembersihan Data Kadaluarsa (Garbage Collection)
  // -------------------------------------------------------------------------

  _cleanup() {
    const cutoff = Date.now() - ANALYTICS.WINDOW_DURATION_MS;
    let totalRemoved = 0;

    for (const [symbol, trades] of this._windows.entries()) {
      // Filter: hanya simpan trade yang masih dalam jendela waktu
      const before = trades.length;
      const filtered = trades.filter((t) => t.time >= cutoff);

      if (filtered.length === 0) {
        // Hapus symbol dari Map jika sudah tidak ada data
        this._windows.delete(symbol);
        totalRemoved += before;
      } else if (filtered.length < before) {
        this._windows.set(symbol, filtered);
        totalRemoved += before - filtered.length;
      }
    }

    // Log hanya jika ada yang dibersihkan (hindari spam)
    if (totalRemoved > 100) {
      log.debug(
        `🧹 Cleanup: ${totalRemoved} trade expired dihapus, ` +
        `${this._windows.size} simbol aktif`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: Helpers
  // -------------------------------------------------------------------------

  _formatRupiah(value) {
    if (value >= 1_000_000_000_000) return `${(value / 1e12).toFixed(1)} T`;
    if (value >= 1_000_000_000) return `${(value / 1e9).toFixed(1)} M`;
    if (value >= 1_000_000) return `${(value / 1e6).toFixed(0)} Jt`;
    if (value >= 1_000) return `${(value / 1e3).toFixed(0)} Rb`;
    return `${value}`;
  }
}

module.exports = AnalyticsEngine;
