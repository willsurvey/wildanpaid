// =============================================================================
// TEST SCRIPT — Validasi Koneksi WebSocket Stockbit
// =============================================================================
// Menguji apakah JWT Token yang didapatkan bisa dipakai untuk membuka
// jalur WebSocket, melakukan handshake, dan bertahan (tidak di-kick).
// Catatan: Karena ini di luar jam bursa, mungkin tidak ada data trade,
// tapi jika status "Connected" bertahan, berarti autentikasi tembus.
// =============================================================================

require('dotenv').config();
const Streamer = require('./src/streamer');
const { createLogger } = require('./src/logger');

const log = createLogger('TEST-WS');

async function runTest() {
  log.info('🚀 Memulai Uji Coba Koneksi WebSocket...');

  const streamer = new Streamer();

  // Matikan auto-reconnect untuk test
  const { CONNECTION } = require('./src/config');
  CONNECTION.MAX_RECONNECT_ATTEMPTS = 0;

  let isConnected = false;

  streamer.on('connected', () => {
    isConnected = true;
    log.info('✅ HANDSHAKE BERHASIL! Jalur WebSocket Terbuka.');
    log.info('⏳ Menunggu selama 10 detik untuk memastikan kita tidak di-kick oleh server...');
  });

  streamer.on('trade', (trade) => {
    log.info(`📩 Data masuk: [${trade.symbol}] Rp ${trade.price} (${trade.lot} Lot)`);
  });

  streamer.on('disconnected', (code) => {
    log.warn(`🔴 Terputus dari server (Code: ${code})`);
    if (!isConnected) {
      log.error('❌ GAGAL: Koneksi ditolak oleh server (kemungkinan Token ditolak).');
      process.exit(1);
    }
  });

  streamer.on('fatal', (err) => {
    log.error(`❌ FATAL: ${err.message}`);
    process.exit(1);
  });

  await streamer.start();

  // Tunggu 10 detik. Jika masih connected, berarti lulus.
  setTimeout(() => {
    if (streamer.isConnected) {
      const stats = streamer.getStats();
      log.info(`✅ UJI COBA SUKSES! Koneksi stabil selama 10 detik.`);
      log.info(`📊 Statistik WS: Total Pesan Diterima: ${stats.totalMessages}`);
      if (stats.totalMessages === 0) {
        log.info('💡 Tidak ada data trade karena bursa sedang TUTUP.');
      }
      streamer.stop();
      process.exit(0);
    } else {
      log.error('❌ GAGAL: Koneksi terputus sebelum 10 detik.');
      process.exit(1);
    }
  }, 10_000);
}

runTest();
