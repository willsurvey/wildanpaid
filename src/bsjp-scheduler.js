const cron = require('node-cron');
const axios = require('axios');
const { createLogger } = require('./logger');
const { TELEGRAM } = require('./config');

const log = createLogger('BSJP_CRON');

// Helper format angka asing
function formatForeign(val) {
  if (val === undefined || val === null) return '-';
  if (val === 0) return '0';
  const sign = val > 0 ? '+' : '';
  const absVal = Math.abs(val);
  if (absVal >= 1_000_000_000) return `${sign}${(absVal / 1e9).toFixed(1)}B`;
  if (absVal >= 1_000_000) return `${sign}${(absVal / 1e6).toFixed(1)}M`;
  if (absVal >= 1_000) return `${sign}${(absVal / 1e3).toFixed(0)}K`;
  return `${sign}${absVal}`;
}

function formatTiers(tier) {
  if (tier === 'S') return '🥇 TIER S';
  if (tier === 'A') return '🥈 TIER A';
  if (tier === 'B') return '🥉 TIER B';
  return '⭐ TIER C';
}

async function fetchAndSendBSJP() {
  log.info('📡 Fetching combined_screening.json from GitHub...');
  try {
    const url = 'https://raw.githubusercontent.com/willsurvey/apaansihh/refs/heads/main/combined_screening.json';
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;
    
    if (!data || !data.bsjp_beli_sore_jual_pagi) {
      log.error('❌ Data BSJP tidak ditemukan dalam JSON.');
      return;
    }
    
    const candidates = data.bsjp_beli_sore_jual_pagi;
    const updateTimeStr = data.meta?.timestamp || new Date().toISOString();
    const dateObj = new Date(updateTimeStr);
    
    // Format tanggal WIB (UTC+7)
    const optionsDate = { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' };
    const dateStr = dateObj.toLocaleDateString('sv-SE', optionsDate); // sv-SE produces YYYY-MM-DD
    const timeStr = dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB';

    let message = `🟡 *BSJP — BELI SORE JUAL PAGI*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 ${dateStr}  |  🔄 Update: ${dateStr} ${timeStr}\n\n` +
      `⏰ *WINDOW AKTIF: 14:30 – 15:45 WIB*\n` +
      `Beli di sesi penutupan hari ini.\n` +
      `Jual besok pagi pre-opening atau awal sesi.\n\n` +
      `Ditemukan *${candidates.length}* kandidat.\n\n`;

    candidates.forEach((c, index) => {
      const price = c.market_data?.close || '-';
      const changePct = c.market_data?.change_pct !== undefined ? c.market_data.change_pct.toFixed(2) : '-';
      const foreign = formatForeign(c.market_data?.net_foreign);
      
      const tierStr = formatTiers(c.tier);
      const score = c.score || '-';
      
      const entryRange = c.entry_plan?.entry_range || '-';
      const targetPct = c.entry_plan?.target_pct || '-';
      const stopLoss = c.entry_plan?.stop_loss || '-';
      
      const signals = (c.signals_positive || []).map(s => `• ${s}`).join('\n');
      
      message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⭐ *#${index + 1}  ${c.ticker}*  —  ${c.company || '-'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${tierStr}  |  Skor: ${score}/100\n\n` +
        `📈 *DATA HARI INI*\n` +
        `Harga  : ${price} (${changePct}%)\n` +
        `Asing  : ${foreign}\n\n` +
        `🕐 *ENTRY (14:30-15:45 WIB)*\n` +
        `Range : ${entryRange}\n\n` +
        `🎯 *EXIT BESOK PAGI*\n` +
        `Target: ${targetPct}\n` +
        `Stop  : ${stopLoss}\n\n` +
        `✅ *SINYAL POSITIF*\n${signals}\n\n`;
    });

    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⚠️ *DISCLAIMER WAJIB BACA*\n` +
      `Semua sinyal adalah output screening OTOMATIS.\n` +
      `Bukan rekomendasi investasi. DYOR.\n` +
      `Gunakan money management yang baik.`;

    log.info(`📨 Mengirim pesan BSJP ke Telegram (Topic ID: 16)...`);
    
    const tgUrl = `${TELEGRAM.API_BASE}/bot${TELEGRAM.BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: TELEGRAM.CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      message_thread_id: 16 // Sesuai permintaan user: https://t.me/c/3760120608/16
    };
    
    await axios.post(tgUrl, payload);
    log.info('✅ Pesan BSJP berhasil terkirim!');
    
  } catch (err) {
    log.error(`❌ Gagal fetch atau kirim data BSJP: ${err.message}`);
  }
}

function startBSJPScheduler() {
  log.info('🕒 Memulai Scheduler BSJP (Cron: 40 15 * * 1-5)');
  // Setiap Senin-Jumat jam 15:40 WIB
  cron.schedule('40 15 * * 1-5', () => {
    log.info('⏰ Waktu menunjukkan 15:40 WIB. Mengeksekusi fetchAndSendBSJP()');
    fetchAndSendBSJP();
  }, {
    scheduled: true,
    timezone: "Asia/Jakarta"
  });
}

module.exports = { startBSJPScheduler, fetchAndSendBSJP };
