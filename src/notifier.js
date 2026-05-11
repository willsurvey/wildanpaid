// =============================================================================
// NOTIFIER — Telegram Alert Sender (Overhaul v2)
// =============================================================================
// Dua jalur pengiriman:
//   1. sendHighPriority(signal) — HP Queue (max 5), format individual
//   2. sendTable(type, rows)    — Langsung kirim tabel rangkuman (no queue)
//
// Tidak ada queue utama. Tidak ada antrian ribuan pesan.
// Sinyal lama dibuang jika queue HP penuh. Data selalu fresh.
// =============================================================================

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { TELEGRAM, LOG } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('TELEGRAM');

// Judul & thread ID per tipe batch
const TABLE_META = {
  LIVE_MONEY_FLOW: { title: '📈 LIVE MONEY INFLOW+',  topic: TELEGRAM.TOPICS.LIVE_MONEY    },
  LIVE_GAIN:       { title: '🚀 LIVE GAIN',            topic: TELEGRAM.TOPICS.LIVE_GAIN     },
  LIVE_REBOUND:    { title: '⚡ LIVE REBOUND',         topic: TELEGRAM.TOPICS.LIVE_REBOUND  },
  LIVE_MF_MINUS:   { title: '📉 LIVE MONEY OUTFLOW-',  topic: TELEGRAM.TOPICS.LIVE_MF_MINUS },
};

class Notifier {
  constructor() {
    // HP Queue — sinyal penting (WHALE, BSM, INSTITUTIONAL, DISTRIBUTION)
    this._hpQueue    = [];
    this._isSending  = false;

    // Stats
    this._stats = { totalSent: 0, totalErrors: 0, totalDropped: 0 };

    this._ensureLogDir();
  }

  // -------------------------------------------------------------------------
  // Public: High Priority (individual format, HP queue max 5)
  // -------------------------------------------------------------------------

  sendHighPriority(signal) {
    const { message, threadId } = this._formatHP(signal);
    if (!message) return;

    // Jika queue penuh → buang yang paling lama (keep newest)
    if (this._hpQueue.length >= TELEGRAM.MAX_HP_QUEUE) {
      this._hpQueue.shift();
      this._stats.totalDropped++;
      log.warn(`⚠️ HP Queue penuh — pesan lama dibuang (max: ${TELEGRAM.MAX_HP_QUEUE})`);
    }

    this._hpQueue.push({ message, threadId });
    this._processHPQueue();
    this._logSignalToCSV(signal);
  }

  // -------------------------------------------------------------------------
  // Public: Batch Table (dari Aggregator, kirim langsung tanpa queue)
  // -------------------------------------------------------------------------

  async sendTable(type, rows) {
    if (!rows || rows.length === 0) return;
    const { message, threadId } = this._formatTable(type, rows);
    if (!message) return;

    try {
      await this._sendToTelegram(message, threadId);
      this._stats.totalSent++;
      log.info(`📨 Tabel [${type}] terkirim (${rows.length} baris)`);
    } catch (err) {
      this._stats.totalErrors++;
      // Jika rate limit Telegram, tunggu sekali lalu kirim lagi
      if (err.response?.status === 429) {
        const wait = (err.response?.data?.parameters?.retry_after || 5) * 1000;
        log.warn(`⏳ Rate limit — retry tabel [${type}] dalam ${wait / 1000}s`);
        await this._sleep(wait);
        try {
          await this._sendToTelegram(message, threadId);
          this._stats.totalSent++;
        } catch {
          log.error(`❌ Tabel [${type}] gagal setelah retry — dibuang`);
        }
      } else {
        log.error(`❌ Gagal kirim tabel [${type}]: ${err.message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public: Stats
  // -------------------------------------------------------------------------

  getStats() {
    return { ...this._stats, hpQueueLength: this._hpQueue.length };
  }

  // -------------------------------------------------------------------------
  // Private: HP Queue Processor
  // -------------------------------------------------------------------------

  async _processHPQueue() {
    if (this._isSending || this._hpQueue.length === 0) return;
    this._isSending = true;

    while (this._hpQueue.length > 0) {
      const { message, threadId } = this._hpQueue.shift();
      try {
        await this._sendToTelegram(message, threadId);
        this._stats.totalSent++;
        log.info(`📨 HP Alert terkirim (sisa queue: ${this._hpQueue.length})`);
      } catch (err) {
        this._stats.totalErrors++;
        if (err.response?.status === 429) {
          const wait = (err.response?.data?.parameters?.retry_after || 5) * 1000;
          log.warn(`⏳ HP rate limit — tunggu ${wait / 1000}s`);
          await this._sleep(wait);
          // Kembalikan ke depan antrian
          this._hpQueue.unshift({ message, threadId });
        } else {
          log.error(`❌ Gagal kirim HP alert: ${err.message}`);
        }
      }
      await this._sleep(TELEGRAM.MIN_SEND_INTERVAL_MS);
    }

    this._isSending = false;
  }

  // -------------------------------------------------------------------------
  // Private: Format HP Signal (individual)
  // -------------------------------------------------------------------------

  _formatHP(signal) {
    let message = null;
    let threadId = null;

    switch (signal.type) {
      case 'INSTITUTIONAL_BUYING':
        threadId = TELEGRAM.TOPICS.INSTITUTIONAL;
        message  = this._fmtInstitutional(signal);
        break;
      case 'WHALE_BUY':
        threadId = TELEGRAM.TOPICS.WHALE;
        message  = this._fmtWhaleBuy(signal);
        break;
      case 'DISTRIBUTION_WARNING':
        threadId = TELEGRAM.TOPICS.DISTRIBUTION;
        message  = this._fmtDistribution(signal);
        break;
      case 'BIG_SMART_MONEY':
        threadId = TELEGRAM.TOPICS.BIG_SMART_MONEY;
        message  = this._fmtBigSmartMoney(signal);
        break;
      default:
        log.warn(`⚠️ Format HP tidak dikenal: ${signal.type}`);
    }

    return { message, threadId };
  }

  _fmtInstitutional(s) {
    const buyPct  = (s.buyDominance * 100).toFixed(0);
    const sellPct = (100 - s.buyDominance * 100).toFixed(0);
    const chgSign = s.pctChange >= 0 ? '+' : '';
    const entry   = Math.abs(s.pctChange) <= 3 ? '✅ Aman Entry'
                  : Math.abs(s.pctChange) <= 5 ? '⚠️ Hati-hati'
                  : '❌ Terlalu Tinggi';
    return (
      `🎯 *INSTITUTIONAL BUYING:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *ORDER FLOW* (1 Menit Terakhir)\n` +
      `🟩 HK (Beli)  : Rp ${this._fmtRp(s.buyValue)} (${buyPct}%)\n` +
      `🟥 HAKI (Jual): Rp ${this._fmtRp(s.sellValue)} (${sellPct}%)\n` +
      `⚖️ Net Inflow  : +Rp ${this._fmtRp(s.netInflow)}\n\n` +
      `🐋 *FOOTPRINT*\n` +
      `• ${s.whaleCount}x Block Trade (> Rp 250 Jt)\n` +
      `• Frekuensi HK: ${s.buyFrequency}x Transaksi\n\n` +
      `📈 Harga: Rp ${s.price.toLocaleString('id-ID')} (${chgSign}${s.pctChange.toFixed(1)}% — ${entry})\n\n` +
      `✅ *KESIMPULAN: STRONG ACCUMULATION*`
    );
  }

  _fmtWhaleBuy(s) {
    const emoji = s.tier === 'MEGA' ? '🐋🐋' : '🐋';
    const label = s.tier === 'MEGA' ? 'MEGA WHALE' : 'BIG WHALE';
    const chgSign = s.pctChange >= 0 ? '+' : '';
    return (
      `${emoji} *${label} BUY:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔴 Harga : Rp ${s.price.toLocaleString('id-ID')}\n` +
      `📦 Lot   : ${s.lot.toLocaleString('id-ID')} Lot\n` +
      `💸 Total : Rp ${this._fmtRp(s.value)}\n` +
      `📈 Chg   : ${chgSign}${s.pctChange.toFixed(1)}%\n` +
      `⏱ Waktu : ${this._fmtTime(s.timestamp)}\n\n` +
      `_Terdeteksi 1x Hajar Kanan raksasa!_`
    );
  }

  _fmtDistribution(s) {
    const sellPct = (s.sellDominance * 100).toFixed(0);
    const buyPct  = (100 - s.sellDominance * 100).toFixed(0);
    const chgSign = s.pctChange >= 0 ? '+' : '';
    return (
      `🚨 *DISTRIBUTION WARNING:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📉 *ORDER FLOW* (1 Menit Terakhir)\n` +
      `🟥 HAKI (Guyur): Rp ${this._fmtRp(s.sellValue)} (${sellPct}%)\n` +
      `🟩 HK (Beli)   : Rp ${this._fmtRp(s.buyValue)} (${buyPct}%)\n` +
      `⚖️ Net Outflow  : -Rp ${this._fmtRp(s.netOutflow)}\n\n` +
      `📉 Harga: Rp ${s.price.toLocaleString('id-ID')} (${chgSign}${s.pctChange.toFixed(1)}%)\n\n` +
      `❌ *KESIMPULAN: STRONG DISTRIBUTION (Hindari!)*`
    );
  }

  _fmtBigSmartMoney(s) {
    const fmtS = (v) => {
      const a = Math.abs(v), sg = v < 0 ? '-' : v > 0 ? '+' : '';
      if (a >= 1e12) return sg + (a/1e12).toFixed(2) + 'T';
      if (a >= 1e9)  return sg + (a/1e9).toFixed(2) + 'M';
      if (a >= 1e6)  return sg + (a/1e6).toFixed(1) + 'Jt';
      return sg + (a/1e3).toFixed(1) + 'K';
    };
    const cleanMoney  = s.smartMoneyTotal - s.badMoneyTotal;
    const totalMoney  = s.smartMoneyTotal + s.badMoneyTotal;
    const powerRatio  = totalMoney > 0 ? (cleanMoney / totalMoney * 100).toFixed(2) : '0';
    const status      = cleanMoney > 0 ? '🟢 BUYER DOMINANT' : '🔴 SELLER DOMINANT';
    const chgSign     = s.pctChange >= 0 ? '+' : '';
    return (
      `🎯 *BIG SMART MONEY TRIGGER:* #${s.symbol}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${s.triggerCount}🔥 #${s.symbol}\n` +
      `📈 Harga  : Rp ${s.price.toLocaleString('id-ID')} (${chgSign}${s.pctChange.toFixed(2)}%)\n` +
      `📊 Freq   : ${s.freq}x transaksi\n` +
      `💰 Value  : Rp ${this._fmtRp(s.valueWindow)}\n` +
      `⚖️ Avg MF : Rp ${this._fmtRp(s.avgMfWindow)}\n` +
      `📈 MF+    : +Rp ${this._fmtRp(s.netInflowWindow)}\n` +
      `🚦 Volume : ${s.isLiquid ? '🟢' : '🔴'}🔥\n\n` +
      `📊 MARKET ANALYST (09:00 - Now)\n` +
      `👙 Smart Money : ${fmtS(s.smartMoneyTotal)}\n` +
      `🌪 Bad Money   : ${fmtS(s.badMoneyTotal)}\n` +
      `💰 Clean Money : ${fmtS(cleanMoney)}\n` +
      `⚖️ Status      : ${status}\n` +
      `📈 Power Ratio : ${powerRatio}%`
    );
  }

  // -------------------------------------------------------------------------
  // Private: Format Batch Table
  // -------------------------------------------------------------------------

  _formatTable(type, rows) {
    const meta    = TABLE_META[type];
    if (!meta) return { message: null, threadId: null };

    const now     = new Date();
    const dateStr = now.toLocaleDateString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      timeZone: 'Asia/Jakarta'
    }).replace(/\//g, '-');
    const timeStr = now.toLocaleTimeString('id-ID', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Jakarta'
    });

    const header =
      `🗓${dateStr} \\|\\| ⏰${timeStr} WIB\n` +
      `🟢 : Likuid    🔴 : Tidak Likuid\n` +
      `\`====== ${meta.title} ======\`\n` +
      `\`No  Saham  Harga   Chg%   MF(1m)   CM Hari  🚦\`\n`;

    const lines = rows.map((s, i) => {
      const liq   = s.isLiquid ? '🟢' : '🔴';
      const chg   = `${s.pctChange >= 0 ? '+' : ''}${s.pctChange.toFixed(1)}%`;
      const mf    = `${s.netInflow >= 0 ? '+' : ''}${this._fmtShort(s.netInflow)}`;
      const cm    = s.smartMoneyTotal !== undefined
                      ? this._fmtShort(s.smartMoneyTotal - s.badMoneyTotal)
                      : 'N/A';
      const no    = String(i + 1).padStart(2, ' ');
      const sym   = s.symbol.padEnd(5, ' ');
      const price = String(s.price.toLocaleString('id-ID')).padStart(7, ' ');
      const chgP  = chg.padStart(6, ' ');
      const mfP   = mf.padStart(8, ' ');
      const cmP   = cm.padStart(8, ' ');
      return `\`${no}. ${sym}${price} ${chgP} ${mfP} ${cmP} ${liq}\``;
    });

    const message = header + lines.join('\n');
    return { message, threadId: meta.topic };
  }

  // -------------------------------------------------------------------------
  // Private: Telegram API
  // -------------------------------------------------------------------------

  async _sendToTelegram(text, threadId) {
    const url     = `${TELEGRAM.API_BASE}/bot${TELEGRAM.BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id:                 TELEGRAM.CHAT_ID,
      text:                    text,
      parse_mode:              'Markdown',
      disable_web_page_preview: true,
    };
    if (threadId && !isNaN(threadId)) {
      payload.message_thread_id = parseInt(threadId, 10);
    }
    await axios.post(url, payload, { timeout: 10_000 });
  }

  // -------------------------------------------------------------------------
  // Private: Log CSV
  // -------------------------------------------------------------------------

  _ensureLogDir() {
    const dir = path.dirname(LOG.SIGNAL_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(LOG.SIGNAL_LOG_FILE)) {
      fs.writeFileSync(LOG.SIGNAL_LOG_FILE, 'timestamp,type,symbol,price,netInflow,pctChange\n');
    }
  }

  _logSignalToCSV(signal) {
    try {
      const line =
        `${new Date().toISOString()},` +
        `${signal.type},${signal.symbol},` +
        `${signal.price || 0},${signal.netInflow || signal.value || 0},` +
        `${signal.pctChange || 0}\n`;
      fs.appendFileSync(LOG.SIGNAL_LOG_FILE, line);
    } catch { /* jangan crash karena gagal tulis log */ }
  }

  // -------------------------------------------------------------------------
  // Private: Helpers
  // -------------------------------------------------------------------------

  _fmtRp(v) {
    if (v >= 1e12) return `${(v/1e12).toFixed(1)} Triliun`;
    if (v >= 1e9)  return `${(v/1e9).toFixed(1)} Miliar`;
    if (v >= 1e6)  return `${(v/1e6).toFixed(0)} Juta`;
    if (v >= 1e3)  return `${(v/1e3).toFixed(0)} Ribu`;
    return `${v}`;
  }

  _fmtShort(v) {
    const a = Math.abs(v), sg = v < 0 ? '-' : v > 0 ? '+' : '';
    if (a >= 1e12) return sg + (a/1e12).toFixed(1) + 'T';
    if (a >= 1e9)  return sg + (a/1e9).toFixed(1)  + 'M';
    if (a >= 1e6)  return sg + (a/1e6).toFixed(0)  + 'Jt';
    return sg + (a/1e3).toFixed(0) + 'K';
  }

  _fmtTime(date) {
    if (!date) return '-';
    return date.toLocaleTimeString('id-ID', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Jakarta',
    }) + ' WIB';
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = Notifier;
