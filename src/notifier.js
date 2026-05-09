// =============================================================================
// NOTIFIER — Telegram Bot Alert Formatter & Sender
// =============================================================================
// Modul ini menerima sinyal dari Analytics Engine, memformat menjadi
// pesan Telegram yang profesional, dan mengirimnya dengan proteksi:
//   - Cooldown per saham (5 menit, agar tidak spam)
//   - Rate limiting (max 1 pesan / 2 detik)
//   - Antrian pesan (queue) agar tidak kehilangan sinyal saat rate-limited
//   - Log sinyal ke file CSV untuk evaluasi/backtest
// =============================================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { TELEGRAM, LOG } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('TELEGRAM');

class Notifier {
  constructor() {
    // Cooldown tracker: Map<"TYPE:SYMBOL", timestamp_terakhir_alert>
    this._cooldowns = new Map();

    // Antrian pesan (FIFO)
    this._queue = [];
    this._isSending = false;

    // Stats
    this._stats = {
      totalSent: 0,
      totalBlocked: 0,
      totalErrors: 0,
    };

    // Pastikan folder log ada
    this._ensureLogDir();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Proses sinyal dari Analytics Engine.
   * Cek cooldown → format pesan → masukkan ke antrian.
   * @param {Object} signal - { type, symbol, ...data }
   */
  handleSignal(signal) {
    const { type, symbol } = signal;
    const cooldownKey = `${type}:${symbol}`;

    // Cek cooldown
    const lastAlert = this._cooldowns.get(cooldownKey) || 0;
    const elapsed = Date.now() - lastAlert;

    if (elapsed < TELEGRAM.COOLDOWN_MS) {
      const remaining = ((TELEGRAM.COOLDOWN_MS - elapsed) / 1000).toFixed(0);
      log.debug(
        `⏳ Cooldown aktif untuk ${cooldownKey} (${remaining}s tersisa)`
      );
      this._stats.totalBlocked++;
      return;
    }

    // Set cooldown baru
    this._cooldowns.set(cooldownKey, Date.now());

    // Tentukan ID Topik (Thread ID)
    let threadId = null;
    let message = null;
    switch (type) {
      case 'INSTITUTIONAL_BUYING': 
        threadId = TELEGRAM.TOPICS.INSTITUTIONAL; 
        message = this._formatInstitutionalBuying(signal);
        break;
      case 'WHALE_BUY': 
        threadId = TELEGRAM.TOPICS.WHALE; 
        message = this._formatWhaleBuy(signal);
        break;
      case 'RAPID_MOMENTUM': 
        threadId = TELEGRAM.TOPICS.MOMENTUM; 
        message = this._formatRapidMomentum(signal);
        break;
      case 'DISTRIBUTION_WARNING': 
        threadId = TELEGRAM.TOPICS.DISTRIBUTION; 
        message = this._formatDistributionWarning(signal);
        break;
      default:
        log.warn(`⚠️ Tipe sinyal tidak dikenal: ${type}`);
        return;
    }

    // Masukkan ke antrian (beserta threadId-nya)
    this._queue.push({ message, threadId });
    this._processQueue();

    // Log ke CSV
    this._logSignalToCSV(signal);
  }

  /**
   * Ambil statistik notifier.
   */
  getStats() {
    return {
      ...this._stats,
      queueLength: this._queue.length,
      activeCooldowns: this._cooldowns.size,
    };
  }

  // -------------------------------------------------------------------------
  // Private: Format Pesan Telegram
  // -------------------------------------------------------------------------

  _formatInstitutionalBuying(s) {
    const buyPct = (s.buyDominance * 100).toFixed(0);
    const sellPct = (100 - s.buyDominance * 100).toFixed(0);
    const chgSign = s.pctChange >= 0 ? '+' : '';
    const chgStr = `${chgSign}${s.pctChange.toFixed(1)}%`;
    const entryStatus =
      Math.abs(s.pctChange) <= 3
        ? '✅ Aman Entry'
        : Math.abs(s.pctChange) <= 5
          ? '⚠️ Hati-hati'
          : '❌ Terlalu Tinggi';

    return (
      `🎯 *INSTITUTIONAL BUYING:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *ORDER FLOW* (1 Menit Terakhir)\n` +
      `🟩 HK (Beli)  : Rp ${this._fmtRp(s.buyValue)} (${buyPct}%)\n` +
      `🟥 HAKI (Jual) : Rp ${this._fmtRp(s.sellValue)} (${sellPct}%)\n` +
      `⚖️ Net Inflow  : +Rp ${this._fmtRp(s.netInflow)}\n` +
      `\n` +
      `🐋 *FOOTPRINT* (Jejak Paus)\n` +
      `• ${s.whaleCount}x Block Trade (> Rp 250 Jt)\n` +
      `• Frekuensi HK: ${s.buyFrequency}x Transaksi\n` +
      `\n` +
      `📈 *PRICE ACTION*\n` +
      `• Harga : Rp ${s.price.toLocaleString('id-ID')}\n` +
      `• Chg   : ${chgStr} (${entryStatus})\n` +
      `\n` +
      `✅ *KESIMPULAN: STRONG ACCUMULATION*`
    );
  }

  _formatWhaleBuy(s) {
    const emoji = s.tier === 'MEGA' ? '🐋🐋' : '🐋';
    const tierLabel = s.tier === 'MEGA' ? 'MEGA WHALE' : 'BIG WHALE';
    const chgSign = s.pctChange >= 0 ? '+' : '';
    const chgStr = `${chgSign}${s.pctChange.toFixed(1)}%`;

    return (
      `${emoji} *${tierLabel} BUY:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔴 Harga  : Rp ${s.price.toLocaleString('id-ID')}\n` +
      `📦 Lot    : ${s.lot.toLocaleString('id-ID')} Lot\n` +
      `💸 Total  : Rp ${this._fmtRp(s.value)}\n` +
      `📈 Chg    : ${chgStr}\n` +
      `⏱ Waktu  : ${this._fmtTime(s.timestamp)}\n` +
      `\n` +
      `_Terdeteksi 1x Hajar Kanan raksasa!_`
    );
  }

  _formatRapidMomentum(s) {
    return (
      `⚡ *RAPID MOMENTUM:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔥 Tape Speed: ${s.frequency}x HK dalam ${s.windowSeconds} Detik!\n` +
      `\n` +
      `📈 *DATA TRANSAKSI*\n` +
      `• Harga Terakhir : Rp ${s.price.toLocaleString('id-ID')}\n` +
      `• Akumulasi HK   : Rp ${this._fmtRp(s.totalValue)}\n` +
      `\n` +
      `⚠️ *KESIMPULAN: HIGH VOLATILITY (Scalping Only)*`
    );
  }

  _formatDistributionWarning(s) {
    const sellPct = (s.sellDominance * 100).toFixed(0);
    const buyPct = (100 - s.sellDominance * 100).toFixed(0);
    const chgSign = s.pctChange >= 0 ? '+' : '';
    const chgStr = `${chgSign}${s.pctChange.toFixed(1)}%`;

    return (
      `🚨 *DISTRIBUTION WARNING:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📉 *ORDER FLOW* (1 Menit Terakhir)\n` +
      `🟥 HAKI (Guyur) : Rp ${this._fmtRp(s.sellValue)} (${sellPct}%)\n` +
      `🟩 HK (Beli)    : Rp ${this._fmtRp(s.buyValue)} (${buyPct}%)\n` +
      `⚖️ Net Outflow   : -Rp ${this._fmtRp(s.netOutflow)}\n` +
      `\n` +
      `📉 *PRICE ACTION*\n` +
      `• Harga : Rp ${s.price.toLocaleString('id-ID')}\n` +
      `• Chg   : ${chgStr} (Tekanan Jual Massive)\n` +
      `\n` +
      `❌ *KESIMPULAN: STRONG DISTRIBUTION (Hindari!)*`
    );
  }

  // -------------------------------------------------------------------------
  // Private: Telegram API
  // -------------------------------------------------------------------------

  async _processQueue() {
    if (this._isSending || this._queue.length === 0) return;
    this._isSending = true;

    while (this._queue.length > 0) {
      const { message, threadId } = this._queue.shift();

      try {
        await this._sendToTelegram(message, threadId);
        this._stats.totalSent++;
        log.info(`📨 Alert terkirim (antrian: ${this._queue.length})`);
      } catch (err) {
        this._stats.totalErrors++;
        log.error(`❌ Gagal kirim alert: ${err.message}`);

        // Jika rate limited oleh Telegram, tunggu lebih lama
        if (err.response?.status === 429) {
          const retryAfter = err.response?.data?.parameters?.retry_after || 5;
          log.warn(`⏳ Telegram rate limit — tunggu ${retryAfter}s`);
          await this._sleep(retryAfter * 1000);
          // Kembalikan pesan ke antrian
          this._queue.unshift({ message, threadId });
        }
      }

      // Rate limit internal: tunggu 2 detik antar pesan
      await this._sleep(TELEGRAM.MIN_SEND_INTERVAL_MS);
    }

    this._isSending = false;
  }

  async _sendToTelegram(text, threadId) {
    const url = `${TELEGRAM.API_BASE}/bot${TELEGRAM.BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: TELEGRAM.CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    };

    // Tambahkan threadId jika tersedia
    if (threadId && !isNaN(threadId)) {
      payload.message_thread_id = parseInt(threadId, 10);
    }

    await axios.post(url, payload, {
      timeout: 10_000,
    });
  }

  // -------------------------------------------------------------------------
  // Private: Log Sinyal ke CSV
  // -------------------------------------------------------------------------

  _ensureLogDir() {
    const dir = path.dirname(LOG.SIGNAL_LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Tulis header CSV jika file belum ada
    if (!fs.existsSync(LOG.SIGNAL_LOG_FILE)) {
      fs.writeFileSync(
        LOG.SIGNAL_LOG_FILE,
        'timestamp,type,symbol,price,value,pctChange,detail\n'
      );
    }
  }

  _logSignalToCSV(signal) {
    try {
      const line =
        `${signal.timestamp.toISOString()},` +
        `${signal.type},` +
        `${signal.symbol},` +
        `${signal.price || 0},` +
        `${signal.value || signal.totalValue || signal.netInflow || 0},` +
        `${signal.pctChange || 0},` +
        `"${signal.message || ''}"\n`;

      fs.appendFileSync(LOG.SIGNAL_LOG_FILE, line);
    } catch {
      // Jangan sampai gagal tulis log membuat seluruh sistem crash
    }
  }

  // -------------------------------------------------------------------------
  // Private: Helpers
  // -------------------------------------------------------------------------

  _fmtRp(value) {
    if (value >= 1_000_000_000_000) return `${(value / 1e12).toFixed(1)} Triliun`;
    if (value >= 1_000_000_000) return `${(value / 1e9).toFixed(1)} Miliar`;
    if (value >= 1_000_000) return `${(value / 1e6).toFixed(0)} Juta`;
    if (value >= 1_000) return `${(value / 1e3).toFixed(0)} Ribu`;
    return `${value}`;
  }

  _fmtTime(date) {
    if (!date) return '-';
    return date.toLocaleTimeString('id-ID', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Jakarta',
    }) + ' WIB';
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = Notifier;
