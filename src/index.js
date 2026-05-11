// =============================================================================
// INDEX.JS — Titik Masuk Utama: Menyambungkan Seluruh Modul
// =============================================================================
// Alur:
//   1. Validasi konfigurasi (.env)
//   2. Inisialisasi Streamer (WebSocket)
//   3. Inisialisasi Analytics Engine (Otak)
//   4. Inisialisasi Notifier (Telegram)
//   5. Sambungkan event pipeline: Streamer → Analytics → Notifier
//   6. Mulai koneksi
//   7. Tangani shutdown graceful (Ctrl+C, Docker stop)
// =============================================================================

const Streamer        = require('./streamer');
const AnalyticsEngine = require('./analytics');
const Notifier        = require('./notifier');
const Aggregator      = require('./aggregator');
const { createLogger } = require('./logger');
const { startBSJPScheduler } = require('./bsjp-scheduler');
const cron = require('node-cron');

const log = createLogger('MAIN');

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
function printBanner() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        🎯 RADAR BURSA v1.0                  ║');
  console.log('  ║   Real-Time Smart Money Detection System    ║');
  console.log('  ║   Stockbit WebSocket → Telegram Alert       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  printBanner();

  // 1. Inisialisasi modul
  const streamer   = new Streamer();
  const analytics  = new AnalyticsEngine();
  const notifier   = new Notifier();
  const aggregator = new Aggregator(notifier); // Aggregator butuh notifier

  // 2. Sambungkan pipeline event
  //    Streamer --[trade]--> Analytics --[signal]--> Aggregator ---> Notifier
  //    HP signals (WHALE/BSM/INSTITUTIONAL): langsung ke Notifier
  //    LIVE signals (MF+/GAIN/REBOUND/MF-): batch tabel 500ms debounce
  streamer.on('trade', (trade) => {
    analytics.processTrade(trade);
  });

  analytics.on('signal', (signal) => {
    // Log ringkas (hanya symbol & type, bukan full message agar log tidak banjir)
    log.debug(`🚨 [${signal.type}] #${signal.symbol}`);
    aggregator.route(signal);
  });

  // 3. Event handlers untuk monitoring
  streamer.on('connected', () => {
    log.info('🟢 Sistem aktif — memantau seluruh bursa...');
  });

  streamer.on('disconnected', (code) => {
    log.warn(`🔴 Koneksi terputus (code: ${code}). Auto-reconnect aktif.`);
  });

  streamer.on('fatal', (err) => {
    log.error(`💀 FATAL: ${err.message}`);
    log.error('   Sistem akan berhenti. Periksa koneksi internet & credentials.');
    shutdown(streamer, analytics, 1);
  });

  // 4. Laporan status periodik (setiap 5 menit)
  const statusInterval = setInterval(() => {
    const wsStats = streamer.getStats();
    const anStats = analytics.getStats();
    const tgStats = notifier.getStats();

    log.info(
      `📊 Status: ` +
      `WS[${wsStats.connected ? '🟢' : '🔴'} uptime:${wsStats.uptimeMinutes}m ` +
      `msg:${wsStats.totalMessages} trades:${wsStats.totalTrades}] ` +
      `Analytics[processed:${anStats.totalProcessed} signals:${anStats.signalsEmitted} ` +
      `symbols:${anStats.activeSymbols}] ` +
      `TG[sent:${tgStats.totalSent} blocked:${tgStats.totalBlocked} err:${tgStats.totalErrors}]`
    );
  }, 5 * 60 * 1000);

  // 5. Graceful shutdown
  const handleShutdown = (signal) => {
    log.info(`\n🛑 Menerima sinyal ${signal}. Mematikan sistem...`);
    clearInterval(statusInterval);
    shutdown(streamer, analytics, 0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => handleShutdown('SIGTERM')); // Docker stop

  // Tangkap error yang tidak tertangani agar tidak silent crash
  process.on('uncaughtException', (err) => {
    log.error(`💥 Uncaught Exception: ${err.message}`);
    log.error(err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`💥 Unhandled Rejection: ${reason}`);
  });

  // 6. MULAI!
  startBSJPScheduler();

  // 7. Reset harian otomatis setiap hari Senin-Jumat jam 09:00 WIB
  // Ini memastikan _dailyStats, _sessionLows, dan semua riwayat sinyal
  // selalu fresh di awal sesi — data "09:00 - Now" menjadi akurat.
  cron.schedule('0 9 * * 1-5', () => {
    log.info('🌅 Reset harian dipicu (09:00 WIB). Membersihkan state analytics...');
    analytics.resetDailyState();
  }, { scheduled: true, timezone: 'Asia/Jakarta' });
  log.info('📅 Daily reset scheduler aktif (Senin-Jumat 09:00 WIB)');

  analytics.start();
  await streamer.start();

  log.info('⏳ Menunggu data dari bursa...');
}

function shutdown(streamer, analytics, exitCode) {
  try {
    streamer.stop();
    analytics.stop();
  } catch {
    // Abaikan error saat shutdown
  }
  log.info('👋 Radar Bursa dimatikan. Sampai jumpa!');
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch((err) => {
  log.error(`💀 Gagal memulai sistem: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
