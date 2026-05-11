// =============================================================================
// ANALYTICS ENGINE — Otak Sistem: Deteksi Whale, Momentum & Distribusi
// =============================================================================
// Modul ini menerima setiap trade dari Streamer, menyimpannya di RAM
// menggunakan Sliding Window (60 detik), lalu menghitung metrik:
//   1. Order Flow Imbalance (OFI) — dominasi HK vs HAKI
//   2. Smart Money Footprint    — deteksi block trade raksasa
//   3. Rapid Momentum           — frekuensi HK dalam 10 detik
//   4. Live Money Flow +        — aliran dana masuk real-time
//   5. Live Gain                — saham yang tengah naik
//   6. Live Rebound             — pantulan dari harga terendah
//   7. Live MF-                 — aliran dana keluar real-time
//   8. Big Smart Money Trigger  — akumulasi paus besar-besaran
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

    // Track riwayat sinyal untuk fitur Live (semua diinisialisasi di constructor)
    this._signalHistory = new Map();        // Live Money Flow +
    this._signalHistoryGain = new Map();    // Live Gain
    this._signalHistoryRebound = new Map(); // Live Rebound
    this._signalHistoryOutFlow = new Map(); // Live MF-

    // Track session lows per saham (untuk Rebound detection)
    this._sessionLows = new Map();

    // Akumulasi harian per saham (untuk Big Smart Money)
    this._dailyStats = new Map();

    // Guard: timestamp terakhir kali windowed-analysis dijalankan per saham
    // Mencegah 6 sinyal meledak bersamaan untuk 1 saham (throttle 2 detik)
    this._lastCheckTime = new Map();

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
   * Reset state harian — dipanggil setiap pukul 09:00 WIB oleh scheduler.
   * Membersihkan: daily stats, session lows, dan riwayat sinyal.
   * Dengan cara ini, data "09:00 - Now" pada BIG_SMART_MONEY selalu akurat.
   */
  resetDailyState() {
    const count = this._dailyStats.size;
    this._dailyStats.clear();
    this._sessionLows.clear();
    this._signalHistory.clear();
    this._signalHistoryGain.clear();
    this._signalHistoryRebound.clear();
    this._signalHistoryOutFlow.clear();
    this._lastCheckTime.clear();
    // Juga reset _windows agar tidak membawa data kemarin
    this._windows.clear();
    this._stats.totalProcessed = 0;
    this._stats.signalsEmitted = 0;
    // Catat waktu reset untuk warmup period (10 menit)
    this._warmupStart = Date.now();
    log.info(`🌅 Daily state di-reset. ${count} simbol dihapus. Warmup 10 menit aktif. Siap sesi baru.`);
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

    // Track Session Lows — hanya set jika belum ada ATAU lebih rendah
    if (!this._sessionLows.has(trade.symbol)) {
      this._sessionLows.set(trade.symbol, trade.price);
    } else {
      const currentLow = this._sessionLows.get(trade.symbol);
      if (trade.price < currentLow) {
        this._sessionLows.set(trade.symbol, trade.price);
      }
    }

    // Update Daily Stats (akumulasi total buy/sell per saham)
    if (!this._dailyStats.has(trade.symbol)) {
      this._dailyStats.set(trade.symbol, { smartMoney: 0, badMoney: 0, triggerCount: 0, totalValue: 0 });
    }
    const dStat = this._dailyStats.get(trade.symbol);
    dStat.totalValue += trade.value;                              // total transaksi harian
    if (trade.action === 1) dStat.smartMoney += trade.value;
    else if (trade.action === 2) dStat.badMoney += trade.value;

    // --- Deteksi 1: Single Whale Trade (setiap transaksi dicek) ---
    this._checkSingleWhale(trade);

    // --- Deteksi 2: Rapid Momentum (DINONAKTIFKAN — terlalu berisik) ---
    // if (ANALYTICS.RAPID_ENABLED) this._checkRapidMomentum(trade.symbol, now);

    // --- Deteksi 3-8: Windowed analysis ---
    // Guard: throttle 5 detik per saham (dari 2 detik) agar sinyal tidak meledak
    const lastCheck = this._lastCheckTime.get(trade.symbol) || 0;
    if (now - lastCheck >= ANALYTICS.WINDOWED_THROTTLE_MS) {
      this._lastCheckTime.set(trade.symbol, now);
      this._runWindowedAnalysis(trade.symbol, now);
    }
  }

  /**
   * Windowed analysis dengan SISTEM PRIORITAS HIRARKI.
   * 
   * Aturan:
   *   - Sisi BUY: BIG_SMART > INSTITUTIONAL > LIVE_MF+ > LIVE_GAIN
   *     Jika BIG_SMART_MONEY trigger, INSTITUTIONAL/MF+/GAIN TIDAK dikirim.
   *   - Sisi SELL: DISTRIBUTION > LIVE_MF-
   *     Jika DISTRIBUTION trigger, LIVE_MF- TIDAK dikirim.
   *   - LIVE_REBOUND: Independen (fase berbeda), tapi ada warmup 10 menit
   *     setelah reset harian agar session low punya waktu terbentuk.
   *   - RAPID_MOMENTUM & WHALE_BUY: Sudah independen (dicheck di luar).
   */
  _runWindowedAnalysis(symbol, now) {
    // === SISI BELI (Hirarki: Big Smart > Institutional > MF+ > Gain) ===
    let buyHandled = false;

    // Tier 1: Big Smart Money (paling kuat)
    if (this._checkBigSmartMoney(symbol, now)) {
      buyHandled = true;
    }

    // Tier 2: Institutional Buying
    if (!buyHandled && this._checkOrderFlowImbalance(symbol, now)) {
      buyHandled = true;
    }

    // Tier 3: Live Money Flow +
    if (!buyHandled) {
      this._checkLiveMoneyFlow(symbol, now);
    }

    // Tier 4: Live Gain (paling longgar — hanya jika tidak ada sinyal buy lain)
    if (!buyHandled) {
      this._checkLiveGain(symbol, now);
    }

    // === SISI JUAL (Hirarki: Distribution > MF-) ===
    // Sisi jual independen dari sisi beli — keduanya bisa muncul bersamaan
    // (walau jarang) karena window 60 detik bisa berisi campuran buy/sell.
    // Tapi Distribution dan MF- tidak boleh muncul bersamaan.
    if (!this._checkDistributionWarning(symbol, now)) {
      this._checkLiveMoneyOutFlow(symbol, now);
    }

    // === LIVE REBOUND: Independen ===
    // Hanya aktif setelah warmup 10 menit dari reset harian,
    // agar session low punya waktu terbentuk dan tidak false positive.
    if (!this._warmupStart || now - this._warmupStart >= 10 * 60 * 1000) {
      this._checkLiveRebound(symbol, now);
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
   * Deteksi 3a: Institutional Buying — dominasi HK dalam 1 menit.
   * @returns {boolean} true jika sinyal terkirim
   */
  _checkOrderFlowImbalance(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return false;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return false;

    let totalBuyValue = 0;
    let totalSellValue = 0;
    let whaleCount = 0;
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
    if (totalValue === 0) return false;

    const buyDominance = totalBuyValue / totalValue;
    const lastTrade = recent[recent.length - 1];

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
      return true;
    }

    return false;
  }

  /**
   * Deteksi 3b: Distribution Warning — dominasi HAKI dalam 1 menit.
   * @returns {boolean} true jika sinyal terkirim
   */
  _checkDistributionWarning(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return false;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return false;

    let totalBuyValue = 0;
    let totalSellValue = 0;

    for (const t of recent) {
      if (t.action === 1) totalBuyValue += t.value;
      else if (t.action === 2) totalSellValue += t.value;
    }

    const totalValue = totalBuyValue + totalSellValue;
    if (totalValue === 0) return false;

    const sellDominance = totalSellValue / totalValue;
    const lastTrade = recent[recent.length - 1];

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
      return true;
    }

    return false;
  }

  /**
   * Deteksi 4: Live Money Flow + (Deteksi aliran dana masuk secara real-time)
   * Trigger: Net Inflow >= 100 Jt dan dominasi HK >= 60% dalam 1 menit.
   */
  _checkLiveMoneyFlow(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return;

    // Filter: saham harus punya transaksi harian minimal (bukan saham sepi)
    const dStat = this._dailyStats.get(symbol);
    if (!dStat || dStat.totalValue < ANALYTICS.LIVE_DAILY_MIN_VALUE) return;

    let totalBuyValue = 0;
    let totalSellValue = 0;

    for (const t of recent) {
      if (t.action === 1) totalBuyValue += t.value;
      else if (t.action === 2) totalSellValue += t.value;
    }

    const netInflow = totalBuyValue - totalSellValue;
    const totalValue = totalBuyValue + totalSellValue;
    
    if (totalValue === 0) return;
    const buyDominance = totalBuyValue / totalValue;
    const isLiquid = totalValue >= ANALYTICS.LIVE_MIN_VALUE;

    // Filter wajib liquid + threshold ketat
    if (!isLiquid) return;
    if (netInflow < ANALYTICS.LIVE_NET_INFLOW_MIN) return;
    if (buyDominance < ANALYTICS.LIVE_BUY_DOMINANCE) return;

    const lastTrade = recent[recent.length - 1];
    const isGembel = lastTrade.price < 200;
    
    const history = this._signalHistory.get(symbol);
    let emoji = '';
    
    if (!history) {
      emoji = isGembel ? '⭐️' : '💧';
    } else {
      const diff = now - history.lastTime;
      if (diff < 60_000) {
        emoji = '🔥';
      } else {
        emoji = isGembel ? '🌟' : '💦';
      }
    }
    
    this._signalHistory.set(symbol, { lastTime: now });

    this._emitSignal('LIVE_MONEY_FLOW', {
      symbol: symbol,
      price: lastTrade.price,
      netInflow: netInflow,
      totalValue: totalValue,
      buyDominance: buyDominance,
      emoji: emoji,
      isLiquid: isLiquid,
      isGembel: isGembel,
      pctChange: lastTrade.pctChange,
      smartMoneyTotal: dStat.smartMoney,
      badMoneyTotal: dStat.badMoney,
    });
  }

  /**
   * Deteksi 5: Live Gain (Deteksi saham yang tengah naik)
   * Trigger: Harga naik dalam window 60 detik DAN pctChange > 0
   *          DAN total value transaksi > 50 Juta.
   */
  _checkLiveGain(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return;

    // Filter: saham harus punya transaksi harian minimal
    const dStat = this._dailyStats.get(symbol);
    if (!dStat || dStat.totalValue < ANALYTICS.LIVE_DAILY_MIN_VALUE) return;

    const firstTrade = recent[0];
    const lastTrade = recent[recent.length - 1];

    if (lastTrade.price > firstTrade.price && lastTrade.pctChange > 0) {
      let totalBuyValue = 0;
      let totalSellValue = 0;
      for (const t of recent) {
        if (t.action === 1) totalBuyValue += t.value;
        else if (t.action === 2) totalSellValue += t.value;
      }
      
      const netInflow = totalBuyValue - totalSellValue;
      const totalValue = totalBuyValue + totalSellValue;
      const isLiquid = totalValue >= ANALYTICS.LIVE_MIN_VALUE;
      const isGembel = lastTrade.price < 200;
      
      // Filter: wajib liquid, nilai transaksi harus besar
      if (!isLiquid) return;
      if (totalValue < ANALYTICS.LIVE_MIN_VALUE) return;

      const history = this._signalHistoryGain.get(symbol);
      let emoji = '';
      
      if (!history) {
        emoji = isGembel ? '⭐️' : '💧';
      } else {
        const diff = now - history.lastTime;
        if (diff < 60_000) emoji = '🔥';
        else emoji = isGembel ? '🌟' : '💦';
      }
      
      this._signalHistoryGain.set(symbol, { lastTime: now });

      this._emitSignal('LIVE_GAIN', {
        symbol: symbol,
        price: lastTrade.price,
        netInflow: netInflow,
        totalValue: totalValue,
        emoji: emoji,
        isLiquid: isLiquid,
        isGembel: isGembel,
        pctChange: lastTrade.pctChange,
        smartMoneyTotal: dStat.smartMoney,
        badMoneyTotal: dStat.badMoney,
      });
    }
  }

  /**
   * Deteksi 6: Live Rebound (Pantulan naik dari harga terendah)
   * Trigger: Harga sedang naik dari posisi dekat session low (toleransi 3%)
   *          DAN volume transaksi > 50 Juta.
   * Emoji 🥵: Pernah rebound, turun lagi menembus low, lalu rebound lagi.
   */
  _checkLiveRebound(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return;

    // Filter: saham harus punya transaksi harian minimal
    const dStat = this._dailyStats.get(symbol);
    if (!dStat || dStat.totalValue < ANALYTICS.LIVE_DAILY_MIN_VALUE) return;

    const firstTrade = recent[0];
    const lastTrade = recent[recent.length - 1];
    const sessionLow = this._sessionLows.get(symbol) || lastTrade.price;

    const history = this._signalHistoryRebound.get(symbol);
    if (history && lastTrade.price < history.lowAtSignal) {
      history.hasDroppedBelow = true;
    }

    const isBouncing = lastTrade.price > firstTrade.price;
    const isNearBottom = lastTrade.price <= sessionLow * 1.03;

    if (isBouncing && isNearBottom) {
      let totalBuyValue = 0;
      let totalSellValue = 0;
      for (const t of recent) {
        if (t.action === 1) totalBuyValue += t.value;
        else if (t.action === 2) totalSellValue += t.value;
      }
      
      const netInflow = totalBuyValue - totalSellValue;
      const totalValue = totalBuyValue + totalSellValue;
      const isLiquid = totalValue >= ANALYTICS.LIVE_MIN_VALUE;
      const isGembel = lastTrade.price < 200;
      
      // Filter: wajib liquid
      if (!isLiquid) return;

      let emoji = '';
      if (!history) {
        emoji = isGembel ? '⭐️' : '💧';
      } else {
        if (history.hasDroppedBelow) {
          emoji = '🥵';
        } else {
          const diff = now - history.lastTime;
          if (diff < 60_000) emoji = '🔥';
          else emoji = isGembel ? '🌟' : '💦';
        }
      }
      
      this._signalHistoryRebound.set(symbol, { 
        lastTime: now,
        lowAtSignal: sessionLow,
        hasDroppedBelow: false 
      });

      this._emitSignal('LIVE_REBOUND', {
        symbol: symbol,
        price: lastTrade.price,
        netInflow: netInflow,
        totalValue: totalValue,
        emoji: emoji,
        isLiquid: isLiquid,
        isGembel: isGembel,
        pctChange: lastTrade.pctChange,
        smartMoneyTotal: dStat.smartMoney,
        badMoneyTotal: dStat.badMoney,
      });
    }
  }

  /**
   * Deteksi 7: Live Money OutFlow (Deteksi aliran dana keluar secara real-time)
   * Trigger: Net Outflow >= 100 Juta dan dominasi HAKI >= 60% dalam 1 menit.
   */
  _checkLiveMoneyOutFlow(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return;

    // Filter: saham harus punya transaksi harian minimal
    const dStat = this._dailyStats.get(symbol);
    if (!dStat || dStat.totalValue < ANALYTICS.LIVE_DAILY_MIN_VALUE) return;

    let totalBuyValue = 0;
    let totalSellValue = 0;

    for (const t of recent) {
      if (t.action === 1) totalBuyValue += t.value;
      else if (t.action === 2) totalSellValue += t.value;
    }

    const netInflow = totalBuyValue - totalSellValue;
    const totalValue = totalBuyValue + totalSellValue;
    
    if (totalValue === 0) return;
    const sellDominance = totalSellValue / totalValue;
    const isLiquid = totalValue >= ANALYTICS.LIVE_MIN_VALUE;

    // Filter: wajib liquid + threshold ketat
    if (!isLiquid) return;
    if (netInflow > -ANALYTICS.LIVE_NET_INFLOW_MIN) return;     // outflow harus cukup besar
    if (sellDominance < ANALYTICS.LIVE_BUY_DOMINANCE) return;

    const lastTrade = recent[recent.length - 1];
    const isGembel = lastTrade.price < 200;
    
    const history = this._signalHistoryOutFlow.get(symbol);
    let emoji = '';
    
    if (!history) {
      emoji = isGembel ? '⭐️' : '💧';
    } else {
      const diff = now - history.lastTime;
      if (diff < 60_000) emoji = '🔥';
      else emoji = isGembel ? '🌟' : '💦';
    }
    
    this._signalHistoryOutFlow.set(symbol, { lastTime: now });

    this._emitSignal('LIVE_MF_MINUS', {
      symbol: symbol,
      price: lastTrade.price,
      netInflow: netInflow,
      totalValue: totalValue,
      emoji: emoji,
      isLiquid: isLiquid,
      isGembel: isGembel,
      pctChange: lastTrade.pctChange,
      smartMoneyTotal: dStat.smartMoney,
      badMoneyTotal: dStat.badMoney,
    });
  }

  /**
   * Deteksi 8: Big Smart Money Trigger
   * Trigger: Net Inflow >= 500 Juta dan dominasi HK >= 70% dalam 1 menit.
   * @returns {boolean} true jika sinyal terkirim
   */
  _checkBigSmartMoney(symbol, now) {
    const window = this._windows.get(symbol);
    if (!window || window.length < 5) return false;

    const cutoff = now - ANALYTICS.WINDOW_DURATION_MS;
    const recent = window.filter((t) => t.time >= cutoff);
    if (recent.length < 3) return false;

    let totalBuy = 0, totalSell = 0;
    for (const t of recent) {
      if (t.action === 1) totalBuy += t.value;
      else if (t.action === 2) totalSell += t.value;
    }

    const netInflow = totalBuy - totalSell;
    const totalVal = totalBuy + totalSell;
    
    if (totalVal === 0) return false;
    const buyDominance = totalBuy / totalVal;

    // Threshold: Net Inflow >= 500 Juta and Dominasi >= 70% in 1 minute
    if (netInflow >= 500_000_000 && buyDominance >= 0.70) {
      const dStat = this._dailyStats.get(symbol);
      dStat.triggerCount += 1;
      
      const lastTrade = recent[recent.length - 1];
      
      this._emitSignal('BIG_SMART_MONEY', {
        symbol: symbol,
        price: lastTrade.price,
        pctChange: lastTrade.pctChange,
        freq: recent.length,
        valueWindow: totalVal,
        netInflowWindow: netInflow,
        avgMfWindow: totalVal / recent.length,
        smartMoneyTotal: dStat.smartMoney,
        badMoneyTotal: dStat.badMoney,
        triggerCount: dStat.triggerCount,
        isLiquid: totalVal >= 1_000_000_000
      });
      return true;
    }
    return false;
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
    const activeSymbols = new Set();

    for (const [symbol, trades] of this._windows.entries()) {
      // Filter: hanya simpan trade yang masih dalam jendela waktu
      const before = trades.length;
      const filtered = trades.filter((t) => t.time >= cutoff);

      if (filtered.length === 0) {
        // Hapus symbol dari _windows dan SEMUA Maps terkait
        this._windows.delete(symbol);
        this._lastCheckTime.delete(symbol);
        // TIDAK hapus _signalHistory*, _sessionLows, _dailyStats:
        // data ini perlu dipertahankan sepanjang hari (direset oleh resetDailyState)
        totalRemoved += before;
      } else {
        if (filtered.length < before) {
          this._windows.set(symbol, filtered);
          totalRemoved += before - filtered.length;
        }
        activeSymbols.add(symbol);
      }
    }

    // Log hanya jika ada yang dibersihkan (hindari spam)
    if (totalRemoved > 100) {
      log.debug(
        `🧹 Cleanup: ${totalRemoved} trade expired dihapus, ` +
        `${activeSymbols.size} simbol aktif`
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
